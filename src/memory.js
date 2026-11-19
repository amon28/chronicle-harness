// Long-term memory about the user: short facts/preferences stored on the device,
// injected into the system prompt, and learned from conversations by a small model.
import { isCcModel, streamChat } from './api.js';
import { learnModelRanking } from './models.js';
import { P } from './prompts.js';

const uid = () => 'm_' + (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 10);

export const MAX_MEMORIES = 200;
const MAX_FACT = 160; // learned memories: one short sentence
const MAX_BULLET = 130;
const MAX_NOTES = 650;
/** Cut at a word boundary so a long memory doesn't end mid-word. */
export function clip(s, n) {
  s = String(s || '').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(n - 30, cut.lastIndexOf(' '))).replace(/[,;:\s]+$/, '') + '…';
}

/** Fast/cheap models preferred for background memory extraction, in order. */
// Auto picks the newest DeepSeek Flash model (cheap, good at JSON), then the newest GLM Flash,
// based on the live model list – so renamed/new versions are picked up automatically.
// DeepSeek on Go needs the "Global" region enabled in the OpenCode Console, hence the fallback.
/** Models to try for learning, in order (Auto mode gets fallbacks). */
export function learnCandidates(models, setting, chatModel) {
  if (setting && setting !== 'auto' && setting !== 'chat' && models.some((m) => m.id === setting)) return [setting];
  // Claude Code (decision 169): first, and the automatic choice after it when Claude Code cannot answer (not running…)
  if (isCcModel(setting)) return [setting, ...learnCandidates(models, 'auto', chatModel)];
  if (setting === 'chat') return [chatModel];
  return [...learnModelRanking(models).slice(0, 2), chatModel].filter((v, i, a) => v && a.indexOf(v) === i);
}

export const pickLearnModel = (models, setting, chatModel) => learnCandidates(models, setting, chatModel)[0];

// Memories have a scope: 'global' (added by the user, shared by every persona) or a persona id
// (learned while chatting with that persona, used only by it).
export const GLOBAL = 'global';
// kind 'event' = a persona's notes on what happened in one chat (see extractEpisode); not facts about the user
export const isEvent = (m) => m.kind === 'event';
// Two kinds of persona memory:
// - chat personas (assistants): persistent – learned in one chat, known in every chat with that persona;
// - roleplay: one memory per roleplay (chat) – it carries the chat's id (m.conv) and is only used there,
//   so a new roleplay with the same character starts fresh (the character card is what persists).
export const visibleMemories = (memories, personaId, convId = null, rp = false) =>
  (memories || []).filter((m) => {
    if (isEvent(m)) return false;
    if ((m.scope || GLOBAL) === GLOBAL) return true;
    if (m.scope !== personaId) return false;
    return rp ? m.conv === convId : !m.conv;
  });

const STOP = new Set(`the and for are but not you your with that this have has had was were will would can could about from they them their what when where which who how why its it's i'm don't just like into than then too very also been being does did doing out any all some more most such only own same other our his her she him she's he's there here these those over under again once off while`.split(' '));
const stem = (w) => (w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w.length > 3 && !w.endsWith('ss') ? w.replace(/s$/, '') : w);
export const tokenize = (s) => [...new Set((String(s || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP.has(w)).map(stem))];

/**
 * Pick which facts to send: pinned ones always, then the ones that best match what's being talked about
 * (word overlap, rarer words count more) with a little preference for recent ones. Small lists are sent whole.
 * Returns the facts in their original order.
 */
let simCache = null;
/** Set by the engine right before a request: Map(id → similarity) from the embedding model, or null. */
export const setSim = (x) => (simCache = x);
let bulletSimCache = null;
/** Set by the engine right before a request: Map(textKey(bullet) → similarity) for past-chat note bullets, or null. */
export const setBulletSim = (x) => (bulletSimCache = x);
/** A short key for a piece of text (vectors of note bullets and story paragraphs are cached under it). */
export const textKey = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + t.length.toString(36);
};

export function selectMemories(facts, query, limit, sim = null) {
  if (!limit || facts.length <= limit) return facts;
  const scored = scoreByQuery(facts, query, sim).map((s, i) => ({ m: facts[i], s, pin: !!facts[i].pinned }));
  const pinned = scored.filter((x) => x.pin);
  const rest = scored.filter((x) => !x.pin).sort((a, b) => b.s - a.s);
  const keep = new Set([...pinned, ...rest.slice(0, Math.max(0, limit - pinned.length))].map((x) => x.m));
  return facts.filter((m) => keep.has(m));
}

/**
 * How well each item ({ id, text, updatedAt }) fits the query: shared words (rarer words count more), blended with
 * the embedding similarity when `sim` has one for the item, plus a little for recent ones. → [score] in item order.
 */
export function scoreByQuery(facts, query, sim = null) {
  const q = new Set(tokenize(query));
  const docs = facts.map((m) => tokenize(m.text));
  const df = new Map();
  for (const d of docs) for (const w of d) df.set(w, (df.get(w) || 0) + 1);
  const n = facts.length;
  const times = facts.map((m) => m.updatedAt || m.createdAt || 0);
  const lo = Math.min(...times);
  const span = Math.max(1, Math.max(...times) - lo);
  return facts.map((m, i) => {
    let s = 0;
    for (const w of docs[i]) if (q.has(w)) s += Math.log(1 + n / (df.get(w) || 1));
    s = sim?.has(m.id) ? 5 * Math.max(0, sim.get(m.id)) + 1.5 * (s / (s + 2)) : s;
    s += 0.4 * ((times[i] - lo) / span);
    return s;
  });
}

/** How old a note is, for the prompt: "" while it is recent, else "noted 3 months ago" (so the model can weigh it). */
export function ageNote(m, now = Date.now()) {
  const t = m?.updatedAt || m?.createdAt;
  if (!t || m.pinned) return '';
  const days = Math.floor((now - t) / 864e5);
  if (days < 30) return '';
  if (days < 365) return `noted ${Math.max(1, Math.round(days / 30.4))} month${Math.round(days / 30.4) > 1 ? 's' : ''} ago`;
  const y = Math.round(days / 365);
  return `noted ${y} year${y > 1 ? 's' : ''} ago`;
}
/** Not confirmed for half a year: it may no longer be true. */
export const isStale = (m, now = Date.now()) => !m?.pinned && !isEvent(m) && now - (m?.updatedAt || m?.createdAt || now) > 182 * 864e5;
const withAge = (m) => {
  const a = ageNote(m);
  return a ? `- ${m.text} (${a})` : `- ${m.text}`;
};

// chat personas: notes from OTHER chats (this chat's history is already in the prompt).
// roleplay: only this roleplay's own notes, and only once older messages have left the prompt.
export const episodesFor = (memories, personaId, convId = null, rp = false, trimmed = false) =>
  (memories || [])
    .filter((m) => isEvent(m) && m.scope === personaId && (rp ? trimmed && m.conv === convId : m.conv !== convId && !m.rp))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 12); // the newest chats' notes; the bullets that fit what is being said are picked in pickEpisodeBullets

export function memoryBlock(memories, personaId, convId = null, { rp = false, trimmed = false, query = '', limit = 0, sim = null, bulletSim = null } = {}) {
  const bs = bulletSim ?? bulletSimCache;
  const vis = selectMemories(visibleMemories(memories, personaId, convId, rp), query, limit, sim ?? simCache);
  const episodes = episodesFor(memories, personaId, convId, rp, trimmed);
  if (!vis.length && !episodes.length) return '';
  if (!vis.length) return episodesBlock(episodes, rp, query, bs);
  const global = vis.filter((m) => (m.scope || GLOBAL) === GLOBAL);
  const own = vis.filter((m) => m.scope === personaId);
  const parts = [
    P('memory_block'),
  ];
  if (global.length) parts.push(`About the user:\n${global.map(withAge).join('\n')}`);
  if (own.length) parts.push(`${rp ? 'Learned in this roleplay' : 'Learned in your earlier chats with the user'}:\n${own.map(withAge).join('\n')}`);
  if (episodes.length) parts.push(episodesBlock(episodes, rp, query, bs));
  return parts.join('\n\n');
}

/** An episode's notes are a bullet list; each bullet is one fact: [{ text, i }]. */
export const bulletsOf = (text) =>
  String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean);

/**
 * Notes from past chats are sent bullet by bullet, not whole: the bullets that match what is being talked about
 * (and recent ones) first, at most `max` of them in about 1200 characters, grouped under the chat they came from.
 * bulletSim: Map(textKey(bullet) → cosine to the query) from the on-device embeddings (smart memory), blended with
 * the word overlap the same way facts are; without it, words only.
 */
export function pickEpisodeBullets(episodes, query = '', max = 8, chars = 1200, bulletSim = null) {
  const pseudo = [];
  episodes.forEach((e, ei) => bulletsOf(e.text).forEach((text, bi) => pseudo.push({ id: `${e.id}#${bi}`, text, ei, bi, updatedAt: e.updatedAt || e.createdAt || 0 })));
  const sim = new Map();
  if (bulletSim?.size) for (const p of pseudo) if (bulletSim.has(textKey(p.text))) sim.set(p.id, bulletSim.get(textKey(p.text)));
  const chosen = new Set(selectMemories(pseudo, query, max, sim).map((m) => m.id));
  let used = 0;
  const out = [];
  for (const p of pseudo) {
    if (!chosen.has(p.id)) continue;
    if (used + p.text.length > chars && out.length) break;
    used += p.text.length;
    (out[p.ei] ||= { title: episodes[p.ei].title, bullets: [] }).bullets.push(p.text);
  }
  return out.filter(Boolean);
}

function episodesBlock(episodes, rp = false, query = '', bulletSim = null) {
  const parts = [P(rp ? 'memory_episodes_rp_head' : 'memory_episodes_head')];
  for (const g of pickEpisodeBullets(episodes, query, 8, 1200, bulletSim)) parts.push(`From "${g.title || 'an earlier chat'}":\n${g.bullets.map((b) => `- ${b}`).join('\n')}`);
  return parts.join('\n\n');
}

// ---------- long story memory: sent in part ----------
/** Story memory longer than this is not sent whole: see selectStory. */
export const STORY_FULL = 2500;
const isBulletLine = (l) => /^\s*(?:[-•*]|\d+[.)])\s+/.test(l);
/** The story memory as units: its bullets (headings marked), or its paragraphs when it has no bullets. */
export function storyUnits(text) {
  const t = String(text || '').trim();
  const lines = t.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  if (lines.some(isBulletLine)) return lines.map((l) => ({ text: l, head: !isBulletLine(l) && (/^\s*#|:\s*$|^\s*\*\*/.test(l) || l.trim().length <= 40) }));
  const paras = t.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  return (paras.length >= 3 ? paras : lines).map((x) => ({ text: x, head: false }));
}

/**
 * A long story memory is sent in part: its first and last points always, and of the middle ones those that fit the
 * last messages best (`query`; `sim` = Map(textKey(unit) → cosine) when embeddings are there, word overlap otherwise),
 * within `budget` characters. Short ones (≤ threshold) → null: send it all. Only what is sent is chosen – the stored
 * memory is never changed. → { head, middle, left } (head = first + last, stable while the memory stays the same;
 * middle = the picked middle points in story order; left = how many middle points were left out).
 */
export function selectStory(text, query = '', { threshold = STORY_FULL, budget = threshold, sim = null } = {}) {
  const t = String(text || '').trim();
  if (t.length <= threshold) return null;
  const units = storyUnits(t).map((u, i) => ({ ...u, i }));
  const body = units.filter((u) => !u.head);
  if (body.length < 3) return null;
  const first = body[0];
  const last = body[body.length - 1];
  const middle = body.slice(1, -1);
  const items = middle.map((u) => ({ id: String(u.i), text: u.text }));
  const sm = new Map();
  if (sim?.size) for (const x of items) if (sim.has(textKey(x.text))) sm.set(x.id, sim.get(textKey(x.text)));
  const scores = scoreByQuery(items, query, sm);
  const order = middle.map((u, k) => ({ u, s: scores[k] })).sort((a, b) => b.s - a.s || b.u.i - a.u.i); // ties: later events first
  let used = first.text.length + last.text.length;
  const picked = new Set();
  for (const { u } of order) {
    if (used + u.text.length + 1 > budget) continue;
    used += u.text.length + 1;
    picked.add(u.i);
  }
  const render = (keep) => {
    const out = [];
    let head = null;
    for (const u of units) {
      if (u.head) head = u;
      else if (keep.has(u.i)) {
        if (head) out.push(head.text);
        head = null;
        out.push(u.text);
      }
    }
    return out.join('\n');
  };
  return { head: render(new Set([first.i, last.i])), middle: render(picked), left: middle.length - picked.size };
}

const REF_STOP = new Set(['about', 'their', 'there', 'which', 'would', 'could', 'should', 'these', 'those', 'because', 'while', 'where', 'other', 'being', 'doing']);
/**
 * Memories must come from what the USER said. When the assistant has read a skill, a file or a web page this turn,
 * its words can leak into what gets "learned". Drops proposed memories whose distinctive words come from that
 * reference material rather than from the user's own message.
 */
export function dropReferenceLeaks(changes, userText, refs = []) {
  const ref = refs.join('\n').toLowerCase();
  if (!ref.trim() || !changes) return changes;
  const user = String(userText || '').toLowerCase();
  const leaks = (text) => {
    const words = [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}\\/:._-]{5,}/gu) || []).map((w) => w.replace(/^[._:-]+|[._:-]+$/g, '')))].filter((w) => w.length >= 5 && !REF_STOP.has(w) && !STOP.has(w));
    if (!words.length) return false;
    const foreign = words.filter((w) => ref.includes(w) && !user.includes(w));
    return foreign.length >= 2 || foreign.some((w) => /[\\/]/.test(w)) || foreign.length / words.length >= 0.5;
  };
  return {
    ...changes,
    add: (changes.add || []).filter((t) => !leaks(t)),
    update: (changes.update || []).filter((u) => !leaks(u.text)),
  };
}


function parseJson(text) {
  const t = text.replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Ask a model which memories to add/update/remove after an exchange. Resolves {add, update, remove}. */
// turns: a batch – every user message since the last check, [{ user, assistant }] oldest first (one request for all)
export function extractMemories(settings, { model, memories, userText, assistantText, turns = null, sessionId, name = 'the assistant', username = 'the user', character = '' }) {
  const current = memories.length ? memories.map((m) => `${m.id}: ${m.text}`).join('\n') : '(none yet)';
  const cap = turns?.length > 1 ? Math.max(1200, Math.floor(8000 / turns.length)) : 6000;
  const exchange =
    turns?.length > 1
      ? `(${turns.length} messages from ${username} since the last check, oldest first – each counts as one of the latest messages)\n\n` + turns.map((t) => `USER: ${String(t.user || '').slice(0, cap)}${t.assistant ? `\n\nASSISTANT: ${String(t.assistant).slice(0, 600)}` : ''}`).join('\n\n')
      : `USER: ${String(turns?.[0]?.user ?? userText).slice(0, 6000)}\n\nASSISTANT: ${String((turns?.[0] ? turns[0].assistant : assistantText) || '').slice(0, 1500)}`;
  return new Promise((resolve, reject) => {
    let out = '';
    streamChat(
      settings,
      {
        model,
        sessionId,
        temperature: 0,
        messages: [
          { role: 'system', content: P('memory_extract', { name, username, character: character || '(a helpful assistant)' }) },
          { role: 'user', content: `CURRENT MEMORIES:\n${current}\n\nLATEST EXCHANGE:\n${exchange}` },
        ],
      },
      {
        onContent: (t) => (out += t),
        onReasoning: () => {},
        onDone: () => {
          const j = parseJson(out);
          if (!j) return reject(new Error('Memory model returned no JSON'));
          resolve({
            add: (Array.isArray(j.add) ? j.add : []).filter((x) => typeof x === 'string' && x.trim()),
            update: (Array.isArray(j.update) ? j.update : []).filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string'),
            remove: (Array.isArray(j.remove) ? j.remove : []).filter((x) => typeof x === 'string'),
          });
        },
        onError: reject,
      },
    );
  });
}

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Apply changes in place (new ones get `scope`; only memories in `allowedIds` can change). Returns notes. */
export function applyMemoryChanges(memories, { add, update, remove }, source, scope = GLOBAL, allowedIds = null, extra = {}) {
  const notes = [];
  const now = Date.now();
  const allowed = (id) => !allowedIds || allowedIds.has(id);
  for (const id of remove) {
    if (!allowed(id)) continue;
    const i = memories.findIndex((m) => m.id === id);
    if (i >= 0) {
      notes.push(`Forgot: ${memories[i].text}`);
      memories.splice(i, 1);
    }
  }
  for (const u of update) {
    const m = allowed(u.id) && memories.find((x) => x.id === u.id);
    if (m && u.text.trim() && norm(m.text) !== norm(u.text)) {
      m.text = clip(u.text, MAX_FACT);
      m.updatedAt = now;
      notes.push(`Updated: ${m.text}`);
    }
  }
  for (const text of add) {
    const t = clip(text, MAX_FACT);
    if (memories.some((m) => norm(m.text) === norm(t) && ((m.scope || GLOBAL) === GLOBAL || (m.scope === scope && (m.conv || null) === (extra.conv || null))))) continue;
    memories.push({ id: uid(), text: t, createdAt: now, updatedAt: now, source, scope, ...extra });
    notes.push(`Learned: ${t}`);
  }
  while (memories.length > MAX_MEMORIES) memories.shift();
  return notes;
}

export const newMemory = (text, scope = GLOBAL) => ({ id: uid(), text: text.trim().slice(0, 300), createdAt: Date.now(), updatedAt: Date.now(), source: 'manual', scope });

/** Cheap filter so we don't spend allowance on "thanks", "ok", "continue"… */
export function worthLearning(text) {
  const t = (text || '').trim();
  if (t.length < 12) return /remember|forget|my name|i am|i'm/i.test(t);
  if (/^(thanks|thank you|ok(ay)?|cool|nice|great|continue|go on|more|yes|no)\b[.!]*$/i.test(t)) return false;
  return true;
}

/** "Remember…", "forget…", "my name is…": learned right away, whatever the learning frequency. */
export const explicitLearn = (text) => /\b(?:remember|forget|my name\b|call me\b)/i.test(String(text || ''));

/**
 * Batched learning (assistant chats): which messages one learning run covers now, or null to wait.
 * messages: the chat; i: the reply just made; upto: the chat's "learned up to" index (messages before it were
 * checked; null = never); every: learn after this many of your messages. Your latest message asking to remember
 * or forget something runs it at once. → { from, to, users: [indices of your messages], due } – due false: not yet
 * (the caller keeps `from` as the chat's mark when it has none, so the count starts there); null: nothing to read.
 */
export function learnBatch(messages, i, upto, every = 1) {
  let lastUser = -1;
  for (let k = i - 1; k >= 0; k--) if (messages[k]?.role === 'user') (lastUser = k), (k = -1);
  if (lastUser < 0) return null;
  const from = upto == null || upto > i ? lastUser : upto; // never checked (or messages were deleted): this turn only
  const users = [];
  for (let k = from; k < i; k++) if (messages[k]?.role === 'user' && !messages[k].hidden) users.push(k);
  if (!users.length) return null;
  const due = users.length >= Math.max(1, Number(every) || 1) || explicitLearn(messages[lastUser].content);
  return { from, to: i + 1, users: users.slice(-12), due };
}

/** Ask a model for a persona's updated first-person notes about one chat. Resolves an array of strings. */
export function extractEpisode(settings, { model, name, existing, transcript, sessionId, character = '' }) {
  return new Promise((resolve, reject) => {
    let out = '';
    streamChat(
      settings,
      {
        model,
        sessionId,
        temperature: 0.3,
        kind: 'memory',
        messages: [
          { role: 'system', content: P('memory_episode', { name, character: character || '(a helpful assistant)' }) },
          { role: 'user', content: `EXISTING NOTES:\n${existing || '(none yet)'}\n\nNEW MESSAGES:\n${transcript}` },
        ],
      },
      {
        onContent: (t) => (out += t),
        onReasoning: () => {},
        onDone: () => {
          const j = parseJson(out);
          if (!j || !Array.isArray(j.notes)) return reject(new Error('unreadable answer'));
          resolve(j.notes.map((n) => String(n).replace(/^[-•\s]+/, '').trim()).filter(Boolean).slice(0, 5));
        },
        onError: reject,
      },
    );
  });
}

/** Store a persona's notes for a chat (one memory per persona + chat). */
export function applyEpisode(memories, { personaId, convId, title, notes, rp = false }) {
  const text = notes.slice(0, 5).map((n) => `- ${clip(n, MAX_BULLET)}`).join('\n').slice(0, MAX_NOTES);
  const i = memories.findIndex((m) => isEvent(m) && m.scope === personaId && m.conv === convId);
  const now = Date.now();
  if (!text) return false;
  if (i >= 0) Object.assign(memories[i], { text, title, rp, updatedAt: now });
  else memories.push({ id: uid(), kind: 'event', scope: personaId, conv: convId, title, text, rp, source: 'learned', createdAt: now, updatedAt: now });
  while (memories.length > MAX_MEMORIES) memories.shift();
  return true;
}

/** Ask a model to shorten memories. items: [{id, text, notes}] → Promise<[{id, text}]> */
export function shortenMemories(settings, { model, items, sessionId }) {
  const body = items.map((m) => `${m.id}${m.notes ? ' (NOTES)' : ''}: ${m.text.replace(/\n/g, '\n  ')}`).join('\n\n');
  return new Promise((resolve, reject) => {
    let out = '';
    streamChat(
      settings,
      { model, sessionId, temperature: 0.2, kind: 'memory', messages: [{ role: 'system', content: P('memory_shorten') }, { role: 'user', content: body }] },
      {
        onContent: (t) => (out += t),
        onReasoning: () => {},
        onDone: () => {
          const j = parseJson(out);
          if (!j || !Array.isArray(j.items)) return reject(new Error('unreadable answer'));
          resolve(j.items.filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string'));
        },
        onError: reject,
      },
    );
  });
}

/** Ask a model to propose merges/removals. items: [{id, text}] → Promise<{merge: [{ids, text}], remove: [{id, why}]}> */
export function tidyMemories(settings, { model, items, sessionId }) {
  const body = items.map((m) => `${m.id}: ${m.text}`).join('\n');
  return new Promise((resolve, reject) => {
    let out = '';
    streamChat(
      settings,
      { model, sessionId, temperature: 0.1, kind: 'memory', messages: [{ role: 'system', content: P('memory_tidy') }, { role: 'user', content: body }] },
      {
        onContent: (t) => (out += t),
        onReasoning: () => {},
        onDone: () => {
          const j = parseJson(out);
          if (!j) return reject(new Error('unreadable answer'));
          resolve(cleanTidyPlan(j, items.map((m) => m.id)));
        },
        onError: reject,
      },
    );
  });
}

/** Keep only well-formed proposals about ids we sent; an id is used at most once. */
export function cleanTidyPlan(j, allowedIds) {
  const ok = new Set(allowedIds);
  const used = new Set();
  const take = (id) => (ok.has(id) && !used.has(id) ? (used.add(id), true) : false);
  const merge = [];
  for (const g of Array.isArray(j.merge) ? j.merge : []) {
    const ids = (Array.isArray(g?.ids) ? g.ids : []).filter((x) => typeof x === 'string' && ok.has(x) && !used.has(x));
    const text = typeof g?.text === 'string' ? g.text.trim() : '';
    if (ids.length >= 2 && text) {
      ids.forEach(take);
      merge.push({ ids, text: clip(text, 160) });
    }
  }
  const remove = [];
  for (const r of Array.isArray(j.remove) ? j.remove : []) if (typeof r?.id === 'string' && take(r.id)) remove.push({ id: r.id, why: String(r.why || '').slice(0, 120) });
  return { merge, remove };
}

/**
 * Apply the accepted proposals to the memory list. The first memory of a merge keeps its place (and gets the new
 * text); the others go. Returns { memories, undo } – undo restores exactly what was touched.
 */
export function applyTidy(memories, { merge = [], remove = [] }) {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const gone = new Set();
  const undo = { removed: [], updated: [] };
  const at = Date.now();
  for (const g of merge) {
    const [first, ...rest] = g.ids.filter((id) => byId.has(id));
    if (!first || !rest.length) continue;
    const keep = byId.get(first);
    undo.updated.push({ id: first, text: keep.text, updatedAt: keep.updatedAt, vec: keep.vec });
    keep.text = g.text;
    keep.updatedAt = at;
    delete keep.vec;
    for (const id of rest) (gone.add(id), undo.removed.push({ ...byId.get(id) }));
  }
  for (const r of remove) if (byId.has(r.id) && !gone.has(r.id)) (gone.add(r.id), undo.removed.push({ ...byId.get(r.id) }));
  return { memories: memories.filter((m) => !gone.has(m.id)), undo };
}

export function undoTidy(memories, undo) {
  for (const u of undo.updated || []) {
    const m = memories.find((x) => x.id === u.id);
    if (m) Object.assign(m, { text: u.text, updatedAt: u.updatedAt, vec: u.vec });
  }
  const have = new Set(memories.map((m) => m.id));
  return [...memories, ...(undo.removed || []).filter((m) => !have.has(m.id))];
}

// ---------- undo / redo what a reply changed in memory ----------
// Each reply that taught the persona something keeps a log of exactly what it changed, so retrying the
// reply, editing the message it answered, or swiping to another version can undo (or redo) it.
export const snapshotMemories = (memories) => new Map(memories.map((m) => [m.id, { ...m }]));

export function diffMemories(before, memories) {
  const now = new Set(memories.map((m) => m.id));
  const added = [];
  const updated = [];
  const removed = [];
  for (const m of memories) {
    const b = before.get(m.id);
    if (!b) added.push({ ...m });
    else if (b.text !== m.text) updated.push({ id: m.id, before: b.text, after: m.text });
  }
  for (const [id, b] of before) if (!now.has(id)) removed.push(b);
  return added.length || updated.length || removed.length ? { added, updated, removed } : null;
}

/** Undo a log (entries you edited by hand since are left alone). Returns true if anything changed. */
export function revertMemoryLog(memories, log) {
  if (!log) return false;
  let changed = false;
  for (const a of log.added || []) {
    const i = memories.findIndex((m) => m.id === a.id && m.text === a.text);
    if (i >= 0) (memories.splice(i, 1), (changed = true));
  }
  for (const u of log.updated || []) {
    const m = memories.find((x) => x.id === u.id);
    if (m && m.text === u.after) (Object.assign(m, { text: u.before }), (changed = true));
  }
  for (const r of log.removed || []) if (!memories.some((m) => m.id === r.id)) (memories.push({ ...r }), (changed = true));
  return changed;
}

/** Redo a log (when a reply that taught something becomes the visible version again). */
export function applyMemoryLog(memories, log) {
  if (!log) return false;
  let changed = false;
  for (const a of log.added || []) if (!memories.some((m) => m.id === a.id)) (memories.push({ ...a }), (changed = true));
  for (const u of log.updated || []) {
    const m = memories.find((x) => x.id === u.id);
    if (m && m.text === u.before) (Object.assign(m, { text: u.after }), (changed = true));
  }
  for (const r of log.removed || []) {
    const i = memories.findIndex((m) => m.id === r.id);
    if (i >= 0) (memories.splice(i, 1), (changed = true));
  }
  return changed;
}
