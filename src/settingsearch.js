// Settings search: matching words against the settings' own labels, plus a small table of the words people look for
// that the labels do not use ("battery" for the background page, "calendar" for Phone data). The index itself is
// read from the Settings sheet (src/app/settings-search.js), so a new setting is found without touching this file.

/** A word people search for → words that appear in the labels of the settings they mean. */
export const SYNONYMS = {
  battery: ['battery', 'phone status', 'notifications & background'],
  calendar: ['phone data', 'calendar'],
  contacts: ['phone data', 'contacts'],
  location: ['phone data', 'maps & places', 'location'],
  gps: ['phone data', 'location'],
  map: ['maps & places', 'map tiles', 'phone data'],
  places: ['maps & places', 'phone data'],
  nearby: ['phone data', 'maps & places'],
  storage: ['storage', 'using space', 'phone folder', 'all phone storage'],
  space: ['storage', 'using space'],
  disk: ['storage', 'using space'],
  folder: ['folder'],
  github: ['github', 'git'],
  git: ['github', 'git'],
  schedule: ['scheduled', 'schedule', 'recipes', 'exact timing'],
  cron: ['scheduled', 'schedule'],
  alarm: ['scheduled', 'exact timing', 'other apps'],
  timer: ['scheduled', 'other apps'],
  notifications: ['notification', 'background'],
  alerts: ['notification'],
  wifi: ['phone status', 'wi-fi'],
  network: ['phone status', 'proxy', 'connection'],
  internet: ['web search', 'open pages', 'proxy'],
  flashlight: ['phone status'],
  torch: ['phone status'],
  volume: ['phone status'],
  clipboard: ['phone status'],
  camera: ['phone status'],
  photo: ['phone status', 'picture'],
  preset: ['preset'],
  sampler: ['sampler', 'temperature'],
  temperature: ['sampler', 'temperature'],
  model: ['model'],
  key: ['key', 'token'],
  api: ['api', 'key', 'provider'],
  token: ['token', 'key'],
  password: ['key', 'token'],
  backup: ['backup', 'restore'],
  restore: ['restore', 'backup'],
  export: ['export', 'backup'],
  import: ['import', 'restore'],
  font: ['text size'],
  bigger: ['text size'],
  zoom: ['text size'],
  dark: ['theme'],
  light: ['theme'],
  colour: ['colour', 'color', 'theme', 'accent'],
  color: ['colour', 'color', 'theme', 'accent'],
  wallpaper: ['background'],
  voice: ['voice', 'read aloud', 'dictation'],
  speech: ['voice', 'read aloud', 'dictation'],
  tts: ['read aloud', 'voice'],
  microphone: ['dictation', 'voice'],
  lore: ['lorebook'],
  memory: ['memor', 'remember'],
  mcp: ['mcp'],
  server: ['mcp', 'server'],
  plugin: ['mcp', 'mods', 'skills'],
  shell: ['linux', 'terminal', 'commands'],
  terminal: ['linux', 'terminal'],
  linux: ['linux'],
  browser: ['browser', 'open pages'],
  python: ['python'],
  code: ['python', 'code'],
  character: ['character', 'persona'],
  persona: ['persona', 'character'],
  update: ['update', 'new versions'],
  usage: ['usage', 'tokens & cost'],
  cost: ['usage', 'cost'],
  budget: ['usage', 'budget'],
  offline: ['offline', 'on-device'],
  tasker: ['automation'],
  macrodroid: ['automation'],
  automation: ['automation'],
  icons: ['icon'],
  emoji: ['emoji'],
  language: ['language', 'voice'],
  agent: ['agent', 'tools'],
  tools: ['tools'],
};

export const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** The words to look for, for one word of the query: itself and what the table says (prefixes of 3+ letters count). */
export function alternatives(word) {
  const w = normalize(word);
  const out = new Set([w]);
  if (w.length >= 3) for (const [k, v] of Object.entries(SYNONYMS)) if (k.startsWith(w) || (w.startsWith(k) && w.length - k.length <= 2)) v.forEach((x) => out.add(x));
  return [...out];
}

/**
 * entries: [{ label, hint?, where?, page, kind: 'page' | 'setting', ... }] → the matches, best first (at most `limit`).
 * Every word of the query must be found (as typed, or one of its alternatives) in the label, hint or place.
 */
export function searchSettings(entries, query, limit = 30) {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const alts = words.map(alternatives);
  const scored = [];
  for (const e of entries) {
    const label = normalize(e.label);
    const rest = normalize(`${e.hint || ''} ${e.where || ''}`);
    let score = 0;
    let ok = true;
    for (let i = 0; i < words.length && ok; i++) {
      const own = words[i];
      if (label.includes(own)) score += label.startsWith(own) || label.includes(' ' + own) ? 6 : 4;
      else if (alts[i].some((a) => a !== own && label.includes(a))) score += 3;
      else if (rest.includes(own)) score += 2;
      else if (alts[i].some((a) => a !== own && rest.includes(a))) score += 1;
      else ok = false;
    }
    if (!ok) continue;
    if (e.kind === 'page') score += 2;
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.order - b.e.order);
  const seen = new Set();
  const out = [];
  for (const { e } of scored) {
    const k = `${e.page}\u0000${normalize(e.label)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
