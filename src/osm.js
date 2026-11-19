/**
 * The public OpenStreetMap services the app may call – map tiles, place search (Overpass), address search (Photon) –
 * and the rules for being a fair user of them: the app names itself in the User-Agent (no address, no user name),
 * calls them only when the assistant looks something up or the user looks at a map, and stops at a cap per hour.
 * All three addresses can be changed in Settings (advanced), so a block or a move needs no app update.
 */
import { Capacitor } from '@capacitor/core';

export const OSM_DEFAULTS = {
  tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  overpass: 'https://overpass-api.de/api/interpreter',
  photon: 'https://photon.komoot.io/api',
};
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

const okUrl = (u) => /^https?:\/\/[^\s]+$/i.test(u);
/** What the user typed for one of the addresses → the cleaned value, '' for "use the default", or null = not usable. */
export function cleanOsmUrl(kind, value) {
  const v = String(value ?? '').trim();
  if (!v || v === OSM_DEFAULTS[kind]) return '';
  if (!okUrl(v)) return null;
  if (kind === 'tiles' && !(v.includes('{z}') && v.includes('{x}') && v.includes('{y}'))) return null;
  return v;
}
/** The addresses in use: the user's, where set and valid, else the defaults. */
export function osmConfig(settings) {
  const o = settings?.osm || {};
  const pick = (k) => (cleanOsmUrl(k, o[k]) ? cleanOsmUrl(k, o[k]) : OSM_DEFAULTS[k]);
  return { tiles: pick('tiles'), overpass: pick('overpass'), photon: pick('photon') };
}
export const tileUrl = (template, z, x, y) => template.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a');

let agentP = null;
/** "Chronicle/1.0.123 (Android app)" – what the app calls itself to these services. No address, nothing about the user. */
export function osmAgent() {
  agentP ||= (Capacitor.isNativePlatform() ? import('@capacitor/app').then(({ App }) => App.getInfo()).then((i) => (i?.version ? `Chronicle/${i.version} (Android app)` : 'Chronicle (Android app)')) : Promise.resolve('')).catch(() => 'Chronicle (Android app)');
  return agentP;
}
/** Request headers for these services. In a browser the User-Agent cannot be set (and would force a CORS preflight). */
export async function osmHeaders(extra = {}) {
  const ua = await osmAgent();
  return ua ? { 'User-Agent': ua, ...extra } : { ...extra };
}

/** A cap per hour, kept across restarts when there is a localStorage: take() → true while there is room. */
export function hourlyCap(name, max, { now = () => Date.now(), store = globalThis.localStorage } = {}) {
  const key = 'ocm.cap.' + name;
  let mem = null;
  const read = () => {
    try {
      const v = store ? JSON.parse(store.getItem(key) || 'null') : mem;
      return v && typeof v.h === 'number' && typeof v.n === 'number' ? v : null;
    } catch {
      return mem;
    }
  };
  const write = (v) => {
    mem = v;
    try {
      store?.setItem(key, JSON.stringify(v));
    } catch {
      /* private mode: the count lives until the app closes */
    }
  };
  const hour = () => Math.floor(now() / 3600000);
  return {
    left: () => {
      const v = read();
      return v && v.h === hour() ? Math.max(0, max - v.n) : max;
    },
    take: () => {
      const v = read();
      const cur = v && v.h === hour() ? v : { h: hour(), n: 0 };
      if (cur.n >= max) return false;
      write({ h: cur.h, n: cur.n + 1 });
      return true;
    },
  };
}
