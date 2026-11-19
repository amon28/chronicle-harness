/**
 * places: real places near the user or near an address ("the nearest pharmacy that is open"), from OpenStreetMap.
 *
 * One Overpass request per call (plus one Photon request when `near` is an address). The position that leaves the
 * phone is rounded to about 100 m. The result is a list for the model and a map file in the workspace, which the
 * model shows by putting a ```map block in its answer (drawn by app/map-ui.js).
 */
import { httpRequest } from './api.js';
import { wsPut } from './sandbox.js';
import { deviceOkOnce, deviceOkGiven, deviceOkGrant, deviceFailed } from './device.js';
import { compass, fmtDist, haversine, openNow, openText } from './mapblock.js';
import { OSM_ATTRIBUTION, hourlyCap, osmConfig, osmHeaders } from './osm.js';

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

/** category → [label, plural, Overpass tag filters (OR-ed)] */
export const PLACE_FILTERS = {
  pharmacy: ['pharmacy', 'pharmacies', ['[amenity=pharmacy]']],
  hospital: ['hospital', 'hospitals', ['[amenity=hospital]']],
  doctor: ['doctor', 'doctors', ['[amenity~"^(doctors|clinic)$"]']],
  dentist: ['dentist', 'dentists', ['[amenity=dentist]']],
  vet: ['vet', 'vets', ['[amenity=veterinary]']],
  atm: ['ATM', 'ATMs', ['[amenity=atm]', '[amenity=bank][atm=yes]']],
  bank: ['bank', 'banks', ['[amenity=bank]']],
  post_office: ['post office', 'post offices', ['[amenity=post_office]']],
  police: ['police station', 'police stations', ['[amenity=police]']],
  toilet: ['public toilet', 'public toilets', ['[amenity=toilets]']],
  drinking_water: ['drinking water point', 'drinking water points', ['[amenity=drinking_water]']],
  supermarket: ['supermarket', 'supermarkets', ['[shop=supermarket]']],
  convenience: ['convenience shop', 'convenience shops', ['[shop=convenience]']],
  bakery: ['bakery', 'bakeries', ['[shop=bakery]']],
  mall: ['shopping centre', 'shopping centres', ['[shop=mall]']],
  hardware: ['hardware shop', 'hardware shops', ['[shop~"^(hardware|doityourself)$"]']],
  electronics: ['electronics shop', 'electronics shops', ['[shop=electronics]']],
  clothes: ['clothes shop', 'clothes shops', ['[shop=clothes]']],
  bookshop: ['bookshop', 'bookshops', ['[shop=books]']],
  hairdresser: ['hairdresser', 'hairdressers', ['[shop=hairdresser]']],
  laundry: ['laundry', 'laundries', ['[shop~"^(laundry|dry_cleaning)$"]']],
  restaurant: ['restaurant', 'restaurants', ['[amenity=restaurant]']],
  cafe: ['cafe', 'cafes', ['[amenity=cafe]']],
  fast_food: ['fast food place', 'fast food places', ['[amenity=fast_food]']],
  bar: ['bar', 'bars and pubs', ['[amenity~"^(bar|pub)$"]']],
  fuel: ['petrol station', 'petrol stations', ['[amenity=fuel]']],
  ev_charging: ['charging station', 'charging stations', ['[amenity=charging_station]']],
  parking: ['car park', 'car parks', ['[amenity=parking]']],
  bicycle_rental: ['bike rental', 'bike rentals', ['[amenity=bicycle_rental]']],
  car_rental: ['car rental', 'car rentals', ['[amenity=car_rental]']],
  taxi: ['taxi rank', 'taxi ranks', ['[amenity=taxi]']],
  bus_stop: ['bus stop', 'bus stops', ['[highway=bus_stop]']],
  train_station: ['train station', 'train stations', ['[railway~"^(station|halt)$"]']],
  subway: ['underground station', 'underground stations', ['[station=subway]']],
  hotel: ['hotel', 'hotels', ['[tourism~"^(hotel|hostel|guest_house)$"]']],
  museum: ['museum', 'museums', ['[tourism=museum]']],
  attraction: ['sight', 'sights', ['[tourism=attraction]']],
  park: ['park', 'parks', ['[leisure=park]']],
  playground: ['playground', 'playgrounds', ['[leisure=playground]']],
  gym: ['gym', 'gyms', ['[leisure=fitness_centre]']],
  swimming_pool: ['swimming pool', 'swimming pools', ['[leisure=swimming_pool][access!=private]']],
  cinema: ['cinema', 'cinemas', ['[amenity=cinema]']],
  library: ['library', 'libraries', ['[amenity=library]']],
  school: ['school', 'schools', ['[amenity=school]']],
  university: ['university', 'universities', ['[amenity=university]']],
  place_of_worship: ['place of worship', 'places of worship', ['[amenity=place_of_worship]']],
};
export const PLACE_CATEGORIES = Object.keys(PLACE_FILTERS);

export const placesDefs = () => [
  fn(
    'places',
    'Find real places near the user or near an address: the nearest pharmacy, ATMs around a hotel, cafes in walking distance. Give category (preferred) and/or name. near: leave out to search around the phone (the user is asked once per chat), or give a place or address as text, or "lat,lon". Returns up to limit places sorted by distance with address, opening hours (and whether open now, when the data allows), phone and website, and saves a map file – show it by putting the ```map block from the result in your answer. Data is OpenStreetMap: it can be incomplete or out of date, so say so when it matters (e.g. a pharmacy at night).',
    {
      category: { type: 'string', enum: PLACE_CATEGORIES, description: 'What kind of place' },
      name: { type: 'string', description: 'Part of the place name, e.g. "Lidl" (with or without category)' },
      near: { type: 'string', description: 'A place or address ("Alexanderplatz, Berlin") or "lat,lon". Default: where the phone is now' },
      radius_m: { type: 'integer', description: 'Search radius in metres, 100-20000 (default 1500; widened once automatically when nothing is found)' },
      limit: { type: 'integer', description: 'At most this many, 1-20 (default 8)' },
      open_now: { type: 'boolean', description: 'Only places known to be open now (places without readable opening hours are left out)' },
    },
  ),
];

export const placesPrompt = () =>
  '- For "nearest / near me / around <place>" questions call places (it gets the position itself – do not call location first). Then answer in two or three sentences – which place you would pick and why (distance, open now) – and show the map by putting the ```map block from the result in your answer. Never invent places, addresses or opening hours; if places finds nothing, say so and offer web_search or the user\'s maps app (android_intent map).\n' +
  '- A ```map block draws a small map in the chat: its body is the path of a map file from places, or JSON {"title","me":[lat,lon],"places":[{"name","lat","lon","addr","hours","phone","url","note"}],"line":[[lat,lon],…]}. Use it only with coordinates you got from a tool or the user – never guessed ones.';

export const PLACES_QUESTION = 'Find places near you?\n\nYour position, rounded to about 100 m, is sent to the OpenStreetMap search server. The assistant sees the results with their distances from you in this chat.';

/** The words of a name search, safe inside an Overpass "…"-quoted regular expression (case is ignored by the query). */
export function overpassName(name) {
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The Overpass query for these filters around a point. The centre is already rounded by the caller. */
export function overpassQuery({ lat, lon, radius, filters, name, max = 80 }) {
  const nm = name ? `["name"~"${overpassName(name)}",i]` : '';
  const around = `(around:${Math.round(radius)},${lat},${lon})`;
  const lines = (filters?.length ? filters : ['']).map((f) => `  nwr${around}${f}${nm};`);
  return `[out:json][timeout:15];\n(\n${lines.join('\n')}\n);\nout center tags ${max};`;
}

const tidy = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** One Overpass element → a place of the map file, or null when it has no position. */
export function elementPlace(e, label) {
  const lat = e?.lat ?? e?.center?.lat;
  const lon = e?.lon ?? e?.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const t = e.tags || {};
  const p = { name: tidy(t.name || t.brand || t.operator || label, 80) || 'Place', lat, lon };
  const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
  const town = [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ');
  const addr = tidy([street, town].filter(Boolean).join(', '), 120);
  if (addr) p.addr = addr;
  if (t.opening_hours) p.hours = tidy(t.opening_hours, 200);
  const phone = tidy(String(t.phone || t['contact:phone'] || '').split(';')[0], 40);
  if (phone) p.phone = phone;
  const url = tidy(t.website || t['contact:website'] || '', 500);
  if (/^https?:\/\/[^\s<>"']+$/i.test(url)) p.url = url;
  const notes = [t.wheelchair === 'yes' && 'wheelchair access', t.dispensing === 'yes' && 'dispensing', t.cuisine && `cuisine: ${String(t.cuisine).replace(/[;_]/g, ' ')}`, t.fee === 'yes' && 'fee', t.fee === 'no' && 'free'].filter(Boolean).join(', ');
  if (notes) p.note = tidy(notes, 120);
  return p;
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const slugOf = (s) => String(s || 'places').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'places';
const sleep = (ms, signal) =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener?.('abort', () => (clearTimeout(t), rej(Object.assign(new Error('Stopped'), { name: 'AbortError' }))), { once: true });
  });

const cache = new Map(); // request → { at, value } for ten minutes: asking again does not hit the servers again
const CACHE_MS = 10 * 60 * 1000;
let cap = null;
let clockNow = () => Date.now();
/** for tests */
export const forgetPlaces = () => (cache.clear(), (cap = null));

const fail = (text, short) => ({ ok: false, result: `FAILED: ${text}`, display: { error: short || text.slice(0, 80), path: 'places' } });
const BUSY = (status, tries) => `the OpenStreetMap search server is busy (HTTP ${status}${tries > 1 ? `, tried ${tries} times` : ''}). Try once more in a minute, or use android_intent map with the search text.`;
const SEARCH_BUDGET_MS = 30000; // the place search, both tries together
const TRY_MS = 15000; // one try (the query itself asks the server for at most 15 s)
const retryable = (status) => status === 429 || status >= 500;
const stopped = (e) => e?.name === 'AbortError' || e?.code === 'STOPPED';

/**
 * ctx.device.location (the Device plugin), ctx.ask, ctx.workspace, ctx.settings.osm; for tests ctx.http (like
 * httpRequest), ctx.now (ms), ctx.wait (the pause before the one retry of the place search).
 */
export async function runPlacesTool(args = {}, ctx = {}) {
  const category = PLACE_FILTERS[args.category] ? args.category : '';
  const name = tidy(args.name, 60);
  if (args.category && !category && !name) return { ok: false, result: `"${tidy(args.category, 40)}" is not a category places knows. Use one of: ${PLACE_CATEGORIES.join(', ')} – or give name.`, display: { error: 'unknown category', path: 'places' } };
  if (!category && !name) return { ok: false, result: 'places needs category or name.', display: { error: 'category or name', path: 'places' } };
  const [label, plural, filters] = category ? PLACE_FILTERS[category] : [name, `places named “${name}”`, []];
  const http = ctx.http || globalThis.__ocmPlacesHttp || httpRequest;
  const now = ctx.now ?? Date.now();
  clockNow = () => ctx.now ?? Date.now();
  const cfg = osmConfig(ctx.settings);
  let radius = Math.max(100, Math.min(20000, Math.round(Number(args.radius_m)) || 1500));
  const limit = Math.max(1, Math.min(20, Math.round(Number(args.limit)) || 8));

  // ---- where to look ----
  const near = tidy(args.near, 200);
  let centre; // { lat, lon } – the real one, for distances
  let where; // words for the result
  let me = false; // the search is around the phone
  let rough = false; // only an approximate position was shared
  const ll = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(near);
  if (!near) {
    if (!ctx.device?.location) return { ok: false, result: 'Places near the phone are only available in the Android app. Give near (a place, an address or "lat,lon") to search somewhere else.', display: { error: 'unavailable', path: 'places' } };
    // the location tool's OK covers this too: an exact one gives exact distances, an approximate one rough distances.
    // With no OK yet the user is asked here, once per chat, and told what leaves the phone.
    const fine = deviceOkGiven(ctx, 'precise location') || deviceOkGiven(ctx, 'places');
    if (!fine && !deviceOkGiven(ctx, 'location')) {
      if (!ctx.ask) return { ok: false, result: "Finding places near the user needs their OK, which is not available here. Give near (a place, an address or \"lat,lon\") instead, or leave it to the main assistant.", display: { error: 'unavailable', path: 'places' } };
      const no = await deviceOkOnce(ctx, 'location', PLACES_QUESTION, 'Search near me');
      if (no) return no;
      deviceOkGrant(ctx, 'places');
    }
    const precise = deviceOkGiven(ctx, 'precise location') || deviceOkGiven(ctx, 'places');
    try {
      ctx.onStatus?.('finding where you are…');
      const r = await ctx.device.location({ precise });
      if (!Number.isFinite(r?.lat) || !Number.isFinite(r?.lon)) throw new Error('The phone gave no position');
      centre = { lat: r.lat, lon: r.lon };
      rough = !r.precise;
    } catch (e) {
      return deviceFailed(e, 'places');
    }
    where = 'the phone';
    me = true;
  } else if (ll && Math.abs(+ll[1]) <= 90 && Math.abs(+ll[2]) <= 180) {
    centre = { lat: +ll[1], lon: +ll[2] };
    where = `${round3(centre.lat)}, ${round3(centre.lon)}`;
  }

  const get = async (key, run) => {
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    cap ||= hourlyCap('places', 40, { now: () => clockNow() });
    if (!cap.take()) throw Object.assign(new Error('cap'), { cap: true });
    const value = await run();
    cache.set(key, { at: now, value });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return value;
  };
  const netFail = (e) => {
    if (e?.name === 'AbortError' || ctx.signal?.aborted) return { ok: false, result: 'Stopped.', display: { error: 'stopped', path: 'places' } };
    if (e?.cap) return fail('too many place searches in the last hour (the OpenStreetMap servers are free and shared, so the app limits itself). Use what you already found, or android_intent map to open the user\'s maps app.', 'fair-use limit');
    if (e?.status) return fail(BUSY(e.status, e.tries), `HTTP ${e.status}`);
    if (globalThis.navigator?.onLine === false) return fail('no network – places needs the internet. The user can open their maps app instead (android_intent map).', 'offline');
    return fail(`the OpenStreetMap search could not be reached (${String(e?.message || e).slice(0, 120)}${e?.tries > 1 ? `, tried ${e.tries} times` : ''}). Try again, or use android_intent map with the search text.`, 'network');
  };

  try {
    if (!centre) {
      ctx.onStatus?.(`looking up ${near.slice(0, 40)}…`);
      const url = `${cfg.photon}${cfg.photon.includes('?') ? '&' : '?'}q=${encodeURIComponent(near)}&limit=1`;
      const hit = await get('geo ' + url, async () => {
        const r = await http(url, { headers: await osmHeaders({ Accept: 'application/json' }), timeoutMs: 15000 });
        if (r.status !== 200) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        const f = JSON.parse(r.body)?.features?.[0];
        const c = f?.geometry?.coordinates;
        if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
        const pr = f.properties || {};
        return { lat: c[1], lon: c[0], label: tidy([pr.name, pr.city !== pr.name && pr.city, pr.country].filter(Boolean).join(', '), 100) };
      });
      if (!hit) return { ok: false, result: `Could not find “${near}”. Ask the user for a more exact place.`, display: { error: 'place not found', path: 'places' } };
      centre = { lat: hit.lat, lon: hit.lon };
      where = hit.label || near;
    }

    // ---- the search: one request, once more with a wider circle when nothing is there ----
    const q = { lat: round3(centre.lat), lon: round3(centre.lon) };
    const t0 = Date.now();
    const left = () => SEARCH_BUDGET_MS - (Date.now() - t0);
    const search = (r) =>
      get(`poi ${cfg.overpass} ${q.lat},${q.lon} ${r} ${category} ${name.toLowerCase()}`, async () => {
        const body = 'data=' + encodeURIComponent(overpassQuery({ ...q, radius: r, filters, name }));
        // a busy server (429, any 5xx) or no answer in time: once more after a short pause, as long as that fits in
        // SEARCH_BUDGET_MS from the start of the search (the shared public server is often busy for a moment)
        const once = async (ms) => http(cfg.overpass, { method: 'POST', headers: await osmHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }), body, timeoutMs: ms });
        const tryOnce = (ms = TRY_MS) => once(ms).then((res) => ({ res, err: null }), (err) => ({ res: null, err }));
        let { res, err } = await tryOnce();
        const pause = res?.status === 429 ? 5000 : 2000;
        if (((res && retryable(res.status)) || (err && !stopped(err))) && left() - pause >= 5000) {
          ctx.onStatus?.(`the search server ${res ? 'is busy' : 'did not answer'} – trying once more in ${pause / 1000} s…`);
          await (ctx.wait ? ctx.wait(pause) : sleep(pause, ctx.signal));
          ({ res, err } = await tryOnce(Math.min(TRY_MS, left())));
          if (res && res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, tries: 2 });
          if (err) throw stopped(err) ? err : Object.assign(err, { tries: 2 });
        }
        if (err) throw err;
        if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        const els = JSON.parse(res.body)?.elements;
        if (!Array.isArray(els)) throw new Error('an answer that is not a list of places');
        return els;
      });
    ctx.onStatus?.(`searching for ${plural}…`);
    let els = await search(radius);
    if (!els.length && radius < 20000) {
      radius = Math.min(20000, radius * 4);
      ctx.onStatus?.(`nothing close – looking within ${fmtDist(radius)}…`);
      els = await search(radius);
    }

    // ---- elements → places, nearest first ----
    // "open now" is worked out with this phone's clock: only when the places are in (about) the phone's time zone
    const solar = centre.lon / 15;
    const tz = -new Date(now).getTimezoneOffset() / 60;
    const clock = me || Math.abs(solar - tz) <= 2.5;
    const when = new Date(now);
    let places = [];
    for (const e of els) {
      const p = elementPlace(e, label);
      if (!p) continue;
      p.dist = Math.round(haversine(centre.lat, centre.lon, p.lat, p.lon));
      if (p.dist > radius + 200) continue; // not what was asked for (the search centre is rounded, hence the margin)
      if (category) p.kind = label;
      const st = clock && p.hours ? openNow(p.hours, when) : undefined;
      if (st) p.open = st.open;
      p._state = st;
      // the same place mapped twice (a point and its building): keep one
      if (places.some((o) => o.name === p.name && haversine(o.lat, o.lon, p.lat, p.lon) < 40)) continue;
      places.push(p);
    }
    places.sort((a, b) => a.dist - b.dist);
    const before = places.length;
    if (args.open_now) places = places.filter((p) => p.open === true);
    places = places.slice(0, limit);
    const tail = 'OpenStreetMap may be missing it; web_search or android_intent map (opens the user\'s maps app with the search) may find more.';
    if (!places.length) {
      const what = args.open_now && before ? `No ${label} that is known to be open now within ${fmtDist(radius)} of ${where} (${before} found, but closed or without readable opening hours – call again without open_now to see them).` : `No ${label} mapped within ${fmtDist(radius)} of ${where}.`;
      return { ok: true, result: `${what} ${tail}`, display: { path: `${label} – none found`, count: 0 } };
    }

    // ---- the map file ----
    const states = places.map((p) => p._state);
    for (const p of places) delete p._state;
    const title = tidy(`${plural.replace(/^./, (c) => c.toUpperCase())} near ${me ? 'you' : where}`, 80);
    const doc = { v: 1, title, ...(me ? { me: [centre.lat, centre.lon] } : {}), ...(clock ? {} : { clock: false }), places, source: OSM_ATTRIBUTION };
    let path = '';
    const w = ctx.workspace;
    if (w) {
      const slug = slugOf(category || name);
      let n = 1;
      while (w.files[`maps/${slug}-${n}.json`]) n++;
      try {
        path = wsPut(w, `maps/${slug}-${n}.json`, JSON.stringify(doc, null, 1), { by: 'places' });
      } catch {
        path = '';
      }
    }

    // ---- the text for the model ----
    const line = (p, i) => {
      const hours = p.hours ? (states[i] ? `${openText(states[i])} (${p.hours})` : `hours: ${p.hours}${clock ? ' (not worked out whether open now)' : ''}`) : 'opening hours unknown';
      return `${i + 1}. ${[p.name, `${fmtDist(p.dist)} ${compass(centre.lat, centre.lon, p.lat, p.lon)}`, p.addr, hours, p.phone, p.url, p.note].filter(Boolean).join(' – ')}`;
    };
    const head = `${places.length} ${places.length === 1 ? label : plural} within ${fmtDist(radius)} of ${where}${args.open_now ? ', open now' : ''} (OpenStreetMap data – may be incomplete; opening hours as mapped${clock ? '' : ', and not checked against the time there'}${rough ? '; only the approximate position was shared, so distances are rough (±1 km)' : ''}):`;
    const fence = path ? '```map\n' + path + '\n```' : '```map\n' + JSON.stringify(doc) + '\n```';
    const show = path
      ? `Map saved to ${path}. To show it, put these three lines in your answer:\n${fence}\nThe map already lists every place with Directions / Map / Call buttons, so do not repeat the whole list – say which one you recommend and why.`
      : `To show a map, put this block in your answer:\n${fence}`;
    return {
      ok: true,
      result: `${head}\n${places.map(line).join('\n')}\n${show}`,
      display: { path: `${label} – ${places.length}: ${places.slice(0, 3).map((p) => p.name).join(', ')}${places.length > 3 ? '…' : ''}`.slice(0, 120), count: places.length, ...(path ? { files: [path] } : {}) },
    };
  } catch (e) {
    return netFail(e);
  }
}
