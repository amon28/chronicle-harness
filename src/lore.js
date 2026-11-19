// Lorebooks / world info, following SillyTavern's World Info semantics:
// - primary keys (plain or /regex/flags), optional secondary keys with logic AND ANY / AND ALL / NOT ANY / NOT ALL
// - constant entries, probability, case sensitivity, whole-word matching
// - position: before the character definition, after it, or injected into the chat at a depth with a role
// - insertion order (lower = earlier), scan depth, token budget, recursive scanning

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function keyMatches(key, text, { caseSensitive = false, wholeWords = true } = {}) {
  const k = String(key).trim();
  if (!k) return false;
  const rx = k.match(/^\/(.+)\/([a-z]*)$/i);
  if (rx) {
    try {
      return new RegExp(rx[1], rx[2]).test(text);
    } catch {
      return false;
    }
  }
  const flags = caseSensitive ? 'u' : 'iu';
  if (!wholeWords || /\s/.test(k)) return new RegExp(esc(k), flags).test(text);
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(k)}(?=$|[^\\p{L}\\p{N}_])`, flags).test(text);
}

function entryActive(e, text) {
  if (e.constant) return true;
  const opt = { caseSensitive: !!e.caseSensitive, wholeWords: e.wholeWords !== false };
  if (!(e.keys || []).some((k) => keyMatches(k, text, opt))) return false;
  const sec = (e.secondaryKeys || []).filter((k) => String(k).trim());
  if (!e.selective || !sec.length) return true;
  const hits = sec.map((k) => keyMatches(k, text, opt));
  switch (e.logic || 'and_any') {
    case 'and_all':
      return hits.every(Boolean);
    case 'not_any':
      return !hits.some(Boolean);
    case 'not_all':
      return !hits.every(Boolean);
    default:
      return hits.some(Boolean);
  }
}

/**
 * books: lorebooks; scanText: recent messages (+ draft); opts.budgetTokens.
 * Returns { before, after, depth: [{depth, role, content}], hits, text } — `text` = before+after (legacy).
 */
export function activeLore(books, scanText, { budgetTokens = 2048, turn = null, timers = {} } = {}) {
  // timed effects (SillyTavern): delay = not before message N; sticky = stays on N messages after it fires;
  // cooldown = can't fire again for N messages after it ends. `timers` is the chat's memory: { [entryId]: { sticky, cooldown } }
  const timed = turn != null;
  const next = timed ? JSON.parse(JSON.stringify(timers || {})) : {};
  for (const id of Object.keys(next)) if ((next[id].sticky || 0) <= turn && (next[id].cooldown || 0) <= turn) delete next[id];
  const stuck = (e) => timed && (next[e.id]?.sticky || 0) > turn;
  const cooling = (e) => timed && (next[e.id]?.cooldown || 0) > turn;
  const delayed = (e) => timed && Number(e.delay) > 0 && turn < Number(e.delay);
  const all = [];
  for (const book of books) for (const e of book.entries || []) if (e.enabled !== false && e.content?.trim()) all.push({ book, entry: e });
  const picked = new Set();
  let text = scanText;
  const recursive = books.some((b) => b.recursive !== false);
  for (let step = 0; step < (recursive ? 4 : 1); step++) {
    // each pass scans what was known before it, so results don't depend on entry order
    const scan = text;
    let added = false;
    for (const h of all) {
      if (picked.has(h)) continue;
      if (delayed(h.entry)) continue;
      if (!stuck(h.entry)) {
        if (cooling(h.entry)) continue;
        if (!entryActive(h.entry, scan)) continue;
        const p = h.entry.probability;
        if (p != null && p < 100 && Math.random() * 100 >= p) continue;
        if (timed && (Number(h.entry.sticky) > 0 || Number(h.entry.cooldown) > 0)) {
          const st = Number(h.entry.sticky) || 0;
          const end = turn + st;
          next[h.entry.id] = { ...(st ? { sticky: end } : {}), ...(Number(h.entry.cooldown) > 0 ? { cooldown: end + Number(h.entry.cooldown) } : {}) };
        }
      }
      picked.add(h);
      added = true;
      if (recursive && h.entry.recurse !== false) text += '\n' + h.entry.content; // activated entries can trigger others next pass
    }
    if (!added) break;
  }
  // budget: constants first, then by insertion order
  const ordered = [...picked].sort((a, b) => (b.entry.constant ? 1 : 0) - (a.entry.constant ? 1 : 0) || (a.entry.order ?? 100) - (b.entry.order ?? 100));
  const budget = Math.min(...books.map((b) => b.budgetTokens || budgetTokens)) * 3.6;
  const kept = [];
  let used = 0;
  for (const h of ordered) {
    if (used + h.entry.content.length > budget) continue;
    used += h.entry.content.length;
    kept.push(h);
  }
  kept.sort((a, b) => (a.entry.order ?? 100) - (b.entry.order ?? 100));
  const fmt = (list) => list.map((h) => h.entry.content.trim()).join('\n');
  const before = fmt(kept.filter((h) => (h.entry.position || 'before') === 'before'));
  const after = fmt(kept.filter((h) => h.entry.position === 'after'));
  const depth = kept.filter((h) => h.entry.position === 'depth').map((h) => ({ depth: h.entry.depth ?? 4, role: h.entry.role || 'system', content: h.entry.content.trim() }));
  return { before, after, depth, hits: kept, text: [before, after].filter(Boolean).join('\n'), timers: next };
}

export const newLorebook = (name = 'New lorebook') => ({ id: 'lb_' + Math.random().toString(36).slice(2, 10), name, entries: [], scanDepth: 4, budgetTokens: 2048, recursive: true });
export const newEntry = () => ({
  id: 'le_' + Math.random().toString(36).slice(2, 10),
  name: '',
  keys: [],
  secondaryKeys: [],
  selective: false,
  logic: 'and_any',
  content: '',
  enabled: true,
  constant: false,
  order: 100,
  position: 'before',
  depth: 4,
  role: 'system',
  probability: 100,
  caseSensitive: false,
  wholeWords: true,
  sticky: 0,
  cooldown: 0,
  delay: 0,
});

// ---------- importing ----------
const ST_POSITION = { 0: 'before', 1: 'after', 2: 'before', 3: 'after', 4: 'depth', 5: 'before', 6: 'after' };
const ST_ROLE = { 0: 'system', 1: 'user', 2: 'assistant' };
const ST_LOGIC = { 0: 'and_any', 1: 'not_all', 2: 'not_any', 3: 'and_all' };

/** One entry from a V2/V3 card character_book (incl. SillyTavern's extensions) or an ST World Info file. */
export function importEntry(e, i, prefix) {
  const ext = e.extensions || {};
  const stPos = e.position ?? ext.position;
  let position = 'before';
  if (typeof stPos === 'number') position = ST_POSITION[stPos] || 'before';
  else if (stPos === 'after_char') position = 'after';
  const keys = e.keys || e.key || [];
  const secondary = e.secondary_keys || e.keysecondary || [];
  const useProb = ext.useProbability ?? e.useProbability;
  const prob = ext.probability ?? e.probability;
  return {
    ...newEntry(),
    id: `${prefix}_${i}`,
    name: e.comment || e.name || '',
    keys: (Array.isArray(keys) ? keys : String(keys).split(',')).map(String).map((k) => k.trim()).filter(Boolean),
    secondaryKeys: (Array.isArray(secondary) ? secondary : String(secondary).split(',')).map(String).map((k) => k.trim()).filter(Boolean),
    selective: !!(e.selective ?? ext.selective) && secondary.length > 0,
    logic: ST_LOGIC[ext.selectiveLogic ?? e.selectiveLogic] || 'and_any',
    content: e.content || '',
    enabled: e.enabled !== false && !e.disable,
    constant: !!e.constant,
    order: e.insertion_order ?? e.order ?? 100,
    position,
    depth: ext.depth ?? e.depth ?? 4,
    role: ST_ROLE[ext.role ?? e.role] || 'system',
    probability: useProb === false || prob == null ? 100 : Number(prob),
    caseSensitive: !!(e.case_sensitive ?? ext.case_sensitive ?? e.caseSensitive),
    wholeWords: (ext.match_whole_words ?? e.matchWholeWords) !== false,
    sticky: Number(ext.sticky ?? e.sticky) || 0,
    cooldown: Number(ext.cooldown ?? e.cooldown) || 0,
    delay: Number(ext.delay ?? e.delay) || 0,
  };
}

/** A lorebook from a card's character_book, an ST World Info JSON ({entries:{…}}), or a V2 book JSON. */
export function importLorebook(json, fallbackName, id) {
  const book = json.character_book || json.data?.character_book || json;
  const raw = Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {});
  if (!raw.length) throw new Error('No lorebook entries found');
  const entries = raw.map((e, i) => importEntry(e, i, id)).filter((e) => e.content.trim());
  return {
    id,
    name: book.name || json.name || fallbackName || 'Lorebook',
    entries,
    scanDepth: book.scan_depth || book.scanDepth || 4,
    budgetTokens: book.token_budget || 2048,
    recursive: book.recursive_scanning !== false,
  };
}
