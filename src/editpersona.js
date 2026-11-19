// Small changes to an existing persona, character or lorebook – instead of rewriting the whole thing.
// Pure functions: they take what read_persona returns and give back only what changes.
import { applyEdits } from './codeedit.js';

export const CARD_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes', 'alternate_greetings', 'tags'];
export const PERSONA_FIELDS = ['name', 'description', 'prompt', 'emoji'];

/**
 * cur: read_persona's result. args: { set, edits, add_greetings, remove_greetings }.
 * → { persona: {name?, description?, prompt?, emoji?} | null, card: full new card | null, changed: [labels] }
 */
export function planPersonaEdit(cur, args) {
  const isChar = !!cur.character;
  const allowed = isChar ? CARD_FIELDS : PERSONA_FIELDS;
  const set = args.set && typeof args.set === 'object' ? args.set : {};
  const bad = Object.keys(set).filter((k) => !allowed.includes(k));
  if (bad.length) throw new Error(`Unknown field${bad.length > 1 ? 's' : ''} ${bad.join(', ')} for a ${isChar ? 'character' : 'chat persona'} – use ${allowed.join(', ')}`);
  const target = isChar ? { ...(cur.card || {}) } : { name: cur.name, description: cur.description || '', prompt: cur.prompt || '' };
  const changed = [];
  for (const [k, v] of Object.entries(set)) {
    target[k] = k === 'alternate_greetings' || k === 'tags' ? (Array.isArray(v) ? v.map(String) : [String(v)]) : String(v ?? '');
    changed.push(k);
  }
  const byField = new Map();
  for (const e of Array.isArray(args.edits) ? args.edits : []) {
    const f = e.field || (isChar ? 'description' : 'prompt');
    if (!allowed.includes(f) || f === 'alternate_greetings' || f === 'tags' || f === 'emoji') throw new Error(`edits can change a text field (${allowed.filter((x) => !['alternate_greetings', 'tags', 'emoji'].includes(x)).join(', ')}), not "${f}"`);
    if (!byField.has(f)) byField.set(f, []);
    byField.get(f).push(e);
  }
  for (const [f, list] of byField) {
    const { text, replaced } = applyEdits(String(target[f] ?? ''), list, f);
    target[f] = text;
    changed.push(`${f} (${replaced} edit${replaced === 1 ? '' : 's'})`);
  }
  if (isChar) {
    const add = (Array.isArray(args.add_greetings) ? args.add_greetings : []).map(String).filter((g) => g.trim());
    const rm = new Set((Array.isArray(args.remove_greetings) ? args.remove_greetings : []).map(Number).filter((n) => n >= 1));
    if (add.length || rm.size) {
      const alt = (target.alternate_greetings || []).filter((_, i) => !rm.has(i + 1));
      target.alternate_greetings = [...alt, ...add];
      if (add.length) changed.push(`+${add.length} greeting${add.length === 1 ? '' : 's'}`);
      if (rm.size) changed.push(`−${rm.size} greeting${rm.size === 1 ? '' : 's'}`);
    }
  }
  if (!changed.length && args.tools == null && !Array.isArray(args.toolset) && !Array.isArray(args.add_tools) && !Array.isArray(args.remove_tools)) throw new Error('Nothing to change: give set, edits, add_greetings/remove_greetings, tools, toolset, add_tools or remove_tools');
  return isChar ? { persona: null, card: target, changed } : { persona: target, card: null, changed };
}

const keyOf = (e) => String(e.name || e.comment || (e.keys || [])[0] || '').toLowerCase();
/** Find an entry by its title or one of its keys. */
const findEntry = (entries, q) => {
  const s = String(q || '').toLowerCase().trim();
  return entries.findIndex((e) => keyOf(e) === s || (e.keys || []).some((k) => String(k).toLowerCase() === s));
};

/**
 * entries: the lorebook's entries (app format). args: { add: [...], update: [{ entry, keys?, content?, edits?, … }], remove: [names] }.
 * newEntry() makes a blank app entry. → { entries, changed: [labels] }
 */
export function planLoreEdit(entries, args, newEntry) {
  const out = entries.map((e) => ({ ...e }));
  const changed = [];
  for (const q of Array.isArray(args.remove) ? args.remove : []) {
    const i = findEntry(out, q);
    if (i < 0) throw new Error(`No entry "${q}" to remove (name or one of its keys)`);
    changed.push(`removed “${keyOf(out[i])}”`);
    out.splice(i, 1);
  }
  for (const u of Array.isArray(args.update) ? args.update : []) {
    const i = findEntry(out, u.entry);
    if (i < 0) throw new Error(`No entry "${u.entry}" to update (name or one of its keys)`);
    const e = out[i];
    if (Array.isArray(u.keys)) e.keys = u.keys.map(String);
    if (Array.isArray(u.secondary_keys)) e.secondaryKeys = u.secondary_keys.map(String);
    if (u.name != null) e.name = String(u.name);
    if (u.content != null) e.content = String(u.content);
    if (Array.isArray(u.edits) && u.edits.length) e.content = applyEdits(String(e.content || ''), u.edits, `entry “${keyOf(e)}”`).text;
    for (const k of ['constant', 'enabled']) if (typeof u[k] === 'boolean') e[k] = u[k];
    for (const k of ['sticky', 'cooldown', 'delay', 'probability', 'order', 'depth']) if (u[k] != null) e[k] = Number(u[k]) || 0;
    if (u.position) e.position = String(u.position);
    changed.push(`updated “${keyOf(e)}”`);
  }
  for (const a of Array.isArray(args.add) ? args.add : []) {
    const keys = (Array.isArray(a.keys) ? a.keys : String(a.keys || '').split(',')).map((k) => String(k).trim()).filter(Boolean);
    if (!String(a.content || '').trim()) throw new Error('A new entry needs content');
    const e = { ...newEntry(), name: String(a.name || keys[0] || ''), keys, content: String(a.content), constant: !!a.constant };
    for (const k of ['sticky', 'cooldown', 'delay', 'probability', 'order', 'depth']) if (a[k] != null) e[k] = Number(a[k]) || 0;
    if (a.position) e.position = String(a.position);
    out.push(e);
    changed.push(`added “${keyOf(e)}”`);
  }
  if (!changed.length) throw new Error('Nothing to change: give add, update or remove');
  return { entries: out, changed };
}
