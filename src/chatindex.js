/**
 * Search by meaning across all chats, and recall in long roleplays – one on-device index for both.
 * Every message (long enough to mean something) gets an EmbeddingGemma vector, stored per chat in IndexedDB
 * under a key made of its time and a hash of its text, so an edited message is embedded again and a deleted one
 * drops out. The index fills in the background, a few messages at a time.
 */
import { encodeVec, decodeVec, cosine } from './embed.js';
import { stripChoices } from './choices.js';

const hash32 = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};
/** What of a message is worth indexing (its text and its tool rounds' text), or '' when too short. */
export function chunkText(m) {
  if (!m || m.hidden || m.greeting || m.streaming || m.error) return '';
  const t = stripChoices([m.content || '', ...(m.rounds || []).map((r) => r.content || '')].join('\n')).replace(/\s+/g, ' ').trim();
  return t.length >= 24 ? t.slice(0, 1000) : '';
}
export const keyOf = (m, text) => `${m.at || 0}:${hash32(text)}`;

/**
 * Embed up to `budget` messages that have no vector yet, newest chats first.
 * store: { get(convId) → {chunks:{key:vec}} | null, put(convId, idx) }, embed(texts, 'document') → vectors.
 */
export async function indexChats(convs, { store, embed, budget = 24 }) {
  let done = 0;
  const list = [...(convs || [])].filter((c) => c.messages?.length).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const c of list) {
    if (done >= budget) break;
    const idx = (await store.get(c.id)) || { chunks: {} };
    const want = new Map();
    for (const m of c.messages) {
      const t = chunkText(m);
      if (t) want.set(keyOf(m, t), t);
    }
    let changed = false;
    for (const k of Object.keys(idx.chunks)) if (!want.has(k)) (delete idx.chunks[k], (changed = true)); // deleted or edited
    const todo = [...want].filter(([k]) => !idx.chunks[k]).slice(0, budget - done);
    for (let i = 0; i < todo.length; i += 8) {
      const part = todo.slice(i, i + 8);
      const vs = await embed(part.map(([, t]) => t), 'document');
      part.forEach(([k], j) => (idx.chunks[k] = encodeVec(vs[j])));
      done += part.length;
      changed = true;
    }
    if (changed) await store.put(c.id, idx);
  }
  return done;
}

/** How much of the index is filled: { indexed, total }. */
export async function indexProgress(convs, store) {
  let indexed = 0;
  let total = 0;
  for (const c of convs || []) {
    const idx = (await store.get(c.id)) || { chunks: {} };
    for (const m of c.messages || []) {
      const t = chunkText(m);
      if (!t) continue;
      total++;
      if (idx.chunks[keyOf(m, t)]) indexed++;
    }
  }
  return { indexed, total };
}

/** Each message of a chat with its similarity to the query vector: [{ i, score, text }] best first. */
async function scored(c, qv, store) {
  const idx = await store.get(c.id);
  if (!idx) return [];
  const out = [];
  c.messages.forEach((m, i) => {
    const t = chunkText(m);
    const v = t && idx.chunks[keyOf(m, t)];
    if (v) out.push({ i, score: cosine(qv, decodeVec(v)), text: t });
  });
  return out.sort((a, b) => b.score - a.score);
}

/** Chats that talk about the query's meaning: [{ id, title, at, score, snippet, index }] best first. */
export async function semanticSearch(convs, query, { store, embed, exclude = null, max = 8, min = 0.3 }) {
  if (!String(query || '').trim()) return [];
  const [q] = await embed([String(query).slice(0, 1000)], 'query');
  const qv = decodeVec(encodeVec(q));
  const out = [];
  for (const c of convs || []) {
    if (c.id === exclude || !c.messages?.length) continue;
    const best = (await scored(c, qv, store))[0];
    if (best && best.score >= min) out.push({ id: c.id, title: c.title || 'Untitled chat', at: c.updatedAt || 0, score: best.score, snippet: best.text.slice(0, 240) + (best.text.length > 240 ? '…' : ''), index: best.i });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

/** Word hits and meaning hits as one list: chats found both ways first, then by meaning, then by words. */
export function mergeHits(words, meaning, max = 8) {
  const byId = new Map();
  meaning.forEach((h, r) => byId.set(h.id, { ...h, rank: r, how: 'meaning' }));
  words.forEach((h, r) => {
    const m = byId.get(h.id);
    if (m) byId.set(h.id, { ...m, snippet: h.snippet || m.snippet, rank: Math.min(m.rank, r) - 100, how: 'both' });
    else byId.set(h.id, { ...h, rank: r + 0.5, how: 'words' });
  });
  return [...byId.values()].sort((a, b) => a.rank - b.rank).slice(0, max);
}

/**
 * Roleplay recall: the earlier messages of this chat (before `before`, i.e. no longer in the prompt) that fit
 * what is happening now. → [{ i, text, score }] in story order.
 */
export async function recall(conv, { store, embed, before, query, max = 3, min = 0.35 }) {
  if (!before || !String(query || '').trim()) return [];
  const [q] = await embed([String(query).slice(-1500)], 'query');
  const qv = decodeVec(encodeVec(q));
  return (await scored(conv, qv, store))
    .filter((x) => x.i < before && x.score >= min)
    .slice(0, max)
    .sort((a, b) => a.i - b.i);
}

/**
 * Similarity of short texts (past-chat note bullets, story memory points) to a query: Map(key → cosine).
 * items: [{ key, text }]. Each text is embedded once: its vector is kept in the store under `_texts`, by key.
 */
export async function textSims(items, query, { store, embed, keep = 3000 }) {
  const out = new Map();
  if (!items?.length || !String(query || '').trim()) return out;
  const idx = (await store.get('_texts')) || { chunks: {} };
  const todo = [...new Map(items.filter((x) => x.text && !idx.chunks[x.key]).map((x) => [x.key, x.text]))];
  for (let i = 0; i < todo.length; i += 8) {
    const part = todo.slice(i, i + 8);
    const vs = await embed(part.map(([, t]) => t.slice(0, 1000)), 'document');
    part.forEach(([k], j) => (idx.chunks[k] = encodeVec(vs[j])));
  }
  if (todo.length) {
    const keys = Object.keys(idx.chunks);
    for (const k of keys.slice(0, Math.max(0, keys.length - keep))) delete idx.chunks[k]; // the oldest go first
    await store.put('_texts', idx);
  }
  const [q] = await embed([String(query).slice(-2000)], 'query');
  const qv = decodeVec(encodeVec(q));
  for (const x of items) if (idx.chunks[x.key]) out.set(x.key, cosine(qv, decodeVec(idx.chunks[x.key])));
  return out;
}

/**
 * Your own words from other chats that fit the query (cross-chat recall for assistant chats): your messages only,
 * in the chats `convs` (already filtered by the caller). → [{ id, title, at, i, text, score }] best first.
 */
export async function pastWords(convs, query, { store, embed, max = 3, min = 0.35 }) {
  if (!String(query || '').trim() || !convs?.length) return [];
  const [q] = await embed([String(query).slice(-1500)], 'query');
  const qv = decodeVec(encodeVec(q));
  const out = [];
  for (const c of convs) {
    for (const h of await scored(c, qv, store)) {
      const m = c.messages[h.i];
      if (m?.role === 'user' && h.score >= min) out.push({ id: c.id, title: c.title || 'Untitled chat', at: m.at || c.updatedAt || 0, i: h.i, text: h.text, score: h.score });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameRx = (n) => new RegExp(`(?<![\\p{L}\\p{N}])${escRx(n)}(?![\\p{L}\\p{N}])`, 'iu');
/**
 * Roleplay recall by name: older messages (before `before`) that mention a name or thing from the story's own lists
 * (lorebook keys, scene-sheet values, character and persona names) which the last messages (`query`) mention too.
 * A name found in most older messages (the main character's) says nothing about which moment fits, so it is skipped.
 * → [{ i, text, score, names }] best first (rarer names and more of them first, then the later moment).
 */
export function nameHits(messages, { before, names = [], query = '', max = 3 }) {
  if (!before || !names.length) return [];
  const q = String(query || '');
  const want = [...new Set(names.map((n) => String(n || '').trim()).filter((n) => n.length >= 3 && n.length <= 40))].filter((n) => nameRx(n).test(q));
  if (!want.length) return [];
  const older = [];
  for (let i = 0; i < Math.min(before, messages.length); i++) {
    const t = chunkText(messages[i]);
    if (t) older.push({ i, text: t });
  }
  if (!older.length) return [];
  const df = new Map(want.map((n) => [n, older.filter((o) => nameRx(n).test(o.text)).length]));
  const useful = want.filter((n) => df.get(n) > 0 && (df.get(n) <= 2 || df.get(n) / older.length <= 0.4));
  const out = [];
  for (const o of older) {
    const hit = useful.filter((n) => nameRx(n).test(o.text));
    if (hit.length) out.push({ i: o.i, text: o.text, names: hit, score: hit.reduce((s, n) => s + Math.log(1 + older.length / df.get(n)), 0) });
  }
  return out.sort((a, b) => b.score - a.score || b.i - a.i).slice(0, max);
}

/**
 * Recall from both sides as one list of at most `max`, in story order: name hits that contain a name from your last
 * message come first, then the meaning hits, then the other name hits; a message is never listed twice.
 */
export function mergeRecall(meaning, byName, { lastUser = '', max = 3 } = {}) {
  const said = (h) => (h.names || []).some((n) => nameRx(n).test(String(lastUser || '')));
  const order = [...byName.filter(said), ...meaning, ...byName.filter((h) => !said(h))];
  const seen = new Set();
  const out = [];
  for (const h of order) {
    if (seen.has(h.i) || out.length >= max) continue;
    seen.add(h.i);
    out.push(h);
  }
  return out.sort((a, b) => a.i - b.i);
}
