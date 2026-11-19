// What each chat remembers between visits: the message you were typing and where you were reading.
// Small, in localStorage, the 60 most recent chats.
const KEY = 'ocm_chatstate';
const MAX = 60;
function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
}
/** Remember (or forget, when both are empty) a chat's draft and reading position. → the stored map */
export function rememberChat(id, { draft = '', at = null } = {}, now = Date.now()) {
  if (!id) return load();
  const all = load();
  if (String(draft).trim() || at != null) all[id] = { ...(String(draft).trim() ? { draft: String(draft).slice(0, 20000) } : {}), ...(at != null ? { at } : {}), t: now };
  else delete all[id];
  const ids = Object.keys(all);
  if (ids.length > MAX) for (const k of ids.sort((a, b) => all[a].t - all[b].t).slice(0, ids.length - MAX)) delete all[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full: drafts are a convenience */
  }
  return all;
}
/** → { draft, at } for a chat ('' and null when nothing is remembered). */
export function recallChat(id) {
  const s = load()[id];
  return { draft: s?.draft || '', at: s?.at ?? null };
}
