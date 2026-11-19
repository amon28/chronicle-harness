/**
 * Map tiles for the ```map block, fetched and kept the way the OpenStreetMap tile policy asks:
 *  - only the tiles of the view someone is looking at (nothing is fetched ahead), two requests at a time;
 *  - the app names itself in the User-Agent (native HTTP – a WebView image request could not);
 *  - every tile is kept for at least 7 days (longer when the server says so) and asked for again with its ETag;
 *  - a cap per hour, after which the map shows what it has and a plain grid for the rest.
 * Kept tiles are also what the map shows without a network.
 */
import { bytesRequest } from './api.js';
import { hourlyCap, osmHeaders, tileUrl } from './osm.js';

export const WEEK = 7 * 86400000;
export const TILE_CAP_PER_HOUR = 300;
const MAX_TILES = 2000; // about 40 MB
const DB = 'ocm-map-tiles';

/** When a tile fetched now is due for a fresh look: the server's max-age, but never sooner than 7 days. */
export function tileExpiry(headers, now) {
  const cc = String(headers?.['cache-control'] ?? headers?.['Cache-Control'] ?? '');
  const m = /max-age\s*=\s*(\d+)/i.exec(cc);
  const age = m ? Math.min(Number(m[1]) * 1000, 365 * 86400000) : 0;
  return now + Math.max(WEEK, age);
}

const hashOf = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};
export const tileKey = (template, z, x, y) => `${hashOf(template)}/${z}/${x}/${y}`;

const isImage = (b) => b?.byteLength > 24 && ((b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57));

/** The kept tiles, in memory (tests, and browsers without IndexedDB). */
export function memoryTileStore() {
  const m = new Map();
  return {
    get: async (k) => m.get(k) || null,
    put: async (rec) => void m.set(rec.k, rec),
    count: async () => m.size,
    dropOldest: async (n) => {
      for (const r of [...m.values()].sort((a, b) => a.at - b.at).slice(0, n)) m.delete(r.k);
    },
    clear: async () => m.clear(),
    _map: m,
  };
}

/** The kept tiles in their own small IndexedDB (not the app's main one: losing it loses nothing). */
export function idbTileStore() {
  if (!globalThis.indexedDB) return memoryTileStore();
  let dbP = null;
  const open = () =>
    (dbP ||= new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('tiles', { keyPath: 'k' }).createIndex('at', 'at');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
      rq.onblocked = () => rej(new Error('blocked'));
    }).catch((e) => {
      dbP = null;
      throw e;
    }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('tiles', mode);
      let out;
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error || new Error('tile store failed'));
      fn(t.objectStore('tiles'), (v) => (out = v));
    });
  };
  return {
    get: (k) => tx('readonly', (s, set) => (s.get(k).onsuccess = (e) => set(e.target.result || null))),
    put: (rec) => tx('readwrite', (s) => void s.put(rec)),
    count: () => tx('readonly', (s, set) => (s.count().onsuccess = (e) => set(e.target.result))),
    dropOldest: (n) =>
      tx('readwrite', (s) => {
        let left = n;
        s.index('at').openKeyCursor().onsuccess = (e) => {
          const c = e.target.result;
          if (!c || left-- <= 0) return;
          s.delete(c.primaryKey);
          c.continue();
        };
      }),
    clear: () => tx('readwrite', (s) => void s.clear()),
  };
}

const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

/** How a tile is asked for: the test stand-in globalThis.__ocmTiles(z, x, y) → bytes, else HTTP with the app's User-Agent. */
async function defaultFetch(template, z, x, y, etag) {
  if (globalThis.__ocmTiles) return { status: 200, headers: {}, body: await globalThis.__ocmTiles(z, x, y) };
  const headers = await osmHeaders(etag ? { 'If-None-Match': etag } : {});
  return timeout(bytesRequest({ url: tileUrl(template, z, x, y), headers }), 20000);
}

/**
 * load(z, x, y) → { bytes, from: 'cache' | 'net' | 'stale' } or null (no tile: draw the grid).
 * opts: template, store, fetchTile(template, z, x, y, etag) → { status, headers, body }, now(), online(), cap
 */
export function createTileLoader(opts = {}) {
  const template = opts.template;
  const store = opts.store || memoryTileStore();
  const fetchTile = opts.fetchTile || defaultFetch;
  const now = opts.now || (() => Date.now());
  const online = opts.online || (() => globalThis.navigator?.onLine !== false);
  const cap = opts.cap || hourlyCap('tiles', TILE_CAP_PER_HOUR, { now });
  const flying = new Map();
  const waiting = [];
  let running = 0;
  let puts = 0;
  const state = { paused: false, failed: 0, fetched: 0 };
  const bad = new Map(); // a tile that just failed is not asked for again for a minute (a drag redraws many times)

  const slot = () => (running < 2 ? (running++, Promise.resolve()) : new Promise((res) => waiting.push(res)));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  const safe = (p) => p.catch(() => null);

  async function one(z, x, y) {
    const k = tileKey(template, z, x, y);
    const rec = await safe(store.get(k));
    const t = now();
    if (rec?.bytes && rec.exp > t) return { bytes: rec.bytes, from: 'cache' };
    const stale = rec?.bytes ? { bytes: rec.bytes, from: 'stale' } : null;
    if (!online()) return stale;
    if (bad.has(k) && t - bad.get(k) < 60000) return stale;
    if (!cap.take()) {
      state.paused = true;
      return stale;
    }
    await slot();
    try {
      const r = await fetchTile(template, z, x, y, rec?.etag || '');
      const headers = Object.fromEntries(Object.entries(r?.headers || {}).map(([a, b]) => [a.toLowerCase(), b]));
      if (r?.status === 304 && rec?.bytes) {
        await safe(store.put({ ...rec, exp: tileExpiry(headers, now()), at: now() }));
        return { bytes: rec.bytes, from: 'cache' };
      }
      const body = r?.body instanceof Uint8Array ? r.body : r?.body ? new Uint8Array(r.body) : null;
      if (r?.status !== 200 || !isImage(body)) {
        bad.set(k, now());
        state.failed++;
        return stale;
      }
      state.fetched++;
      await safe(store.put({ k, bytes: body, etag: String(headers.etag || ''), exp: tileExpiry(headers, now()), at: now() }));
      if (++puts % 50 === 0) safe(store.count().then((n) => (n > MAX_TILES ? store.dropOldest(n - MAX_TILES + 200) : null)));
      return { bytes: body, from: 'net' };
    } catch {
      bad.set(k, now());
      state.failed++;
      return stale;
    } finally {
      release();
    }
  }

  return {
    state,
    template,
    load(z, x, y) {
      const k = `${z}/${x}/${y}`;
      if (!flying.has(k)) flying.set(k, one(z, x, y).catch(() => null).finally(() => flying.delete(k)));
      return flying.get(k);
    },
  };
}
