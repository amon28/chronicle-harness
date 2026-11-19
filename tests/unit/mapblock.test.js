import { describe, it, expect } from 'vitest';
import { compass, expandMapBlocks, fitView, fmtDist, haversine, lonLatToPx, mapBlockSource, openNow, openText, panned, parseMapDoc, project, pxToLonLat, tileOf, tilesFor } from '../../src/mapblock.js';
import { createTileLoader, memoryTileStore, tileExpiry, tileKey, WEEK } from '../../src/maptiles.js';
import { cleanOsmUrl, hourlyCap, osmConfig, OSM_DEFAULTS, tileUrl } from '../../src/osm.js';

const place = (o = {}) => ({ name: 'Apotheke am Markt', lat: 52.5211, lon: 13.4102, ...o });

describe('```map block: what it may hold', () => {
  it('is a workspace path or JSON, nothing else', () => {
    expect(mapBlockSource('maps/pharmacy-1.json')).toEqual({ path: 'maps/pharmacy-1.json' });
    expect(mapBlockSource(' /workspace/maps/a b.json \n')).toEqual({ path: 'maps/a b.json' });
    expect(mapBlockSource('{"places":[]}').json).toBe('{"places":[]}');
    expect(mapBlockSource('').error).toBeTruthy();
    expect(mapBlockSource('../secrets.json').error).toBeTruthy();
    expect(mapBlockSource('maps/../../x.json').error).toBeTruthy();
    expect(mapBlockSource('maps/a.json\nmaps/b.json').error).toBeTruthy();
    expect(mapBlockSource('https://evil.example/x.json').error).toBeTruthy();
    expect(mapBlockSource('show a map of Berlin').error).toBeTruthy();
  });

  it('checks the data strictly and keeps only known fields', () => {
    const r = parseMapDoc({ title: ' Pharmacies ', me: [52.52, 13.405], zoom: 99, places: [place({ dist: 310.4, phone: '+49 30 1234567', url: 'https://a.example/x', hours: 'Mo-Fr 08:00-18:30', evil: '<img>', open: true })], source: 'x', extra: 1, clock: false });
    expect(r.ok).toBe(true);
    expect(r.doc).toEqual({ v: 1, title: 'Pharmacies', me: [52.52, 13.405], zoom: 19, clock: false, source: 'x', places: [{ name: 'Apotheke am Markt', lat: 52.5211, lon: 13.4102, dist: 310, phone: '+49 30 1234567', url: 'https://a.example/x', hours: 'Mo-Fr 08:00-18:30', open: true }] });
    // a link that is not http(s) and a phone that is not a number are dropped, not kept
    const d = parseMapDoc({ places: [place({ url: 'javascript:alert(1)', phone: 'call me <b>', name: 'x'.repeat(200) })] }).doc;
    expect(d.places[0].url).toBeUndefined();
    expect(d.places[0].phone).toBeUndefined();
    expect(d.places[0].name).toHaveLength(80);
  });

  it('refuses what cannot be drawn, with a reason', () => {
    const bad = (x) => parseMapDoc(x);
    expect(bad('{nope').error).toMatch(/not valid JSON/);
    expect(bad('[]').error).toMatch(/not a JSON object/);
    expect(bad('null').ok).toBe(false);
    expect(bad({}).error).toMatch(/no places/);
    expect(bad({ places: [] }).error).toMatch(/no places/);
    expect(bad({ places: [{ lat: 1, lon: 2 }] }).error).toMatch(/place 1 has no name/);
    expect(bad({ places: [place(), place({ lat: 'x' })] }).error).toMatch(/place 2 .*lat \/ lon/);
    expect(bad({ places: [place({ lat: 91 })] }).ok).toBe(false);
    expect(bad({ places: [place({ lon: NaN })] }).ok).toBe(false);
    expect(bad({ places: [place({ lon: Infinity })] }).ok).toBe(false);
    expect(bad({ places: [place()], me: [1] }).error).toMatch(/"me"/);
    expect(bad({ places: [place()], center: [100, 0] }).error).toMatch(/"center"/);
    expect(bad({ places: [place()], line: [[1, 2], 'x'] }).error).toMatch(/"line"/);
    expect(bad({ places: [place()], zoom: 'big' }).error).toMatch(/"zoom"/);
    expect(bad('x'.repeat(200001)).error).toMatch(/too long/);
  });

  it('clamps counts', () => {
    const many = parseMapDoc({ places: Array.from({ length: 45 }, (_, i) => place({ name: 'P' + i })) });
    expect(many.doc.places).toHaveLength(30);
    expect(many.doc.cut).toBe(15);
    expect(parseMapDoc({ places: [place()], line: Array.from({ length: 700 }, (_, i) => [10 + i / 1000, 10]) }).doc.line).toHaveLength(500);
  });

  it('becomes a plain list in an export', () => {
    const doc = JSON.stringify({ title: 'Cafes', places: [place({ name: 'Cafe A', dist: 120, addr: 'Main St 1' })], source: '© OpenStreetMap contributors' });
    const out = expandMapBlocks('Here:\n```map\nmaps/c.json\n```\nBye', (p) => (p === 'maps/c.json' ? doc : null));
    expect(out).toBe('Here:\n**Cafes**\n1. Cafe A – 120 m – Main St 1 (52.52110, 13.41020)\n© OpenStreetMap contributors\nBye');
    // a block that cannot be read stays as it was
    const keep = 'a\n```map\nmaps/gone.json\n```';
    expect(expandMapBlocks(keep, () => null)).toBe(keep);
    expect(expandMapBlocks('```js\nmap\n```', () => doc)).toBe('```js\nmap\n```');
  });
});

describe('map maths', () => {
  it('finds the tile of a point (z15 Berlin)', () => {
    expect(tileOf(13.405, 52.52, 15)).toEqual({ z: 15, x: 17604, y: 10746 });
    expect(tileOf(0, 0, 0)).toEqual({ z: 0, x: 0, y: 0 });
    expect(tileOf(-180, 85.06, 3)).toEqual({ z: 3, x: 0, y: 0 });
    expect(tileOf(180, -89, 3)).toEqual({ z: 3, x: 7, y: 7 }); // clamped to the map
  });
  it('goes from position to pixel and back', () => {
    const p = lonLatToPx(13.405, 52.52, 12);
    const b = pxToLonLat(p.x, p.y, 12);
    expect(b.lon).toBeCloseTo(13.405, 6);
    expect(b.lat).toBeCloseTo(52.52, 6);
    expect(lonLatToPx(0, 0, 0)).toEqual({ x: 128, y: 128 });
  });
  it('fits the zoom to the pins', () => {
    expect(fitView([[52.52, 13.405]], 360, 220).zoom).toBe(16); // one point
    expect(fitView([[52.52, 13.405], [52.52, 13.405]], 360, 220).zoom).toBe(16); // the same point twice
    const near = fitView([[52.52, 13.4], [52.521, 13.41]], 360, 220);
    expect(near.zoom).toBe(15);
    expect(near.lon).toBeCloseTo(13.405, 3);
    const far = fitView([[52.52, 13.4], [48.85, 2.35]], 360, 220);
    expect(far.zoom).toBeLessThan(7);
    expect(fitView([[60, -170], [-60, 170]], 360, 220).zoom).toBe(3); // never below the lowest zoom
    // every point is inside the box with room to spare
    for (const pts of [[[52.52, 13.4], [52.521, 13.41], [52.5, 13.39]], [[52.52, 13.4], [48.85, 2.35]]]) {
      const v = fitView(pts, 360, 220);
      for (const [la, lo] of pts) {
        const q = project(v, 360, 220, la, lo);
        expect(q.x).toBeGreaterThanOrEqual(30);
        expect(q.x).toBeLessThanOrEqual(330);
        expect(q.y).toBeGreaterThanOrEqual(30);
        expect(q.y).toBeLessThanOrEqual(190);
      }
    }
    expect(fitView([], 360, 220).zoom).toBe(3);
  });
  it('lists only the tiles in view, middle first, never more than the cap', () => {
    const v = { lat: 52.52, lon: 13.405, zoom: 15 };
    const t = tilesFor(v, 360, 220);
    expect(t.length).toBeGreaterThanOrEqual(1);
    expect(t.length).toBeLessThanOrEqual(6);
    expect(t.every((x) => x.z === 15 && x.left > -256 && x.left < 360 && x.top > -256 && x.top < 220)).toBe(true);
    expect(t.some((x) => x.x === 17604 && x.y === 10746)).toBe(true);
    expect(tilesFor(v, 2000, 2000, 12)).toHaveLength(12);
    // across the date line the columns wrap; above the top of the map there are no rows
    const wrap = tilesFor({ lat: 0, lon: 179.99, zoom: 3 }, 600, 220);
    expect(wrap.some((x) => x.x === 0) && wrap.some((x) => x.x === 7)).toBe(true);
    expect(tilesFor({ lat: 85, lon: 0, zoom: 3 }, 300, 600).every((x) => x.y >= 0 && x.y <= 7)).toBe(true);
  });
  it('drags', () => {
    const v = { lat: 52.52, lon: 13.405, zoom: 15 };
    const moved = panned(v, -100, 0); // finger to the left: the map shows what is further east
    expect(moved.lon).toBeGreaterThan(v.lon);
    expect(moved.lat).toBeCloseTo(v.lat, 6);
    expect(project(moved, 360, 220, v.lat, v.lon).x).toBeCloseTo(80, 3);
  });
  it('measures', () => {
    expect(haversine(52.52, 13.405, 52.52, 13.405)).toBe(0);
    expect(haversine(52.52, 13.405, 48.8566, 2.3522) / 1000).toBeCloseTo(877.5, 0);
    expect(compass(52.52, 13.405, 52.53, 13.405)).toBe('N');
    expect(compass(52.52, 13.405, 52.52, 13.5)).toBe('E');
    expect(compass(52.52, 13.405, 52.51, 13.39)).toBe('SW');
    expect([fmtDist(4), fmtDist(314), fmtDist(996), fmtDist(1240), fmtDist(12400)]).toEqual(['0 m', '310 m', '1.0 km', '1.2 km', '12 km']);
  });
});

describe('opening hours', () => {
  const at = (d, h, m = 0) => new Date(2026, 10, 8 + d, h, m); // 8 Nov 2026 is a Sunday: d = 0 Sun … 6 Sat
  const on = (s, d, h, m) => openNow(s, at(d, h, m));
  it('reads the common forms', () => {
    expect(on('24/7', 3, 4)).toEqual({ open: true });
    const wk = 'Mo-Fr 08:00-18:30; Sa 09:00-13:00';
    expect(on(wk, 1, 10)).toEqual({ open: true, until: '18:30' });
    expect(on(wk, 1, 7, 59)).toEqual({ open: false, opens: '08:00' });
    expect(on(wk, 1, 18, 30)).toEqual({ open: false, opens: 'tomorrow 08:00' });
    expect(on(wk, 6, 14)).toEqual({ open: false, opens: 'Mo 08:00' });
    expect(on(wk, 0, 10)).toEqual({ open: false, opens: 'tomorrow 08:00' });
    expect(on('Mo,Tu 08:00-12:00,14:00-18:00', 2, 13)).toEqual({ open: false, opens: '14:00' });
    expect(on('Mo,Tu 08:00-12:00,14:00-18:00', 2, 15)).toEqual({ open: true, until: '18:00' });
    expect(on('Mo-Fr 08:00-18:00, Sa 09:00-13:00', 6, 10)).toEqual({ open: true, until: '13:00' }); // rules split by a comma
    expect(on('Sa-Mo 10:00-12:00', 0, 11)).toEqual({ open: true, until: '12:00' }); // a range over the weekend
    expect(on('10:00-20:00', 4, 12)).toEqual({ open: true, until: '20:00' }); // no days = every day
    expect(on('Mo-Su 00:00-24:00', 3, 5)).toEqual({ open: true });
    expect(on('mo-fr 8:00-17:00', 1, 9)).toEqual({ open: true, until: '17:00' });
  });
  it('handles ranges past midnight', () => {
    expect(on('22:00-02:00', 2, 23)).toEqual({ open: true, until: '02:00' });
    expect(on('22:00-02:00', 2, 1)).toEqual({ open: true, until: '02:00' });
    expect(on('22:00-02:00', 2, 3)).toEqual({ open: false, opens: '22:00' });
    expect(on('Fr,Sa 22:00-04:00', 0, 3)).toEqual({ open: true, until: '04:00' }); // Sunday 3 am belongs to Saturday night
    expect(on('Fr,Sa 22:00-04:00', 1, 3)).toEqual({ open: false, opens: 'Fr 22:00' });
  });
  it('lets a later rule override, and off close', () => {
    expect(on('Mo-Fr 09:00-17:00; We off', 3, 10)).toEqual({ open: false, opens: 'tomorrow 09:00' });
    expect(on('Mo-Fr 09:00-17:00; We 12:00-14:00', 3, 10)).toEqual({ open: false, opens: '12:00' });
    expect(on('off', 1, 10)).toEqual({ open: false });
    expect(on('Mo-Su closed', 1, 10)).toEqual({ open: false });
  });
  it('says unknown rather than guess', () => {
    for (const s of ['', '   ', 'Mo-Fr 09:00-17:00; PH off', 'PH,Su off; Mo-Sa 08:00-20:00', 'sunrise-sunset', 'Mo-Fr 09:00-17:00 "by appointment"', 'Jan-Mar Mo 10:00-12:00', '10:00+', 'Mo-Fr 09:00-17:00 || "call"', 'week 1-53/2 Mo 08:00-12:00', 'Mo[1] 10:00-12:00', 'Mo-Fr 09:00-25:00', 'Mo-Fr 9-17', 'open', 'Mo-Fr 12:00-13:00 off', 'x'.repeat(301)]) {
      expect(on(s, 1, 10), s).toBeUndefined();
    }
    expect(openNow(null)).toBeUndefined();
    expect(openText(undefined)).toBe('');
    expect(openText({ open: true, until: '18:30' })).toBe('open now, until 18:30');
    expect(openText({ open: false, opens: '09:00' })).toBe('closed, opens 09:00');
  });
});

describe('map tiles: kept, re-asked politely, capped', () => {
  const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...new Array(40).fill(1)]);
  const T = OSM_DEFAULTS.tiles;
  const setup = (over = {}) => {
    const calls = [];
    let t = 1_000_000;
    const store = memoryTileStore();
    const loader = createTileLoader({
      template: T,
      store,
      now: () => t,
      online: () => true,
      cap: hourlyCap('t', 300, { now: () => t, store: null }),
      fetchTile: async (tpl, z, x, y, etag) => (calls.push({ z, x, y, etag }), { status: 200, headers: { ETag: '"v1"', 'Cache-Control': 'max-age=3600' }, body: png() }),
      ...over,
    });
    return { calls, store, loader, tick: (ms) => (t += ms), now: () => t };
  };

  it('keeps a tile at least 7 days whatever the server says, longer when it says so', () => {
    expect(tileExpiry({ 'cache-control': 'max-age=60' }, 1000)).toBe(1000 + WEEK);
    expect(tileExpiry({}, 1000)).toBe(1000 + WEEK);
    expect(tileExpiry({ 'Cache-Control': 'public, max-age=1209600' }, 0)).toBe(14 * 86400000);
    expect(tileKey(T, 1, 2, 3)).toMatch(/\/1\/2\/3$/);
    expect(tileKey(T, 1, 2, 3)).not.toBe(tileKey('https://other.example/{z}/{x}/{y}.png', 1, 2, 3));
  });

  it('fetches once, then serves from the cache until it expires, then asks with the ETag', async () => {
    const s = setup();
    expect((await s.loader.load(15, 1, 2)).from).toBe('net');
    expect((await s.loader.load(15, 1, 2)).from).toBe('cache');
    s.tick(WEEK - 1000);
    expect((await s.loader.load(15, 1, 2)).from).toBe('cache');
    expect(s.calls).toHaveLength(1);
    s.tick(2000); // now past 7 days
    const again = setup({ store: s.store, now: s.now, fetchTile: async (tpl, z, x, y, etag) => (s.calls.push({ etag }), { status: 304, headers: {}, body: null }) });
    expect((await again.loader.load(15, 1, 2)).from).toBe('cache'); // 304: the kept tile, good for another week
    expect(s.calls[1].etag).toBe('"v1"');
    expect((await again.loader.load(15, 1, 2)).from).toBe('cache');
    expect(s.calls).toHaveLength(2);
  });

  it('asks once for the same tile wanted twice at the same moment, two requests at a time', async () => {
    let flying = 0;
    let most = 0;
    const s = setup({
      fetchTile: async () => {
        most = Math.max(most, ++flying);
        await new Promise((r) => setTimeout(r, 5));
        flying--;
        return { status: 200, headers: {}, body: png() };
      },
    });
    const [a, b] = await Promise.all([s.loader.load(3, 1, 1), s.loader.load(3, 1, 1)]);
    expect(a).toBe(b);
    await Promise.all([1, 2, 3, 4, 5].map((x) => s.loader.load(4, x, 1)));
    expect(most).toBe(2);
  });

  it('offline or failing: the kept tile if there is one, else nothing (the grid), and no request offline', async () => {
    const s = setup();
    await s.loader.load(15, 1, 2);
    s.tick(WEEK + 1);
    const off = setup({ store: s.store, now: s.now, online: () => false, fetchTile: async () => (s.calls.push('x'), { status: 200, headers: {}, body: png() }) });
    expect((await off.loader.load(15, 1, 2)).from).toBe('stale');
    expect(await off.loader.load(15, 9, 9)).toBe(null);
    expect(s.calls).toHaveLength(1);
    const broken = setup({ fetchTile: async () => { throw new Error('boom'); } });
    expect(await broken.loader.load(1, 0, 0)).toBe(null);
    const html = setup({ fetchTile: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('<html>blocked</html> padding padding') }) });
    expect(await html.loader.load(1, 0, 0)).toBe(null); // not a picture: not kept, not drawn
    expect(html.store._map.size).toBe(0);
    const denied = setup({ fetchTile: async () => ({ status: 403, headers: {}, body: png() }) });
    expect(await denied.loader.load(1, 0, 0)).toBe(null);
    // a tile that just failed is not asked for again right away
    let n = 0;
    const flaky = setup({ fetchTile: async () => (n++, { status: 500, headers: {}, body: null }) });
    await flaky.loader.load(1, 0, 0);
    await flaky.loader.load(1, 0, 0);
    expect(n).toBe(1);
  });

  it('stops at the cap for the hour', async () => {
    let t = 0;
    let n = 0;
    const loader = createTileLoader({ template: T, store: memoryTileStore(), now: () => t, online: () => true, cap: hourlyCap('t2', 3, { now: () => t, store: null }), fetchTile: async () => (n++, { status: 200, headers: {}, body: png() }) });
    for (let i = 0; i < 6; i++) await loader.load(5, i, 0);
    expect(n).toBe(3);
    expect(loader.state.paused).toBe(true);
    t += 3600000; // the next hour
    expect((await loader.load(5, 5, 0)).from).toBe('net');
  });
});

describe('the OpenStreetMap services', () => {
  it('uses the public defaults unless the user set something that can work', () => {
    expect(osmConfig({})).toEqual(OSM_DEFAULTS);
    expect(osmConfig({ osm: { tiles: 'https://t.example/{z}/{x}/{y}.png', overpass: 'ftp://x', photon: ' https://p.example/api ' } })).toEqual({ tiles: 'https://t.example/{z}/{x}/{y}.png', overpass: OSM_DEFAULTS.overpass, photon: 'https://p.example/api' });
    expect(cleanOsmUrl('tiles', 'https://t.example/tiles')).toBe(null); // no {z}/{x}/{y}
    expect(cleanOsmUrl('tiles', '')).toBe('');
    expect(cleanOsmUrl('overpass', OSM_DEFAULTS.overpass)).toBe('');
    expect(tileUrl(OSM_DEFAULTS.tiles, 15, 17604, 10746)).toBe('https://tile.openstreetmap.org/15/17604/10746.png');
  });
  it('counts per hour', () => {
    let t = 0;
    const mem = new Map();
    const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    const cap = hourlyCap('x', 2, { now: () => t, store });
    expect([cap.take(), cap.take(), cap.take()]).toEqual([true, true, false]);
    expect(hourlyCap('x', 2, { now: () => t, store }).take()).toBe(false); // kept across a restart
    t = 3600000;
    expect(cap.left()).toBe(2);
    expect(cap.take()).toBe(true);
  });
});
