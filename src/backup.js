// Backup & restore: one .zip with backup.json (chats, personas, memories, settings)
// and workspaces/<chatId>/<path> for every chat's sandbox files.
import { unzipSync, strToU8, strFromU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { conversations, workspaces, art, kvMove } from './store.js';
import { encodeValue, decodeValue, localEntries, putLocalEntries } from './movedata.js';
import { openZip, isGzip } from './zipread.js';
import { deleteWorkspace } from './sandbox.js';
import { isClaudeSignInCopy } from './claudesecrets.js';

const SECRET_KEYS = ['apiKey', 'exaKey', 'ghToken', 'microlinkKey', 'githubToken', 'githubRefresh', 'githubSshKey'];
/**
 * Settings without any key or token: the top-level ones, each provider's key, each MCP server's token, sign-in, extra
 * headers (where an API key goes) and the secret of its local bridge (decision 273: those two were exported as they
 * were).
 */
export function withoutSecrets(s) {
  SECRET_KEYS.forEach((k) => delete s[k]);
  if (Array.isArray(s.providers)) s.providers = s.providers.map((p) => ({ ...p, apiKey: '', adminKey: '' }));
  if (Array.isArray(s.mcpServers))
    s.mcpServers = s.mcpServers.map((m) => {
      const { token: _t, oauth: _o, headers: _h, bridgeSecret: _b, ...rest } = m; // the sign-in (access + refresh token) is a key too
      return rest;
    });
  // a PC agent's bridge secret; the phone's own Claude Code agent never stores one (claudecode.js)
  if (Array.isArray(s.acpAgents)) s.acpAgents = s.acpAgents.map(({ secret: _s, ...rest }) => rest);
  if (Array.isArray(s.pcFiles)) s.pcFiles = s.pcFiles.map(({ secret: _s, ...rest }) => rest); // Files on my PC (decision 223)
  return s;
}
export const BACKUP_VERSION = 1;
const freshSecret = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

const STORED = /\.(png|jpe?g|gif|webp|avif|zip|gz|7z|mp3|m4a|mp4|webm|pdf|woff2?)$/i; // already compressed: don't spend time on them
const CHUNK = 1024 * 1024;
/** zip dates must be 1980–2099: anything odd (0, seconds instead of ms, far future) becomes "now". */
const zipDate = (t) => {
  const d = new Date(Number(t) || Date.now());
  const y = d.getFullYear();
  return y >= 1980 && y <= 2099 ? d : new Date();
};
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

/**
 * The backup as a stream: the zip is written piece by piece to sink(Uint8Array) (about 1 MB at a time) and every
 * chat's files are read one at a time, so a big backup never has to fit in memory at once.
 * Returns { size, stats }.
 */
export async function streamBackup(settings, { includeKeys = false, everything = false, onProgress } = {}, sink) {
  const convs = await conversations.all();
  const s = JSON.parse(JSON.stringify(settings));
  // everything (to move to another app or phone, decision 218): the keys always, and the extras below
  if (!includeKeys && !everything) withoutSecrets(s);
  const data = { app: 'chronicle', version: BACKUP_VERSION, exportedAt: new Date().toISOString(), settings: s, conversations: convs, ...(everything ? { everything: true } : {}) };
  let pending = [];
  let pendingSize = 0;
  let size = 0;
  let failure = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else {
      pending.push(chunk);
      pendingSize += chunk.length;
    }
  });
  const flush = async (force = false) => {
    if (failure) throw failure;
    if (!pendingSize || (!force && pendingSize < CHUNK)) return;
    const out = concat(pending);
    pending = [];
    pendingSize = 0;
    size += out.length;
    await sink(out);
  };
  // the work runs on the screen's own thread: hand control back often so taps and scrolling keep working
  const breathe = () => new Promise((r) => setTimeout(r, 0));
  const SLICE = 256 * 1024;
  const add = async (name, bytes, { mtime } = {}) => {
    const f = STORED.test(name) ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    if (mtime) f.mtime = mtime;
    zip.add(f);
    // a big file goes in slices, with a breath between them (compressing 3 MB in one go freezes the app for a moment)
    for (let o = 0; o < bytes.length; o += SLICE) {
      f.push(bytes.subarray(o, Math.min(o + SLICE, bytes.length)), o + SLICE >= bytes.length);
      await flush();
      await breathe();
    }
    if (!bytes.length) {
      f.push(bytes, true);
      await flush();
    }
  };
  onProgress?.('Collecting chats…');
  await breathe();
  await add('backup.json', strToU8(JSON.stringify(data)));
  let files = 0;
  let leftOut = 0;
  const wsIds = await workspaces.ids();
  // what a zip entry cannot hold (or fflate does not read back): each file's mode, exec bit, exact date and writer
  const meta = {};
  for (const [n, id] of wsIds.entries()) {
    onProgress?.(`Saving files… ${n + 1} of ${wsIds.length} chats`);
    const w = await workspaces.get(id);
    for (const [path, f] of Object.entries(w?.files || {})) {
      // a copy of Claude Code's sign-in that reached a chat's files never goes into a backup, with keys or without
      if (isClaudeSignInCopy(path, f.data)) {
        leftOut++;
        continue;
      }
      await add(`workspaces/${id}/${path}`, f.data, { mtime: zipDate(f.mtime) });
      (meta[id] ||= {})[path] = { mtime: f.mtime || 0, ...(typeof f.mode === 'number' ? { mode: f.mode } : {}), ...(typeof f.exec === 'boolean' ? { exec: f.exec } : {}), ...(f.by ? { by: f.by } : {}) };
      files++;
    }
  }
  await add('workspaces.json', strToU8(JSON.stringify(meta)));
  try {
    onProgress?.('Saving pictures…');
    for (const id of await art.keys()) {
      const url = await art.read(id);
      if (url) await add(`art/${id}.txt`, strToU8(url));
    }
  } catch {
    /* no art */
  }
  let extras = 0;
  if (everything) {
    // each chat's git history and search index, and the app's own lists on this phone (usage, learned abilities)
    onProgress?.('Saving git histories and search indexes…');
    for (const k of await kvMove.keys().catch(() => [])) {
      const v = await kvMove.get(k).catch(() => null);
      if (v == null) continue;
      await add(`extra/kv/${encodeURIComponent(k)}.json`, strToU8(encodeValue(v)));
      extras++;
    }
    await add('extra/local.json', strToU8(JSON.stringify(localEntries())));
  }
  zip.end();
  await flush(true);
  return { size, stats: { chats: convs.length, personas: (s.personas || []).length, memories: (s.memories || []).length, files, ...(everything ? { extras } : {}), ...(leftOut ? { signInCopiesLeftOut: leftOut } : {}) } };
}

/** The whole backup in memory (small backups, tests). */
export async function buildBackup(settings, opts = {}) {
  const parts = [];
  const { stats } = await streamBackup(settings, opts, (c) => void parts.push(c));
  return { zip: concat(parts), stats };
}

export function readBackup(bytes) {
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('This is not a valid backup file');
  }
  if (!entries['backup.json']) throw new Error('backup.json is missing – not a Chronicle backup');
  const data = JSON.parse(strFromU8(entries['backup.json']));
  // backups made before the rename (as "opencode-mobile") restore too: that is how data moves to the new app id
  if (data.app !== 'chronicle' && data.app !== 'opencode-mobile') throw new Error('Not a Chronicle backup');
  let meta = null;
  try {
    meta = entries['workspaces.json'] ? JSON.parse(strFromU8(entries['workspaces.json'])) : null;
  } catch {
    /* a damaged list: the files still come back, with today's date */
  }
  const ws = {};
  for (const [name, d] of Object.entries(entries)) {
    const m = name.match(/^workspaces\/([^/]+)\/(.+)$/);
    if (!m || name.endsWith('/')) continue;
    (ws[m[1]] ||= Object.create(null))[m[2]] = wsFile(meta, m[1], m[2], d);
  }
  const artFiles = {};
  for (const [name, d] of Object.entries(entries)) {
    const m = name.match(/^art\/([^/]+)\.txt$/);
    if (m) artFiles[m[1]] = strFromU8(d);
  }
  // "Export everything": git histories, search indexes, the app's own lists (decision 218)
  const kv = {};
  let local = null;
  for (const [name, d] of Object.entries(entries)) {
    const m = name.match(/^extra\/kv\/(.+)\.json$/);
    if (m) kv[decodeURIComponent(m[1])] = strFromU8(d);
  }
  try {
    if (entries['extra/local.json']) local = JSON.parse(strFromU8(entries['extra/local.json']));
  } catch {
    /* damaged: left out */
  }
  return { data, ws, art: artFiles, ...(meta ? { meta } : {}), ...(Object.keys(kv).length || local ? { extra: { kv, local } } : {}) };
}

/** A workspace file from the zip, with its mode, exec bit, date and writer from workspaces.json. */
function wsFile(meta, id, path, d) {
  const k = Object.hasOwn(meta || {}, id) && Object.hasOwn(meta[id] || {}, path) ? meta[id][path] : {};
  const f = { data: d, mtime: k.mtime > 0 ? k.mtime : Date.now() };
  if (typeof k.mode === 'number') (f.mode = k.mode & 0o777), (f.exec = (f.mode & 0o111) !== 0);
  else if (typeof k.exec === 'boolean') f.exec = k.exec;
  if (typeof k.by === 'string') f.by = k.by;
  return f;
}

/**
 * A backup read straight from its file, one entry at a time (decision 220): only backup.json, the file list, pictures
 * and the small extras are read now; each chat's files when that chat is restored – a big "Export everything" no
 * longer has to fit in memory twice. ws is then a function (chat id → its files). Throws with the real reason.
 */
export async function readBackupFile(blob) {
  if (await isGzip(blob)) throw new Error('That is the Linux home archive (.tar.gz): bring it back with 🐧 Import Linux home… (after setting up Linux). Restore takes the .zip.');
  let z;
  try {
    z = await openZip(blob);
  } catch (e) {
    throw new Error(`This is not a backup zip – ${e.message}`);
  }
  if (!z.has('backup.json')) throw new Error('backup.json is missing – not a Chronicle backup');
  let data;
  try {
    data = JSON.parse(strFromU8(await z.get('backup.json')));
  } catch (e) {
    throw new Error(`The backup's backup.json could not be read (${e.message})`);
  }
  // backups made before the rename (as "opencode-mobile") restore too: that is how data moves to the new app id
  if (data.app !== 'chronicle' && data.app !== 'opencode-mobile') throw new Error('Not a Chronicle backup');
  let meta = null;
  try {
    meta = z.has('workspaces.json') ? JSON.parse(strFromU8(await z.get('workspaces.json'))) : null;
  } catch {
    /* a damaged list: the files still come back, with today's date */
  }
  const byChat = new Map();
  const artFiles = {};
  const kv = {};
  let local = null;
  // a file damaged in the zip (a checksum that does not match) is left out and named, the rest still comes back
  const damaged = [];
  const getOr = async (name) => {
    try {
      return await z.get(name);
    } catch (e) {
      damaged.push(e.message);
      return null;
    }
  };
  for (const name of z.names) {
    let m = name.match(/^workspaces\/([^/]+)\/(.+)$/);
    if (m) {
      if (!byChat.has(m[1])) byChat.set(m[1], []);
      byChat.get(m[1]).push(m[2]);
      continue;
    }
    m = name.match(/^art\/([^/]+)\.txt$/);
    if (m) {
      const d = await getOr(name);
      if (d) artFiles[m[1]] = strFromU8(d);
      continue;
    }
    m = name.match(/^extra\/kv\/(.+)\.json$/);
    if (m) kv[decodeURIComponent(m[1])] = () => getOr(name).then((d) => (d ? strFromU8(d) : null)); // read when it is put back
  }
  try {
    if (z.has('extra/local.json')) local = JSON.parse(strFromU8(await z.get('extra/local.json')));
  } catch {
    /* damaged: left out */
  }
  const ws = async (id) => {
    const paths = byChat.get(id);
    if (!paths) return null;
    const files = Object.create(null);
    for (const path of paths) {
      const d = await getOr(`workspaces/${id}/${path}`);
      if (d) files[path] = wsFile(meta, id, path, d);
    }
    return files;
  };
  return { data, ws, wsCount: byChat.size, damaged, art: artFiles, ...(meta ? { meta } : {}), ...(Object.keys(kv).length || local ? { extra: { kv, local } } : {}) };
}

/**
 * Apply a parsed backup. mode 'merge' keeps everything on the phone and adds what's missing
 * (newer copy of a chat wins); 'replace' wipes chats and settings first (keeping the current
 * API keys if the backup has none). Returns { settings, stats }.
 */
/** Same memory on both sides: the more recently edited one wins. Memories only one side has are all kept. */
export function mergeMemories(mine = [], theirs = []) {
  const ms = new Map(mine.map((m) => [m.id, m]));
  for (const m of theirs) {
    const cur = ms.get(m.id);
    if (!cur || (m.updatedAt || 0) > (cur.updatedAt || 0)) ms.set(m.id, m);
  }
  return [...ms.values()];
}

export async function applyBackup({ data, ws, art: artFiles = {}, extra = null, damaged = null }, mode, current) {
  const b = data.settings || {};
  let settings;
  if (mode === 'replace') {
    settings = { ...b };
    SECRET_KEYS.forEach((k) => {
      if (!settings[k] && current[k]) settings[k] = current[k];
    });
    // a backup made without keys: the keys already on this phone stay with their providers and servers
    const keyOf = new Map((current.providers || []).map((p) => [p.id, p.apiKey]));
    const adminOf = new Map((current.providers || []).map((p) => [p.id, p.adminKey]));
    settings.providers = (settings.providers || []).map((p) => (p.apiKey || !keyOf.get(p.id) ? p : { ...p, apiKey: keyOf.get(p.id) })).map((p) => (p.adminKey || !adminOf.get(p.id) ? p : { ...p, adminKey: adminOf.get(p.id) }));
    const mcpOf = new Map((current.mcpServers || []).map((m) => [m.id, m]));
    const acpOf = new Map((current.acpAgents || []).map((a) => [a.id, a.secret]));
    if (Array.isArray(settings.acpAgents)) settings.acpAgents = settings.acpAgents.map((a) => (a.secret || !acpOf.get(a.id) ? a : { ...a, secret: acpOf.get(a.id) }));
    const pcOf = new Map((current.pcFiles || []).map((a) => [a.id, a.secret]));
    if (Array.isArray(settings.pcFiles)) settings.pcFiles = settings.pcFiles.map((a) => (a.secret || !pcOf.get(a.id) ? a : { ...a, secret: pcOf.get(a.id) }));
    settings.mcpServers = (settings.mcpServers || []).map((m) => (m.token || m.oauth || !mcpOf.get(m.id) ? m : { ...m, ...(mcpOf.get(m.id).token ? { token: mcpOf.get(m.id).token } : {}), ...(mcpOf.get(m.id).oauth ? { oauth: mcpOf.get(m.id).oauth } : {}) }));
    // the headers too (decision 273) – unless the backup has its own
    settings.mcpServers = settings.mcpServers.map((m) => (m.headers || !mcpOf.get(m.id)?.headers ? m : { ...m, headers: mcpOf.get(m.id).headers }));
    // every chat goes: its shell copy and its line in the Files page's index too (a restored chat of the same id
    // would otherwise get the old shell files back with its first command)
    for (const id of await workspaces.ids()) await deleteWorkspace(id);
    await conversations.clear();
    await workspaces.clear();
  } else {
    settings = { ...current };
    const byId = (list) => new Map((list || []).map((x) => [x.id, x]));
    const ps = byId(current.personas);
    for (const p of b.personas || []) if (!ps.has(p.id)) ps.set(p.id, p);
    settings.personas = [...ps.values()];
    settings.memories = mergeMemories(current.memories, b.memories);
    for (const key of ['snippets', 'lorebooks', 'skills', 'mcpServers']) {
      const map = byId(current[key]);
      for (const x of b[key] || []) if (!map.has(x.id)) map.set(x.id, x);
      settings[key] = [...map.values()];
    }
    SECRET_KEYS.forEach((k) => {
      if (!settings[k] && b[k]) settings[k] = b[k];
    });    // edited prompts: keep yours, add any you haven't changed
    if (b.prompts) settings.prompts = { ...b.prompts, ...(current.prompts || {}) };
  }
  // a local (stdio) MCP server's bridge secret is not in a backup without keys (decision 273): the one on this phone
  // stays, or the server gets a new one (it is only between the app and the bridge it starts)
  if (Array.isArray(settings.mcpServers)) {
    const bridgeOf = new Map((current.mcpServers || []).map((m) => [m.id, m.bridgeSecret]));
    settings.mcpServers = settings.mcpServers.map((m) => (m.transport !== 'stdio' || m.bridgeSecret ? m : { ...m, bridgeSecret: bridgeOf.get(m.id) || freshSecret() }));
  }
  const existing = new Map((await conversations.all()).map((c) => [c.id, c]));
  let added = 0;
  for (const c of data.conversations || []) {
    const cur = existing.get(c.id);
    if (cur && (cur.updatedAt || 0) >= (c.updatedAt || 0)) continue;
    await conversations.put(c);
    // ws: the files of every chat (a backup read whole), or a function that reads one chat's files from the file
    const files = typeof ws === 'function' ? await ws(c.id) : ws[c.id];
    if (files) {
      await deleteWorkspace(c.id); // the old files, the shell's copy of them and the index line, then the backup's
      await workspaces.put({ id: c.id, files });
    }
    added++;
  }
  for (const [id, url] of Object.entries(artFiles)) {
    if (mode === 'replace' || !(await art.get(id))) await art.put(id, url).catch(() => {});
  }
  // the extras of "Export everything": a chat's git history and index come back with the chat (decision 218)
  let extras = 0;
  if (extra) {
    const restored = new Set((data.conversations || []).map((c) => c.id));
    for (const [k, v] of Object.entries(extra.kv || {})) {
      const m = /^(git|vec):(.+)$/.exec(k);
      if (!m || !restored.has(m[2])) continue;
      if (mode !== 'replace' && (await kvMove.get(k).catch(() => null)) != null) continue;
      try {
        const text = typeof v === 'function' ? await v() : v;
        if (text == null) continue; // damaged in the zip: named in the restore's report
        await kvMove.put(k, decodeValue(text));
        extras++;
      } catch {
        /* one damaged entry: the rest still come back */
      }
    }
    if (extra.local) extras += putLocalEntries(extra.local);
  }
  return { settings, stats: { chats: added, personas: (settings.personas || []).length, memories: (settings.memories || []).length, ...(extra ? { extras } : {}), ...(damaged?.length ? { damaged: [...damaged] } : {}) } };
}
