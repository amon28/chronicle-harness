/**
 * The ```map block: a small map in the chat with numbered pins and a list of places.
 *
 * This file is the pure part – reading and checking the block's data (MapDoc), Web-Mercator tile maths, distances,
 * and a careful reader for OpenStreetMap opening hours (anything it does not fully understand is "unknown", never a
 * guess). The drawing is in app/map-ui.js, the tile cache in maptiles.js.
 */

export const TILE = 256;
export const MIN_ZOOM = 3;
export const MAX_ZOOM = 19;
export const MAX_PLACES = 30;
export const MAX_LINE = 500;
const MAX_LAT = 85.0511; // where the square Web-Mercator map ends
const PHONE_RX = /^[+\d][\d\s().#*/-]{2,30}$/;

// ---------- the block's text → a checked MapDoc ----------

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const okLat = (n) => isNum(n) && n >= -90 && n <= 90;
const okLon = (n) => isNum(n) && n >= -180 && n <= 180;
const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
const pair = (v) => (Array.isArray(v) && v.length === 2 && okLat(v[0]) && okLon(v[1]) ? [v[0], v[1]] : null);

/** What the block holds: { path } (a map file in the workspace), { json } (the data itself) or { error }. */
export function mapBlockSource(text) {
  const t = String(text ?? '').trim();
  if (!t) return { error: 'it is empty' };
  if (t.length > 200000) return { error: 'it is too long' };
  if (t[0] === '{') return { json: t };
  const one = t.replace(/^\/?workspace\//, '').replace(/^\.?\//, '');
  if (!/\n/.test(one) && /^[\w][\w .()/+-]{0,200}\.json$/i.test(one) && !one.split('/').includes('..')) return { path: one };
  return { error: 'it needs the path of a map file (like maps/cafe-1.json) or JSON' };
}

/**
 * Checks map data strictly and returns a clean copy with only the known fields.
 * → { ok: true, doc } or { ok: false, error } (a sentence that finishes "This map could not be read: …").
 */
export function parseMapDoc(input) {
  let d = input;
  if (typeof d === 'string') {
    if (d.length > 200000) return { ok: false, error: 'it is too long' };
    try {
      d = JSON.parse(d);
    } catch (e) {
      return { ok: false, error: 'it is not valid JSON (' + String(e.message || e).slice(0, 80) + ')' };
    }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'it is not a JSON object' };
  if (!Array.isArray(d.places) || !d.places.length) return { ok: false, error: 'it has no places' };
  const doc = { v: 1, places: [] };
  const title = str(d.title, 80);
  if (title) doc.title = title;
  for (const k of ['me', 'center']) {
    if (d[k] == null) continue;
    const p = pair(d[k]);
    if (!p) return { ok: false, error: `"${k}" must be [latitude, longitude]` };
    doc[k] = p;
  }
  if (d.zoom != null) {
    if (!isNum(d.zoom)) return { ok: false, error: '"zoom" must be a number' };
    doc.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(d.zoom)));
  }
  if (d.places.length > MAX_PLACES) doc.cut = d.places.length - MAX_PLACES;
  for (const [i, p] of d.places.slice(0, MAX_PLACES).entries()) {
    if (!p || typeof p !== 'object') return { ok: false, error: `place ${i + 1} is not an object` };
    const name = str(p.name, 80);
    if (!name) return { ok: false, error: `place ${i + 1} has no name` };
    if (!okLat(p.lat) || !okLon(p.lon)) return { ok: false, error: `place ${i + 1} (${name}) has no valid lat / lon` };
    const o = { name, lat: p.lat, lon: p.lon };
    const kind = str(p.kind, 30);
    if (kind) o.kind = kind;
    if (isNum(p.dist) && p.dist >= 0) o.dist = Math.round(p.dist);
    const addr = str(p.addr, 120);
    if (addr) o.addr = addr;
    const hours = str(p.hours, 200);
    if (hours) o.hours = hours;
    if (typeof p.open === 'boolean') o.open = p.open;
    const phone = str(p.phone, 40);
    if (phone && PHONE_RX.test(phone)) o.phone = phone;
    const url = str(p.url, 500);
    if (url && /^https?:\/\/[^\s<>"']+$/i.test(url)) o.url = url;
    const note = str(p.note, 120);
    if (note) o.note = note;
    doc.places.push(o);
  }
  if (d.line != null) {
    if (!Array.isArray(d.line)) return { ok: false, error: '"line" must be a list of [latitude, longitude]' };
    const line = [];
    for (const q of d.line.slice(0, MAX_LINE)) {
      const p = pair(q);
      if (!p) return { ok: false, error: '"line" has a point that is not [latitude, longitude]' };
      line.push(p);
    }
    if (line.length > 1) doc.line = line;
  }
  if (d.clock === false) doc.clock = false; // the places are in another time zone: "open now" is not worked out
  const source = str(d.source, 120);
  if (source) doc.source = source;
  return { ok: true, doc };
}

// ---------- distances ----------

const RAD = Math.PI / 180;
/** Metres between two points on the globe. */
export function haversine(lat1, lon1, lat2, lon2) {
  const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** Which way the second point lies from the first: N, NE, E… */
export function compass(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return COMPASS[Math.round((((Math.atan2(y, x) / RAD) % 360) + 360) % 360 / 45) % 8];
}
/** 310 → "310 m", 1240 → "1.2 km", 12400 → "12 km" */
export const fmtDist = (m) => (m < 995 ? `${Math.max(0, Math.round(m / 10) * 10)} m` : m < 9950 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`);

// ---------- Web-Mercator ----------

/** → the point's pixel position on the whole world's map at this zoom (256 px tiles). */
export function lonLatToPx(lon, lat, zoom) {
  const n = TILE * 2 ** zoom;
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * RAD;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n };
}
export function pxToLonLat(x, y, zoom) {
  const n = TILE * 2 ** zoom;
  return { lon: (x / n) * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / RAD };
}
/** The tile a point is in. */
export function tileOf(lon, lat, zoom) {
  const p = lonLatToPx(lon, lat, zoom);
  const max = 2 ** zoom - 1;
  return { z: zoom, x: Math.max(0, Math.min(max, Math.floor(p.x / TILE))), y: Math.max(0, Math.min(max, Math.floor(p.y / TILE))) };
}

/**
 * The view that shows all the points ([lat, lon] each) in a w × h box: the highest zoom (up to maxZoom) at which they
 * fit with some room around them. One point: zoom 16.
 */
export function fitView(points, w, h, { pad = 32, maxZoom = 17 } = {}) {
  const pts = (points || []).filter((p) => p && okLat(p[0]) && okLon(p[1]));
  if (!pts.length) return { lat: 0, lon: 0, zoom: MIN_ZOOM };
  const at = (z) => {
    const ps = pts.map((p) => lonLatToPx(p[1], p[0], z));
    const xs = ps.map((p) => p.x);
    const ys = ps.map((p) => p.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  let zoom = MIN_ZOOM;
  if (pts.length === 1 || (at(MAX_ZOOM).x1 - at(MAX_ZOOM).x0 < 1 && at(MAX_ZOOM).y1 - at(MAX_ZOOM).y0 < 1)) zoom = Math.min(16, maxZoom);
  else {
    const bw = Math.max(16, w - 2 * pad);
    const bh = Math.max(16, h - 2 * pad);
    for (let z = Math.min(maxZoom, MAX_ZOOM); z >= MIN_ZOOM; z--) {
      const b = at(z);
      zoom = z;
      if (b.x1 - b.x0 <= bw && b.y1 - b.y0 <= bh) break;
    }
  }
  const b = at(zoom);
  const c = pxToLonLat((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, zoom);
  return { lat: c.lat, lon: c.lon, zoom };
}

/**
 * The tiles a view needs: [{ z, x, y, left, top }] with left/top = where the tile goes in the box (CSS px), nearest
 * the middle first, at most `max`. Columns wrap around the date line; rows outside the map are left out.
 */
export function tilesFor(view, w, h, max = 12) {
  const z = Math.max(0, Math.min(MAX_ZOOM, Math.round(view.zoom)));
  const n = 2 ** z;
  const c = lonLatToPx(view.lon, view.lat, z);
  const left = c.x - w / 2;
  const top = c.y - h / 2;
  const out = [];
  for (let ty = Math.floor(top / TILE); ty * TILE < top + h; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / TILE); tx * TILE < left + w; tx++) {
      out.push({ z, x: ((tx % n) + n) % n, y: ty, left: Math.round(tx * TILE - left), top: Math.round(ty * TILE - top) });
    }
  }
  const mid = (t) => Math.hypot(t.left + TILE / 2 - w / 2, t.top + TILE / 2 - h / 2);
  return out.sort((a, b) => mid(a) - mid(b)).slice(0, max);
}

/** Where a point is in the box of a view (CSS px from its top-left corner). */
export function project(view, w, h, lat, lon) {
  const c = lonLatToPx(view.lon, view.lat, view.zoom);
  const p = lonLatToPx(lon, lat, view.zoom);
  return { x: p.x - c.x + w / 2, y: p.y - c.y + h / 2 };
}
/** A view moved by dx, dy pixels (dragging the map). */
export function panned(view, dx, dy) {
  const c = lonLatToPx(view.lon, view.lat, view.zoom);
  const n = TILE * 2 ** view.zoom;
  const p = pxToLonLat((((c.x - dx) % n) + n) % n, Math.max(0, Math.min(n, c.y - dy)), view.zoom);
  return { lat: p.lat, lon: p.lon, zoom: view.zoom };
}

// ---------- opening hours ----------

const DAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const DAY_RX = /^(mo|tu|we|th|fr|sa|su)$/;
const TIME_RX = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (min) => `${pad2(Math.floor((((min % 1440) + 1440) % 1440) / 60))}:${pad2(((min % 1440) + 1440) % 1440 % 60)}`;

/** "Mo-Fr", "Sa,Su", "Mo,We-Fr", "Sa-Mo" → a set of weekday numbers (0 = Sunday), or null when it is something else. */
function daySet(s) {
  const out = new Set();
  for (const part of s.split(',')) {
    const r = part.trim().split('-').map((x) => x.trim());
    if (r.length > 2 || !r.every((x) => DAY_RX.test(x))) return null;
    const a = DAYS.indexOf(r[0]);
    const b = DAYS.indexOf(r[r.length - 1]);
    for (let i = a; ; i = (i + 1) % 7) {
      out.add(i);
      if (i === b) break;
    }
  }
  return out.size ? out : null;
}

/** One rule ("Mo-Fr 08:00-12:00,14:00-18:00", "Sa off", "10:00-20:00") → [{ days, spans, off }] or null = not understood. */
function parseRule(rule) {
  const text = rule.trim().toLowerCase();
  if (!text) return [];
  // "Mo-Fr 08:00-18:00, Sa 09:00-13:00": a comma followed by a weekday starts another rule
  const pieces = text.split(/,\s*(?=(?:mo|tu|we|th|fr|sa|su)\b)/);
  const merged = [];
  for (const p of pieces) {
    // "Mo,Tu 08:00-12:00" was split too: a piece that is only weekdays belongs in front of the next one
    if (merged.length && daySet(merged[merged.length - 1])) merged[merged.length - 1] += ',' + p;
    else merged.push(p);
  }
  const out = [];
  for (const piece of merged) {
    const m = /^((?:(?:mo|tu|we|th|fr|sa|su)\b[\s,-]*)+)?\s*(.*)$/.exec(piece.trim());
    const dayText = (m[1] || '').replace(/\s+/g, '').replace(/[,-]+$/, '');
    const rest = (m[2] || '').trim();
    const days = dayText ? daySet(dayText) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;
    if (rest === 'off' || rest === 'closed') {
      out.push({ days, off: true, spans: [] });
      continue;
    }
    if (!rest) {
      if (!dayText) return null;
      out.push({ days, spans: [[0, 1440]] }); // "Mo-Fr" alone: open all day on those days
      continue;
    }
    const spans = [];
    for (const t of rest.split(',')) {
      const x = TIME_RX.exec(t.trim());
      if (!x) return null;
      const s = +x[1] * 60 + +x[2];
      let e = +x[3] * 60 + +x[4];
      if (+x[1] > 24 || +x[3] > 24 || +x[2] > 59 || +x[4] > 59 || s > 1440 || e > 1440 || s === 1440) return null;
      if (e <= s) e += 1440; // past midnight
      spans.push([s, e]);
    }
    out.push({ days, spans });
  }
  return out;
}

/**
 * Is a place with these OpenStreetMap opening_hours open at `now` (a Date, read in the device's time zone)?
 * → { open: true, until: 'HH:MM' | undefined } | { open: false, opens: 'HH:MM' | 'Mo HH:MM' | undefined }
 * → undefined when the text uses anything this reader does not fully understand (public holidays, months, sunrise,
 *   comments, fallbacks…): unknown is better than wrong.
 */
export function openNow(hours, now = new Date()) {
  const text = String(hours ?? '').trim();
  if (!text || text.length > 300) return undefined;
  if (/^24\/7$/i.test(text)) return { open: true };
  const week = Array.from({ length: 7 }, () => null); // per weekday: the spans of the last rule that names it
  let any = false;
  for (const raw of text.split(';')) {
    const rules = parseRule(raw);
    if (!rules) return undefined;
    for (const r of rules) {
      any = true;
      for (const d of r.days) week[d] = r.off ? [] : r.spans;
    }
  }
  if (!any) return undefined;
  const day = now.getDay();
  const min = now.getHours() * 60 + now.getMinutes();
  const spansOf = (d) => week[((d % 7) + 7) % 7] || [];
  for (const [s, e] of spansOf(day)) if (min >= s && min < e) return { open: true, ...(e - s >= 1440 && spansOf(day + 1).some(([s2, e2]) => s2 === 0 && e2 - s2 >= 1440) ? {} : { until: hhmm(e) }) };
  for (const [s, e] of spansOf(day - 1)) if (e > 1440 && min + 1440 >= s && min + 1440 < e) return { open: true, until: hhmm(e) };
  // closed: when does it open next (today, or within a week)?
  const later = spansOf(day).map(([s]) => s).filter((s) => s > min).sort((a, b) => a - b)[0];
  if (later != null) return { open: false, opens: hhmm(later) };
  for (let k = 1; k <= 7; k++) {
    const first = spansOf(day + k).map(([s]) => s).sort((a, b) => a - b)[0];
    if (first != null) return { open: false, opens: `${k === 1 ? 'tomorrow' : DAYS[(day + k) % 7].replace(/^./, (c) => c.toUpperCase())} ${hhmm(first)}` };
  }
  return { open: false };
}

/** "open now, until 18:30" / "closed, opens 09:00" / "" (unknown) */
export function openText(state) {
  if (!state) return '';
  if (state.open) return state.until ? `open now, until ${state.until}` : 'open now';
  return state.opens ? `closed, opens ${state.opens}` : 'closed now';
}

// ---------- a map as plain text (exports, and places without a screen) ----------

/** One place as a line: "Name – 310 m – address – hours – phone – url" */
export function placeLine(p) {
  return [p.name, p.dist != null ? fmtDist(p.dist) : '', p.addr || '', p.hours || '', p.phone || '', p.url || '', p.note || ''].filter(Boolean).join(' – ');
}

/**
 * In exported text a ```map block is of no use as a path: it becomes the list of places it stands for.
 * readFile(path) → the file's text, or null.
 */
export function expandMapBlocks(text, readFile) {
  return String(text ?? '').replace(/(^|\n)```map[ \t]*\n([\s\S]*?)\n```[ \t]*(?=\n|$)/g, (all, lead, body) => {
    try {
      const src = mapBlockSource(body);
      const raw = src.json ?? (src.path ? readFile?.(src.path) : null);
      const r = raw == null ? null : parseMapDoc(raw);
      if (!r?.ok) return all;
      const d = r.doc;
      return `${lead}${d.title ? `**${d.title}**\n` : ''}${d.places.map((p, i) => `${i + 1}. ${placeLine(p)} (${p.lat.toFixed(5)}, ${p.lon.toFixed(5)})`).join('\n')}${d.source ? `\n${d.source}` : ''}`;
    } catch {
      return all;
    }
  });
}
