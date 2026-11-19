import { describe, it, expect, beforeEach } from 'vitest';
import { elementPlace, forgetPlaces, overpassName, overpassQuery, placesDefs, PLACE_CATEGORIES, PLACES_QUESTION, runPlacesTool } from '../../src/places.js';
import { forgetDeviceOks, runDeviceTool } from '../../src/device.js';
import { parseMapDoc } from '../../src/mapblock.js';
import { isWriteCall } from '../../src/planmode.js';
import { toolDefs, toolsSystemPrompt, TOOL_LABELS } from '../../src/tools.js';

const HERE = { lat: 52.52008, lon: 13.40495 };
const el = (id, lat, lon, tags, type = 'node') => (type === 'node' ? { type, id, lat, lon, tags } : { type, id, center: { lat, lon }, tags });
const ELEMENTS = [
  el(2, 52.5249, 13.4049, { amenity: 'pharmacy', name: 'Linden-Apotheke', 'addr:street': 'Lindenweg', 'addr:housenumber': '12' }),
  el(1, 52.5211, 13.4102, { amenity: 'pharmacy', name: 'Apotheke am Markt', 'addr:street': 'Hauptstr.', 'addr:housenumber': '3', 'addr:postcode': '10115', 'addr:city': 'Berlin', opening_hours: 'Mo-Fr 08:00-18:30; Sa 09:00-13:00', phone: '+49 30 1234567;+49 30 999', website: 'https://apotheke-am-markt.example', wheelchair: 'yes' }),
  el(3, 52.5211, 13.41021, { amenity: 'pharmacy', name: 'Apotheke am Markt' }, 'way'), // the same place mapped as a building
  el(4, 52.519, 13.4, { amenity: 'pharmacy', brand: 'DocMorris', opening_hours: 'Mo-Su 20:00-23:00', website: 'javascript:alert(1)' }),
  { type: 'relation', id: 5, tags: { amenity: 'pharmacy', name: 'No position' } },
];
const MONDAY_10 = new Date(2026, 10, 9, 10, 0).getTime();

function setup({ elements = ELEMENTS, statuses = [], geo = null, ask = async (q, opts) => opts[0], coarse = false } = {}) {
  const reqs = [];
  const asked = [];
  const waits = [];
  const ws = { files: {} };
  const ctx = {
    convId: 'c1',
    now: MONDAY_10,
    workspace: ws,
    settings: {},
    wait: async (ms) => void waits.push(ms),
    ask: ask && (async (q, opts) => (asked.push(q), ask(q, opts))),
    device: { location: async (o) => (reqs.push(['location', o]), o.precise && !coarse ? { ...HERE, accuracy: 12, precise: true } : { lat: 52.52, lon: 13.4, accuracy: 1000, precise: false }) },
    http: async (url, o = {}) => {
      reqs.push([url, o]);
      if (url.includes('photon')) return geo ? { status: 200, body: JSON.stringify(geo) } : { status: 200, body: '{"features":[]}' };
      const st = statuses.shift();
      if (st && st !== 200) return { status: st, body: 'busy' };
      const els = typeof elements === 'function' ? elements(decodeURIComponent(String(o.body).slice(5))) : elements;
      return { status: 200, body: JSON.stringify({ elements: els }) };
    },
  };
  return { ctx, reqs, asked, waits, ws, queries: () => reqs.filter((r) => String(r[0]).includes('overpass')).map((r) => decodeURIComponent(String(r[1].body).slice(5))) };
}

describe('places', () => {
  beforeEach(() => (forgetDeviceOks(), forgetPlaces()));

  it('is one tool in the phone-data group, a read in plan mode, with a label', () => {
    expect(placesDefs().map((d) => d.function.name)).toEqual(['places']);
    expect(placesDefs()[0].function.parameters.properties.category.enum).toEqual(PLACE_CATEGORIES);
    expect(PLACE_CATEGORIES.length).toBeGreaterThan(40);
    expect(isWriteCall('places', { category: 'cafe' })).toBe(false);
    expect(TOOL_LABELS.places).toBeTruthy();
    const names = (on) => toolDefs(on).map((d) => d.function.name);
    expect(names({ device: true })).toEqual(expect.arrayContaining(['calendar', 'location', 'places']));
    expect(names({})).not.toContain('places');
    expect(toolsSystemPrompt({ device: true }, 0)).toMatch(/call places .*```map block/s);
    expect(toolsSystemPrompt({}, 0)).not.toMatch(/```map/);
  });

  it('builds a safe Overpass query', () => {
    expect(overpassQuery({ lat: 52.52, lon: 13.405, radius: 1500, filters: ['[amenity=atm]', '[amenity=bank][atm=yes]'], max: 80 })).toBe('[out:json][timeout:15];\n(\n  nwr(around:1500,52.52,13.405)[amenity=atm];\n  nwr(around:1500,52.52,13.405)[amenity=bank][atm=yes];\n);\nout center tags 80;');
    expect(overpassQuery({ lat: 1, lon: 2, radius: 100, filters: [], name: 'Lidl' })).toContain('nwr(around:100,1,2)["name"~"Lidl",i];');
    // nothing a name contains can end the string or the statement
    expect(overpassName('a"];node(1);out;//')).toBe('a\\"\\\\];node\\\\(1\\\\);out;//');
    expect(overpassName('C&A (Mitte)\n.*')).toBe('C&A \\\\(Mitte\\\\) \\\\.\\\\*');
    expect(overpassName('x'.repeat(200))).toHaveLength(60);
  });

  it('turns an element into a place', () => {
    expect(elementPlace(ELEMENTS[1], 'pharmacy')).toEqual({ name: 'Apotheke am Markt', lat: 52.5211, lon: 13.4102, addr: 'Hauptstr. 3, 10115 Berlin', hours: 'Mo-Fr 08:00-18:30; Sa 09:00-13:00', phone: '+49 30 1234567', url: 'https://apotheke-am-markt.example', note: 'wheelchair access' });
    expect(elementPlace(ELEMENTS[3], 'pharmacy')).toMatchObject({ name: 'DocMorris' });
    expect(elementPlace(ELEMENTS[3], 'pharmacy').url).toBeUndefined();
    expect(elementPlace({ type: 'node', id: 9, lat: 1, lon: 2 }, 'pharmacy').name).toBe('pharmacy');
    expect(elementPlace(ELEMENTS[4], 'x')).toBe(null);
  });

  it('asks once, sends a rounded position, and returns the list, the map file and the block', async () => {
    const s = setup();
    const r = await runPlacesTool({ category: 'pharmacy' }, s.ctx);
    expect(s.asked).toEqual([PLACES_QUESTION]);
    expect(PLACES_QUESTION).toMatch(/rounded to about 100 m.*OpenStreetMap/s);
    expect(s.reqs[0]).toEqual(['location', { precise: true }]);
    // the search server gets the position rounded to three decimals (about 100 m), never the exact one
    const q = s.queries();
    expect(q).toHaveLength(1);
    expect(q[0]).toContain('nwr(around:1500,52.52,13.405)[amenity=pharmacy];');
    expect(q[0]).not.toContain('52.52008');
    expect(s.reqs[1][1].method).toBe('POST');
    expect(s.reqs[1][0]).toBe('https://overpass-api.de/api/interpreter');
    expect(r.ok).toBe(true);
    expect(r.result).toBe(
      [
        '3 pharmacies within 1.5 km of the phone (OpenStreetMap data – may be incomplete; opening hours as mapped):',
        '1. DocMorris – 360 m W – closed, opens 20:00 (Mo-Su 20:00-23:00)',
        '2. Apotheke am Markt – 370 m E – Hauptstr. 3, 10115 Berlin – open now, until 18:30 (Mo-Fr 08:00-18:30; Sa 09:00-13:00) – +49 30 1234567 – https://apotheke-am-markt.example – wheelchair access',
        '3. Linden-Apotheke – 540 m N – Lindenweg 12 – opening hours unknown',
        'Map saved to maps/pharmacy-1.json. To show it, put these three lines in your answer:',
        '```map',
        'maps/pharmacy-1.json',
        '```',
        'The map already lists every place with Directions / Map / Call buttons, so do not repeat the whole list – say which one you recommend and why.',
      ].join('\n'),
    );
    expect(r.display).toEqual({ path: 'pharmacy – 3: DocMorris, Apotheke am Markt, Linden-Apotheke', count: 3, files: ['maps/pharmacy-1.json'] });
    const doc = JSON.parse(new TextDecoder().decode(s.ws.files['maps/pharmacy-1.json'].data));
    expect(parseMapDoc(doc).ok).toBe(true);
    expect(doc.me).toEqual([HERE.lat, HERE.lon]);
    expect(doc.title).toBe('Pharmacies near you');
    expect(doc.places.map((p) => p.name)).toEqual(['DocMorris', 'Apotheke am Markt', 'Linden-Apotheke']);
    expect(doc.places[1]).toMatchObject({ open: true, kind: 'pharmacy' });
    expect(Math.round(doc.places[1].dist / 10)).toBe(37);
    expect(doc.source).toBe('© OpenStreetMap contributors');
    // a second search in the same chat: no question, a new file, and the same request is not sent twice
    const again = await runPlacesTool({ category: 'pharmacy', open_now: true, limit: 1 }, s.ctx);
    expect(s.asked).toHaveLength(1);
    expect(s.queries()).toHaveLength(1);
    expect(again.result).toMatch(/^1 pharmacy within 1\.5 km of the phone, open now /);
    expect(again.result).toContain('1. Apotheke am Markt');
    expect(again.display.files).toEqual(['maps/pharmacy-2.json']);
  });

  it('stops when the user says no, and is refused cleanly where nobody can be asked', async () => {
    const no = setup({ ask: async () => 'Not now' });
    const r = await runPlacesTool({ category: 'cafe' }, no.ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/The user said no/);
    expect(no.reqs).toEqual([]);
    const helper = setup({ ask: null });
    const h = await runPlacesTool({ category: 'cafe' }, helper.ctx);
    expect(h.ok).toBe(false);
    expect(h.result).toMatch(/needs their OK, which is not available here/);
    expect(helper.reqs).toEqual([]);
    // without the Android app: only searches around a named place
    const web = await runPlacesTool({ category: 'cafe' }, { ...helper.ctx, device: null });
    expect(web.result).toMatch(/only available in the Android app/);
  });

  it('uses only what the location tool was allowed: an approximate OK gives rough distances and no new question', async () => {
    const s = setup();
    await runDeviceTool('location', {}, s.ctx); // the user shared the approximate location
    expect(s.asked).toHaveLength(1);
    const r = await runPlacesTool({ category: 'pharmacy' }, s.ctx);
    expect(s.asked).toHaveLength(1);
    expect(s.reqs.filter((x) => x[0] === 'location').at(-1)).toEqual(['location', { precise: false }]);
    expect(r.result).toMatch(/only the approximate position was shared, so distances are rough/);
    // Android itself gave only an approximate fix although the chat allowed more: said too
    forgetDeviceOks();
    forgetPlaces();
    const c = setup({ coarse: true });
    expect((await runPlacesTool({ category: 'pharmacy' }, c.ctx)).result).toMatch(/distances are rough/);
  });

  it('searches around coordinates or a named place without touching the phone position', async () => {
    const s = setup();
    const r = await runPlacesTool({ category: 'cafe', near: '48.8566, 2.3522' }, s.ctx);
    expect(s.asked).toEqual([]);
    expect(s.reqs.some((x) => x[0] === 'location')).toBe(false);
    expect(s.queries()[0]).toContain('(around:1500,48.857,2.352)[amenity=cafe]');
    expect(r.result).toMatch(/No cafe mapped within 1\.5 km of 48\.857, 2\.352\./); // what a server returns from outside the circle is not passed on
  });

  it('looks an address up with Photon, once', async () => {
    const s = setup({ geo: { features: [{ geometry: { coordinates: [13.4132, 52.5219] }, properties: { name: 'Alexanderplatz', city: 'Berlin', country: 'Germany' } }] } });
    const r = await runPlacesTool({ name: 'Markt', near: 'Alexanderplatz, Berlin' }, s.ctx);
    expect(s.reqs[0][0]).toBe('https://photon.komoot.io/api?q=Alexanderplatz%2C%20Berlin&limit=1');
    expect(s.queries()[0]).toContain('nwr(around:1500,52.522,13.413)["name"~"Markt",i];');
    expect(r.result).toMatch(/within 1\.5 km of Alexanderplatz, Berlin, Germany/);
    expect(JSON.parse(new TextDecoder().decode(s.ws.files['maps/markt-1.json'].data)).me).toBeUndefined();
    const none = setup();
    const n = await runPlacesTool({ category: 'cafe', near: 'Nowhere at all' }, none.ctx);
    expect(n.ok).toBe(false);
    expect(n.result).toBe('Could not find “Nowhere at all”. Ask the user for a more exact place.');
    expect(none.queries()).toEqual([]);
  });

  it('widens the circle once when nothing is close, then says so plainly', async () => {
    const s = setup({ elements: (q) => (q.includes('around:6000') ? ELEMENTS : []) });
    const r = await runPlacesTool({ category: 'pharmacy' }, s.ctx);
    expect(s.queries().map((q) => /around:(\d+)/.exec(q)[1])).toEqual(['1500', '6000']);
    expect(r.result).toMatch(/^3 pharmacies within 6\.0 km/);
    const none = setup({ elements: [] });
    const n = await runPlacesTool({ category: 'vet', radius_m: 15000 }, none.ctx);
    expect(none.queries().map((q) => /around:(\d+)/.exec(q)[1])).toEqual(['15000', '20000']);
    expect(n.ok).toBe(true);
    expect(n.result).toBe("No vet mapped within 20 km of the phone. OpenStreetMap may be missing it; web_search or android_intent map (opens the user's maps app with the search) may find more.");
    expect(n.display.count).toBe(0);
    expect(Object.keys(none.ws.files)).toEqual([]);
    forgetPlaces();
    const shut = setup({ elements: [ELEMENTS[0], ELEMENTS[3]] });
    expect((await runPlacesTool({ category: 'pharmacy', open_now: true }, shut.ctx)).result).toMatch(/No pharmacy that is known to be open now .*2 found, but closed or without readable opening hours/);
  });

  it('retries a 502 and a timeout once (bounded: two tries, short pause, each try at most 15 s)', async () => {
    const bad = setup({ statuses: [502] });
    const r = await runPlacesTool({ category: 'pharmacy', near: '1,1' }, bad.ctx);
    expect(r.ok).toBe(true);
    expect(bad.waits).toEqual([2000]);
    forgetPlaces();
    const slow = setup();
    let n = 0;
    const timeouts = [];
    const http0 = slow.ctx.http;
    slow.ctx.http = async (url, o) => {
      timeouts.push(o.timeoutMs);
      if (n++ === 0) throw new Error('Request timed out');
      return http0(url, o);
    };
    const t = await runPlacesTool({ category: 'pharmacy', near: '1,1' }, slow.ctx);
    expect(t.ok).toBe(true);
    expect(slow.waits).toEqual([2000]);
    expect(timeouts.length).toBe(2);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(15000);
    forgetPlaces();
    const dead = setup();
    let tries = 0;
    dead.ctx.http = async () => {
      tries++;
      throw new Error('Request timed out');
    };
    const d = await runPlacesTool({ category: 'pharmacy', near: '1,1' }, dead.ctx);
    expect(tries).toBe(2);
    expect(d.result).toMatch(/^FAILED: the OpenStreetMap search could not be reached \(Request timed out, tried 2 times\).*android_intent map/);
    forgetPlaces();
    const gone = setup({ statuses: [502, 502, 502] });
    const g = await runPlacesTool({ category: 'pharmacy', near: '1,1' }, gone.ctx);
    expect(g.result).toMatch(/busy \(HTTP 502, tried 2 times\).*android_intent map/);
    expect(gone.queries().length).toBe(2);
  });

  it('retries a busy server once after a short pause, then reports it', async () => {
    const s = setup({ statuses: [429] });
    const r = await runPlacesTool({ category: 'pharmacy' }, s.ctx);
    expect(s.waits).toEqual([5000]);
    expect(r.ok).toBe(true);
    forgetPlaces();
    const busy = setup({ statuses: [504, 429] });
    const b = await runPlacesTool({ category: 'pharmacy' }, busy.ctx);
    expect(b.ok).toBe(false);
    expect(b.result).toBe('FAILED: the OpenStreetMap search server is busy (HTTP 429, tried 2 times). Try once more in a minute, or use android_intent map with the search text.');
    forgetPlaces();
    const down = setup();
    down.ctx.http = async () => {
      throw new Error('Network error');
    };
    const d = await runPlacesTool({ category: 'pharmacy', near: '1,1' }, down.ctx);
    expect(d.ok).toBe(false);
    expect(d.result).toMatch(/^FAILED: the OpenStreetMap search could not be reached \(Network error, tried 2 times\)/);
    forgetPlaces();
    const junk = setup();
    junk.ctx.http = async () => ({ status: 200, body: '<html>' });
    expect((await runPlacesTool({ category: 'pharmacy', near: '1,1' }, junk.ctx)).ok).toBe(false);
  });

  it('checks its arguments, and limits itself per hour', async () => {
    const s = setup();
    expect((await runPlacesTool({}, s.ctx)).result).toBe('places needs category or name.');
    expect((await runPlacesTool({ category: 'unicorn' }, s.ctx)).result).toMatch(/not a category places knows/);
    expect(s.reqs).toEqual([]);
    // the location is refused by Android: the device tool's own words
    const denied = setup();
    denied.ctx.device.location = async () => {
      throw Object.assign(new Error('Android does not allow Chronicle to use the location (it was refused).'), { code: 'DENIED' });
    };
    expect((await runPlacesTool({ category: 'cafe' }, denied.ctx)).result).toMatch(/do not try another way around it/);
    forgetPlaces();
    let last;
    for (let i = 0; i < 45; i++) last = await runPlacesTool({ category: 'cafe', near: `${10 + i},10` }, s.ctx);
    expect(last.ok).toBe(false);
    expect(last.result).toMatch(/too many place searches in the last hour/);
    expect(s.queries().length).toBeLessThanOrEqual(40);
  });

  it('does not work out "open now" for places in another time zone', async () => {
    const far = (new Date(MONDAY_10).getTimezoneOffset() / -60) * 15 + 150; // a longitude ten hours of sun away
    const lon = ((far + 540) % 360) - 180;
    const s = setup({ elements: [el(1, 10.001, lon + 0.001, { amenity: 'cafe', name: 'Far Cafe', opening_hours: 'Mo-Su 08:00-18:00' })] });
    const r = await runPlacesTool({ category: 'cafe', near: `10,${lon.toFixed(3)}` }, s.ctx);
    expect(r.result).toMatch(/not checked against the time there/);
    expect(r.result).toMatch(/hours: Mo-Su 08:00-18:00/);
    expect(r.result).not.toMatch(/open now|closed,/);
    expect(JSON.parse(new TextDecoder().decode(s.ws.files['maps/cafe-1.json'].data)).clock).toBe(false);
  });
});
