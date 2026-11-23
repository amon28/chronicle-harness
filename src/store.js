// Tiny IndexedDB wrapper for conversations + localStorage for settings.
import { Capacitor, registerPlugin } from '@capacitor/core';
const DB_NAME = 'chronicle';
const STORE = 'conversations';
const WS_STORE = 'workspaces';
const KV_STORE = 'kv'; // settings (personas, cards, lorebooks, memories…) – far more room than localStorage // per-chat sandbox files: { id: convId, files: { [path]: { data: Uint8Array, mtime } } }

let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 3);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(WS_STORE)) d.createObjectStore(WS_STORE, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(KV_STORE)) d.createObjectStore(KV_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).then((d) => fromOldName(d).then(() => d));
  }
  return dbPromise;
}

/**
 * The database was called "opencode-mobile" before the app was renamed (decision 217). An install that has it (the
 * app updated in place) gets everything copied into "chronicle" once, record by record, before anything reads it;
 * the old one is left as it was (nothing is lost if this is cut short – it runs again until it has finished).
 */
export const OLD_DB_NAME = 'opencode-mobile';
const MIGRATED = '__copiedFromOldName';
const req2p = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));
async function fromOldName(d) {
  try {
    if (!indexedDB.databases) return;
    if (!(await indexedDB.databases()).some((x) => x.name === OLD_DB_NAME)) return;
    if (await req2p(d.transaction(KV_STORE).objectStore(KV_STORE).get(MIGRATED))) return;
    const old = await req2p(indexedDB.open(OLD_DB_NAME));
    try {
      for (const name of [STORE, WS_STORE, KV_STORE]) {
        if (!old.objectStoreNames.contains(name)) continue;
        const keys = await req2p(old.transaction(name).objectStore(name).getAllKeys());
        for (const k of keys) {
          const v = await req2p(old.transaction(name).objectStore(name).get(k));
          if (v === undefined) continue;
          await new Promise((res, rej) => {
            const t = d.transaction(name, 'readwrite');
            if (name === KV_STORE) t.objectStore(name).put(v, k);
            else t.objectStore(name).put(v);
            t.oncomplete = res;
            t.onerror = () => rej(t.error);
          });
        }
      }
    } finally {
      old.close();
    }
    await new Promise((res, rej) => {
      const t = d.transaction(KV_STORE, 'readwrite');
      t.objectStore(KV_STORE).put(Date.now(), MIGRATED);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  } catch (e) {
    console.warn('Copying the data from the old database failed:', e?.message || e);
  }
}

function tx(mode, fn, store = STORE) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
      }),
  );
}

// IndexedDB copies what it stores by itself, so a JSON copy first only doubles the work for a long chat; it is the
// fallback for the rare value IndexedDB can't copy (a function, a DOM node), which JSON quietly drops (decision 239)
const putPlain = (put, v) => put(v).catch((e) => (e?.name === 'DataCloneError' ? put(JSON.parse(JSON.stringify(v))) : Promise.reject(e)));

export const conversations = {
  all: () => tx('readonly', (s) => s.getAll()).then((l) => (l || []).sort((a, b) => b.updatedAt - a.updatedAt)),
  put: (c) => putPlain((v) => tx('readwrite', (s) => s.put(v)), c),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
};

export const workspaces = {
  all: () => tx('readonly', (s) => s.getAll(), WS_STORE).then((l) => l || []),
  ids: () => tx('readonly', (s) => s.getAllKeys(), WS_STORE).then((l) => l || []),
  get: (id) => tx('readonly', (s) => s.get(id), WS_STORE),
  put: (w) => tx('readwrite', (s) => s.put(w), WS_STORE),
  remove: (id) => tx('readwrite', (s) => s.delete(id), WS_STORE),
  clear: () => tx('readwrite', (s) => s.clear(), WS_STORE),
};

const SETTINGS_KEY = 'ocm.settings';
const defaults = { apiKey: '', proxyUrl: '', workspaceId: '', systemPrompt: '', model: '', effort: {} };
let settingsCache = null;
let onSaveError = null;
export const setSaveErrorHandler = (fn) => (onSaveError = fn);

const kvGet = (key) => db().then((d) => new Promise((res, rej) => {
  const r = d.transaction(KV_STORE).objectStore(KV_STORE).get(key);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
const kvPut = (key, value) => db().then((d) => new Promise((res, rej) => {
  const t = d.transaction(KV_STORE, 'readwrite');
  t.objectStore(KV_STORE).put(value, key);
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error || new Error('Write aborted'));
}));

// ---------- secrets (Android Keystore) ----------
// API keys and tokens are kept out of IndexedDB on Android: they're encrypted with a key in the
// Android Keystore by the native SecureStore plugin. The web build keeps them with the settings.
const SecureStore = Capacitor.isNativePlatform() ? registerPlugin('SecureStore') : null;
const TOP_SECRETS = ['apiKey', 'exaKey', 'ghToken', 'microlinkKey', 'githubToken', 'githubRefresh', 'githubSshKey'];
let secretsJson = null; // last written blob, to skip needless writes
let secureOk = !!SecureStore;
let onSecretsLost = null;
export const setSecretsLostHandler = (fn) => (onSecretsLost = fn);
export const secureStorageActive = () => secureOk;

/** Split settings into { secrets, clean } – clean has every key/token blanked. */
function splitSecrets(s) {
  const secrets = { providers: {}, providerAdmin: {}, mcp: {}, pc: {} };
  const clean = { ...s };
  for (const k of TOP_SECRETS) {
    if (s[k]) secrets[k] = s[k];
    clean[k] = '';
  }
  clean.providers = (s.providers || []).map((p) => {
    if (p.apiKey) secrets.providers[p.id] = p.apiKey;
    if (p.adminKey) secrets.providerAdmin[p.id] = p.adminKey; // Anthropic Admin key, for spend (decision 208)
    return { ...p, apiKey: '', adminKey: '' };
  });
  clean.mcpServers = (s.mcpServers || []).map((m) => {
    if (m.token) secrets.mcp[m.id] = m.token;
    return { ...m, token: '' };
  });
  // Files on my PC (decision 223): the secret pc-files.py printed
  clean.pcFiles = (s.pcFiles || []).map((p) => {
    if (p.secret) secrets.pc[p.id] = p.secret;
    return { ...p, secret: '' };
  });
  return { secrets, clean };
}
function mergeSecrets(s, sec) {
  if (!sec) return s;
  for (const k of TOP_SECRETS) if (sec[k] && !s[k]) s[k] = sec[k];
  for (const p of s.providers || []) {
    if (!p.apiKey && sec.providers?.[p.id]) p.apiKey = sec.providers[p.id];
    if (!p.adminKey && sec.providerAdmin?.[p.id]) p.adminKey = sec.providerAdmin[p.id];
  }
  for (const m of s.mcpServers || []) if (!m.token && sec.mcp?.[m.id]) m.token = sec.mcp[m.id];
  for (const p of s.pcFiles || []) if (!p.secret && sec.pc?.[p.id]) p.secret = sec.pc[p.id];
  return s;
}
async function readSecrets() {
  if (!secureOk) return null;
  try {
    const r = await SecureStore.get({ name: 'secrets' });
    secretsJson = r?.value ?? null;
    return r?.value ? JSON.parse(r.value) : null;
  } catch (e) {
    if (/DECRYPT/i.test(e?.code || e?.message || '')) setTimeout(() => onSecretsLost?.(e), 0);
    else secureOk = false; // plugin missing (old native build) → keep keys with the settings
    return null;
  }
}

/**
 * Load settings into memory before the app starts. Settings used to live in localStorage (~5 MB, and
 * writes failed silently when full); they're moved to IndexedDB once.
 */
export async function initSettings() {
  let s = null;
  try {
    s = await kvGet('settings');
  } catch {
    /* IndexedDB unavailable → fall back below */
  }
  if (!s) {
    try {
      s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    } catch {
      s = null;
    }
    if (s) {
      try {
        await kvPut('settings', s);
        localStorage.removeItem(SETTINGS_KEY); // free the space; IndexedDB is the source of truth now
        localStorage.setItem('ocm.settingsInIdb', '1');
      } catch {
        /* keep using localStorage copy */
      }
    }
  }
  settingsCache = { ...defaults, ...(s || {}) };
  const sec = await readSecrets();
  mergeSecrets(settingsCache, sec);
  // first run with secure storage: move any plain-text keys out of IndexedDB
  if (secureOk && s && (TOP_SECRETS.some((k) => s[k]) || (s.providers || []).some((p) => p.apiKey || p.adminKey) || (s.mcpServers || []).some((m) => m.token) || (s.pcFiles || []).some((p) => p.secret))) {
    saveSettings(settingsCache);
  }
  try {
    navigator.storage?.persist?.(); // ask the browser not to evict our data
  } catch {
    /* ignore */
  }
  return settingsCache;
}

export function loadSettings() {
  if (settingsCache) return settingsCache;
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

// Writes are serialized; a burst of saves only writes the latest state.
let saving = null;
let pendingSave = null;
export function saveSettings(s) {
  settingsCache = s;
  pendingSave = s;
  if (saving) return saving;
  saving = (async () => {
    while (pendingSave) {
      const snap = pendingSave;
      pendingSave = null;
      try {
        let toStore = snap;
        if (secureOk) {
          const { secrets, clean } = splitSecrets(snap);
          const json = JSON.stringify(secrets);
          try {
            if (json !== secretsJson) {
              await SecureStore.set({ name: 'secrets', value: json });
              secretsJson = json;
            }
            toStore = clean;
          } catch {
            secureOk = false; // couldn't encrypt → keep the keys with the settings rather than lose them
          }
        }
        await putPlain((v) => kvPut('settings', v), toStore);
      } catch (e) {
        onSaveError?.(e);
      }
    }
    saving = null;
  })();
  return saving;
}

export function cache(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem('ocm.cache.' + key) || 'null');
    localStorage.setItem('ocm.cache.' + key, JSON.stringify(value));
  } catch {
    return null;
  }
}

// Full-size character art, kept apart from settings so saving settings stays fast.
const artMem = new Map();
/** Art ids and one picture at a time, without the in-memory cache (for backups of a lot of data). */
const artKeys = () => db().then((d) => new Promise((res, rej) => {
  const r = d.transaction(KV_STORE).objectStore(KV_STORE).getAllKeys();
  r.onsuccess = () => res((r.result || []).map(String).filter((k) => k.startsWith('art:')).map((k) => k.slice(4)));
  r.onerror = () => rej(r.error);
}));
/** A chat's git repository data (git.js), kept beside its workspace. */
/** A chat's git history and search index by raw key ("git:<id>", "vec:<id>"), for "Export everything" (decision 218). */
export const kvMove = {
  keys: () => db().then((d) => new Promise((res, rej) => {
    const r = d.transaction(KV_STORE).objectStore(KV_STORE).getAllKeys();
    r.onsuccess = () => res((r.result || []).map(String).filter((k) => /^(git|vec):/.test(k)));
    r.onerror = () => rej(r.error);
  })),
  get: (k) => kvGet(k),
  put: (k, v) => (/^(git|vec):/.test(k) ? kvPut(k, v) : Promise.reject(new Error('not a movable key'))),
};
export const gitData = {
  get: (id) => kvGet('git:' + id).then((v) => v || null).catch(() => null),
  put: (id, v) => kvPut('git:' + id, v),
  remove: (id) => kvDel('git:' + id),
};
/** Message vectors per chat (search by meaning, roleplay recall). */
export const vectors = {
  get: (id) => kvGet('vec:' + id).then((v) => v || null).catch(() => null),
  put: (id, v) => kvPut('vec:' + id, v),
  remove: (id) => kvDel('vec:' + id),
};
export const art = {
  keys: artKeys,
  read: (id) => kvGet('art:' + id).then((v) => v || null),
  get: async (id) => {
    if (!id) return null;
    if (artMem.has(id)) return artMem.get(id);
    let v = null;
    try {
      v = (await kvGet('art:' + id)) || null;
    } catch {
      /* ignore */
    }
    artMem.set(id, v);
    return v;
  },
  put: async (id, dataUrl) => {
    artMem.set(id, dataUrl || null);
    if (dataUrl) await kvPut('art:' + id, dataUrl);
    else await kvDel('art:' + id);
  },
  remove: (id) => art.put(id, null),
  all: () => db().then((d) => new Promise((res, rej) => {
    const out = {};
    const r = d.transaction(KV_STORE).objectStore(KV_STORE).openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return res(out);
      if (String(c.key).startsWith('art:')) out[String(c.key).slice(4)] = c.value;
      c.continue();
    };
    r.onerror = () => rej(r.error);
  })),
};
const kvDel = (key) => db().then((d) => new Promise((res, rej) => {
  const t = d.transaction(KV_STORE, 'readwrite');
  t.objectStore(KV_STORE).delete(key);
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
}));
