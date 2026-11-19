// One chat as a Chronicle file (.json): everything the chat is (messages with their versions, greetings, the scene
// tracker, story memory, author's note, group settings, the roleplay preset id) plus a copy of the characters, the
// "you" persona and the lorebooks it uses, so it opens on another phone that does not have that character.
// No keys or tokens, and no workspace files (a whole-app backup has those). Pure: the app passes its lists in.

export const CHAT_EXPORT_FORMAT = 'chronicle-chat';
export const CHAT_EXPORT_VERSION = 1;

// keys that are a secret wherever they appear (also deep inside a persona or a message's tool data)
const SECRET = /^(api_?key|apiKeys?|exaKey|ghToken|githubToken|githubRefresh|githubSshKey|microlinkKey|token|accessToken|access_token|refreshToken|refresh_token|idToken|password|passwd|secret|clientSecret|client_secret|authorization|cookie|cookies|oauth|bearer|sshKey|privateKey)$/i;
// what belongs to this phone or this copy of the chat, not to the story: a linked phone folder, the chat's git
// repo and coding agent (their files are not exported), schedules (they would run on both phones), what you allowed
// here, and the list state (pinned, archived, folder)
const LOCAL_ONLY = ['phoneFolder', 'git', 'acp', 'schedules', 'schedDone', 'resumeAt', 'silenceUntil', 'allowedTools', 'automation', 'pinned', 'pinnedAt', 'archived', 'folderId', 'streaming', 'live'];
const MSG_LOCAL = ['streaming', 'live'];

/** A deep copy without secret-looking keys. */
export function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!SECRET.test(k) && x !== undefined) out[k] = scrub(x);
  return out;
}

const uniq = (a) => [...new Set(a.filter(Boolean))];
/** The characters a chat uses: its own, a group's members and whoever wrote a message (or a version of one). */
export function chatPersonaIds(conv) {
  const ids = [conv.personaId, ...(conv.group?.members || [])];
  for (const m of conv.messages || []) {
    ids.push(m.personaId);
    for (const a of m.alts || []) ids.push(a?.personaId);
  }
  return uniq(ids);
}

/**
 * Build the export. ctx: { personas, userPersonas, defaultUserPersonaId, lorebooks, art: {personaId: dataUrl},
 * memories, now, app }. → a plain object (JSON.stringify it).
 */
export function buildChatExport(conv, ctx = {}) {
  const chat = scrub(JSON.parse(JSON.stringify(conv)));
  for (const k of LOCAL_ONLY) delete chat[k];
  chat.messages = (chat.messages || []).filter((m) => !m.streaming).map((m) => {
    for (const k of MSG_LOCAL) delete m[k];
    return m;
  });
  const byId = new Map((ctx.personas || []).map((p) => [p.id, p]));
  const characters = chatPersonaIds(conv)
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p) => {
      const c = scrub(JSON.parse(JSON.stringify(p)));
      delete c.reimportUndo; // the card before its last re-import: this phone's undo, not the character
      const art = p.hasArt ? ctx.art?.[p.id] : null;
      if (art) c.art = art;
      else delete c.hasArt;
      return c;
    });
  const ups = ctx.userPersonas || [];
  const up = ups.find((u) => u.id === conv.userPersonaId) || ups.find((u) => u.id === ctx.defaultUserPersonaId) || ups[0];
  const bookIds = uniq([...(conv.lorebookIds || []), ...characters.map((p) => p.lorebookId)]);
  const lorebooks = bookIds.map((id) => (ctx.lorebooks || []).find((b) => b.id === id)).filter(Boolean).map((b) => scrub(JSON.parse(JSON.stringify(b))));
  const memories = (ctx.memories || []).filter((m) => m.conv === conv.id).map((m) => scrub(JSON.parse(JSON.stringify(m))));
  return {
    format: CHAT_EXPORT_FORMAT,
    version: CHAT_EXPORT_VERSION,
    app: ctx.app || 'Chronicle',
    exportedAt: new Date(ctx.now ?? Date.now()).toISOString(),
    note: 'One chat with its characters. Workspace files, API keys and tokens are not included.',
    chat,
    characters,
    userPersona: up ? { ...scrub(JSON.parse(JSON.stringify(up))), usedByChat: !!conv.userPersonaId } : null,
    lorebooks,
    memories,
  };
}

/** What a file is: 'chronicle' (this format), 'st' (a SillyTavern .jsonl chat) or null. */
export function detectChatFile(text) {
  const s = String(text || '').replace(/^﻿/, '').trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      if (o && o.format === CHAT_EXPORT_FORMAT) return 'chronicle';
      if (o && (o.mes !== undefined || o.user_name !== undefined || o.character_name !== undefined)) return 'st'; // a one-line ST chat
    } catch {
      /* several lines: maybe .jsonl */
    }
    const first = s.split(/\r?\n/)[0];
    try {
      const o = JSON.parse(first);
      if (o && typeof o === 'object' && (o.mes !== undefined || o.user_name !== undefined || o.character_name !== undefined || o.chat_metadata !== undefined)) return 'st';
    } catch {
      return null;
    }
  }
  return null;
}

/** Parse a Chronicle chat file; throws a message for the person when it can't be used. */
export function parseChatExport(text) {
  let o;
  try {
    o = JSON.parse(String(text || '').replace(/^﻿/, ''));
  } catch {
    throw new Error('This is not a Chronicle chat file (not valid JSON)');
  }
  if (!o || o.format !== CHAT_EXPORT_FORMAT) throw new Error('This is not a Chronicle chat file');
  const v = Number(o.version);
  if (!Number.isInteger(v) || v < 1) throw new Error('This chat file has no version – it may be damaged');
  if (v > CHAT_EXPORT_VERSION) throw new Error(`This chat was exported by a newer version of the app (format ${v}). Update the app to import it.`);
  if (!o.chat || !Array.isArray(o.chat.messages)) throw new Error('This chat file has no messages');
  return { ...o, characters: Array.isArray(o.characters) ? o.characters : [], lorebooks: Array.isArray(o.lorebooks) ? o.lorebooks : [], memories: Array.isArray(o.memories) ? o.memories : [] };
}

// what makes two characters "the same": everything that shapes how it plays, not ids, pictures or bookkeeping
const IGNORE = new Set(['id', 'builtin', 'hasArt', 'art', 'avatar', 'lorebookId', 'createdAt', 'updatedAt', 'lastUsed', 'order', 'usedByChat', 'reimportedAt', 'reimportUndo', 'sourcePicHash', 'lastModels']);
const stable = (v) => {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .filter((k) => v[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stable(v[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(v ?? null);
};
export const personaFingerprint = (p) => stable(Object.fromEntries(Object.entries(scrub(p || {})).filter(([k]) => !IGNORE.has(k))));
const bookFingerprint = (b) => stable(Object.fromEntries(Object.entries(b || {}).filter(([k]) => k !== 'id' && k !== 'updatedAt' && k !== 'createdAt')));

/**
 * Plan an import, without changing anything. ctx: { personas, userPersonas, lorebooks, newId(), newPersonaId(),
 * newMemoryId(), now }. A character with the same id, or an identical one under another id, is reused; otherwise it
 * is added (with its own id when that is free). The chat always gets a new id, so nothing is overwritten.
 * → { conv, addPersonas, addUserPersonas, addLorebooks, art: [{ id, dataUrl }], memories, reused: [names], made: [names] }
 */
export function planChatImport(data, ctx) {
  const personas = ctx.personas || [];
  const userPersonas = ctx.userPersonas || [];
  const lorebooks = ctx.lorebooks || [];
  const taken = new Set(personas.map((p) => p.id));
  const out = { addPersonas: [], addUserPersonas: [], addLorebooks: [], art: [], memories: [], reused: [], made: [] };

  // lorebooks first: characters point to them
  const bookMap = new Map();
  const bookTaken = new Set(lorebooks.map((b) => b.id));
  for (const b of data.lorebooks || []) {
    if (!b?.id) continue;
    const fp = bookFingerprint(b);
    const same = lorebooks.find((x) => x.id === b.id && bookFingerprint(x) === fp) || lorebooks.find((x) => bookFingerprint(x) === fp);
    if (same) bookMap.set(b.id, same.id);
    else {
      const id = bookTaken.has(b.id) ? 'lb_' + ctx.newId().slice(0, 8) : b.id;
      bookTaken.add(id);
      out.addLorebooks.push({ ...scrub(b), id });
      bookMap.set(b.id, id);
    }
  }

  const map = new Map();
  for (const ch of data.characters || []) {
    if (!ch?.id || map.has(ch.id)) continue;
    const fp = personaFingerprint(ch);
    const sameId = personas.find((p) => p.id === ch.id);
    const same = (sameId && personaFingerprint(sameId) === fp ? sameId : null) || personas.find((p) => personaFingerprint(p) === fp) || (sameId?.builtin && ch.builtin ? sameId : null);
    if (same) {
      map.set(ch.id, same.id);
      out.reused.push(same.name);
      continue;
    }
    const { art, ...card } = scrub(ch);
    const id = taken.has(ch.id) ? ctx.newPersonaId() : ch.id;
    taken.add(id);
    const p = { ...card, id };
    delete p.builtin; // an imported copy is the user's own
    if (p.lorebookId) p.lorebookId = bookMap.get(p.lorebookId) || (lorebooks.some((b) => b.id === p.lorebookId) ? p.lorebookId : undefined);
    if (p.lorebookId === undefined) delete p.lorebookId;
    if (typeof art === 'string' && art.startsWith('data:')) {
      p.hasArt = true;
      out.art.push({ id, dataUrl: art });
    } else delete p.hasArt;
    out.addPersonas.push(p);
    out.made.push(p.name || 'Character');
    map.set(ch.id, id);
  }
  const pid = (id) => (id && map.has(id) ? map.get(id) : id);

  // the "you" persona: only when the chat had its own; same id or same name + description → reuse
  let userPersonaId;
  const up = data.userPersona;
  if (up?.id && up.usedByChat !== false) {
    const same = userPersonas.find((u) => u.id === up.id) || userPersonas.find((u) => (u.name || '') === (up.name || '') && (u.description || '') === (up.description || ''));
    if (same) userPersonaId = same.id;
    else {
      const { usedByChat: _u, ...rest } = scrub(up);
      const id = userPersonas.some((u) => u.id === up.id) ? 'u_' + ctx.newId().slice(0, 8) : up.id;
      out.addUserPersonas.push({ ...rest, id });
      userPersonaId = id;
    }
  }

  const src = scrub(data.chat);
  for (const k of LOCAL_ONLY) delete src[k];
  const now = ctx.now ?? Date.now();
  const conv = {
    ...src,
    id: ctx.newId(),
    title: String(src.title || 'Imported chat').slice(0, 80),
    titleSource: src.titleSource || 'user',
    createdAt: Number(src.createdAt) || now,
    updatedAt: Number(src.updatedAt) || Number(src.createdAt) || now,
    personaId: pid(src.personaId),
    messages: src.messages.map((m) => {
      const x = { ...m, ...(m.personaId ? { personaId: pid(m.personaId) } : {}) };
      if (Array.isArray(m.alts)) x.alts = m.alts.map((a) => (a && a.personaId ? { ...a, personaId: pid(a.personaId) } : a));
      for (const k of MSG_LOCAL) delete x[k];
      return x;
    }),
    importedAt: now,
  };
  if (!conv.personaId) delete conv.personaId;
  if (conv.group?.members) conv.group = { ...conv.group, members: conv.group.members.map(pid) };
  if (Array.isArray(conv.lorebookIds)) conv.lorebookIds = conv.lorebookIds.map((id) => bookMap.get(id) || id).filter((id) => bookMap.has(id) || lorebooks.some((b) => b.id === id) || out.addLorebooks.some((b) => b.id === id));
  if (userPersonaId) conv.userPersonaId = userPersonaId;
  else delete conv.userPersonaId;
  delete conv.forkOf; // the chat it was forked from is not on this phone
  out.memories = (data.memories || []).map((m) => ({ ...scrub(m), id: ctx.newMemoryId(), conv: conv.id, ...(m.scope && map.has(m.scope) ? { scope: map.get(m.scope) } : {}) }));
  out.conv = conv;
  return out;
}
