// Per-chat workspace (files) + the Pyodide Python sandbox that works on it.
import { workspaces } from './store.js';
import { forgetChat } from './shellfs.js';
import { conflictName } from './mirror.js';

export const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

export const cleanPath = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/?workspace(\/|$)/, '')
    .split('/')
    .filter((x) => x && x !== '.' && x !== '..')
    .join('/');

// ---------- workspace (in memory + IndexedDB) ----------
const cache = new Map(); // convId -> { id, files }

/**
 * A map keyed by file names: no prototype, so a file called __proto__ is a file (not the map's prototype, which made
 * names like "data" or "mtime" look like files) and constructor or toString are not there until written.
 */
export const fileMap = (o) => (o && Object.getPrototypeOf(o) === null ? o : Object.assign(Object.create(null), o || {}));
/** obj[key] = value, also for __proto__ on an ordinary object (a workspace made by hand, a test's). */
export function setKey(obj, key, value) {
  if (key === '__proto__' && Object.getPrototypeOf(obj) !== null) Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  else obj[key] = value;
}

// What each workspace was when it was last saved: its files (the objects – a file is replaced, never changed in place)
// and its checkpoints. A save writes only what differs (decision 259); one never saved apart is written whole once.
const savedAs = new WeakMap();
const snapOf = (w) => ({ files: new Map(Object.entries(w.files)), ck: w.checkpoints });

// The workspaces kept in memory: the newest few used. One that is open on screen, running, saving or in the Python
// sandbox stays; the others are let go (each held every file of its chat for the whole session, decision 259).
const KEEP = 6;
let busy = () => false;
const onDrop = new Set();
/** fn(convId) → true while that chat's workspace must stay in memory (on screen, a reply running). */
export const setWorkspaceBusy = (fn) => (busy = fn);
/** fn(convId) after a workspace was let go from memory (a copy kept elsewhere should go too). */
export const onWorkspaceDropped = (fn) => onDrop.add(fn);
const loading = new Map();
function trimCache() {
  for (const [id] of cache) {
    if (cache.size <= KEEP) break;
    if (saveTimers[id] || saving.has(id) || sandbox.convId === id || busy(id)) continue;
    cache.delete(id);
    for (const fn of onDrop) fn(id);
  }
}

export async function getWorkspace(convId) {
  if (cache.has(convId)) {
    const w = cache.get(convId);
    cache.delete(convId); // the newest used goes last
    cache.set(convId, w);
    return w;
  }
  if (loading.has(convId)) return loading.get(convId); // two asking at once get the same one
  const p = (async () => {
    const rec = await workspaces.get(convId).catch(() => null);
    if (cache.has(convId)) return cache.get(convId);
    const w = rec || { id: convId, files: {} };
    w.files = fileMap(w.files);
    if (w.shellState) w.shellState = fileMap(w.shellState);
    if (w.phoneState) w.phoneState = { in: fileMap(w.phoneState.in), out: fileMap(w.phoneState.out) };
    if (rec?.stored === 'split') savedAs.set(w, snapOf(w));
    cache.set(convId, w);
    trimCache();
    return w;
  })();
  loading.set(convId, p);
  try {
    return await p;
  } finally {
    loading.delete(convId);
  }
}

// ---------- a small index of every workspace (count, size, newest change, the file list without bytes) ----------
// The files page lists all chats from this instead of reading every workspace with all its bytes from the database.
const SUM_KEY = 'ocm.wsSummary';
let sums = null;
const readSums = () => {
  if (sums) return sums;
  try {
    sums = JSON.parse(localStorage.getItem(SUM_KEY) || '{}') || {};
  } catch {
    sums = {};
  }
  return sums;
};
let sumTimer = null;
const writeSums = () => {
  clearTimeout(sumTimer);
  sumTimer = setTimeout(() => {
    try {
      localStorage.setItem(SUM_KEY, JSON.stringify(sums));
    } catch {
      /* full or blocked: it is rebuilt from the database next time */
    }
  }, 500);
};
/** The file list of a workspace without the bytes: [{ path, size, mtime }]. */
export const wsListing = (w) => Object.entries(w?.files || {}).map(([path, f]) => ({ path, size: f.data?.byteLength || 0, mtime: f.mtime || 0 }));
function summarize(w) {
  const files = wsListing(w);
  readSums()[w.id] = { n: files.length, size: files.reduce((t, f) => t + f.size, 0), mtime: files.reduce((t, f) => Math.max(t, f.mtime), 0) };
  writeSums();
  return files;
}
const listings = new Map(); // id -> file list, for searching every chat without keeping their bytes in memory
/**
 * Every workspace with files: [{ id, n, size, mtime }] (from the index; ones it lacks are read once and added).
 */
export async function workspaceSummaries() {
  const s = readSums();
  const ids = await workspaces.ids();
  const known = new Set(ids);
  for (const id of cache.keys()) known.add(id);
  let changed = false;
  for (const id of Object.keys(s)) if (!known.has(id)) (delete s[id], (changed = true));
  for (const id of known) {
    if (cache.has(id)) {
      listings.set(id, summarize(cache.get(id)));
      continue;
    }
    if (s[id]) continue;
    const w = await workspaces.get(id).catch(() => null); // read once, not kept: only its summary is
    listings.set(id, summarize(w || { id, files: {} }));
    changed = true;
  }
  if (changed) writeSums();
  return [...known].map((id) => ({ id, ...s[id] })).filter((x) => x.n > 0);
}
/** The file list of one workspace (no bytes kept for ones that are not open). */
export async function workspaceListing(id) {
  if (cache.has(id)) return wsListing(cache.get(id));
  if (listings.has(id)) return listings.get(id);
  const w = await workspaces.get(id).catch(() => null);
  const l = summarize(w || { id, files: {} });
  listings.set(id, l);
  return l;
}

let saveTimers = {};
const saving = new Set();
// a save copies the changed files on the screen's thread (all of them, the first time): it waits while you type (decision
// 244), at most 15 s
let lastKey = -1e9;
if (typeof addEventListener === 'function') for (const ev of ['keydown', 'input']) addEventListener(ev, () => (lastKey = Date.now()), { capture: true, passive: true });
const TYPING_QUIET = 1500;
const TYPING_MAX = 15000;
export function saveWorkspace(w) {
  clearTimeout(saveTimers[w.id]);
  listings.delete(w.id);
  const first = Date.now();
  // the summary walks every file: once per burst of writes, not once per file (20,000 files copied in took
  // minutes when each write summarised the whole workspace again)
  const go = () => {
    if (Date.now() - lastKey < TYPING_QUIET && Date.now() - first < TYPING_MAX) return (saveTimers[w.id] = setTimeout(go, 500));
    delete saveTimers[w.id];
    summarize(w);
    const now = snapOf(w);
    const was = savedAs.get(w);
    let job;
    if (!was) job = workspaces.put(w);
    else {
      const put = [];
      for (const [p, f] of now.files) if (was.files.get(p) !== f) put.push(p);
      const del = [];
      for (const p of was.files.keys()) if (!now.files.has(p)) del.push(p);
      job = workspaces.putChanged(w, { put, del, ck: was.ck !== now.ck });
    }
    saving.add(w.id);
    job
      .then(() => savedAs.set(w, now))
      .catch((e) => console.warn('workspace not saved', w.id, e))
      .finally(() => {
        saving.delete(w.id);
        trimCache();
      });
  };
  saveTimers[w.id] = setTimeout(go, 300);
}

export async function deleteWorkspace(convId) {
  clearTimeout(saveTimers[convId]); // a save still waiting would bring it back
  cache.delete(convId);
  listings.delete(convId);
  delete readSums()[convId];
  writeSums();
  if (sandbox.convId === convId) sandbox.kill();
  await workspaces.remove(convId).catch(() => {});
  await forgetChat(convId).catch(() => {}); // the shell's copy: or the next command there brings every file back
}

/** The permission bits of an entry, when they are known. */
const modeOf = (f) => (typeof f?.mode === 'number' ? { mode: f.mode & 0o777 } : {});

const sameBytes = (a, b) => !!a && !!b && a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);
/**
 * What a Python run wrote, into the chat's files (decision 188). Python works on its own copy, so a file changed
 * elsewhere while it ran (Claude Code, the user, another job – brought in by a sync) would be written over silently by
 * Python's version. Such a file is a conflict, as in a sync: the newer write is the file, the other is kept beside it as
 * <name>.conflict-other.<ext>; a file Python deleted that was changed meanwhile is kept. atStart: the files (objects)
 * when the run began. → the conflicts, [{ path, kept, winner: 'python' | 'other', deleted? }]
 */
export function applyPython(w, changed, deleted, atStart) {
  const conflicts = [];
  for (const c of changed || []) {
    const mine = { data: new Uint8Array(c.data), mtime: c.mtime > 0 && c.mtime <= Date.now() + 60000 ? c.mtime : Date.now(), exec: !!c.exec, by: 'python', ...modeOf(c) };
    const cur = w.files[c.path];
    const was = atStart?.get(c.path);
    // really changed meanwhile: another file object with other bytes than at the start (a copy of the same bytes is not)
    if (cur && atStart && cur !== was && !sameBytes(cur.data, was?.data) && !sameBytes(cur.data, mine.data)) {
      const pyNewer = mine.mtime >= (cur.mtime || 0);
      const kept = conflictName(c.path, (n) => !!w.files[n]);
      setKey(w.files, kept, pyNewer ? cur : mine);
      setKey(w.files, c.path, pyNewer ? mine : cur);
      conflicts.push({ path: c.path, kept, winner: pyNewer ? 'python' : 'other' });
    } else setKey(w.files, c.path, mine);
  }
  for (const d of deleted || []) {
    const cur = w.files[d];
    if (cur && atStart && cur !== atStart.get(d) && !sameBytes(cur.data, atStart.get(d)?.data)) conflicts.push({ path: d, kept: '', winner: 'other', deleted: true });
    else delete w.files[d];
  }
  return conflicts;
}
/** The conflicts of a Python run, for its tool result. */
export const conflictText = (list) =>
  (list || [])
    .map((c) =>
      c.deleted
        ? `CONFLICT: ${c.path} was changed elsewhere while this Python ran, so its delete was not done – the file is kept`
        : `CONFLICT: ${c.path} was changed elsewhere while this Python ran – ${c.winner === 'python' ? "Python's write is newer and is the file now; the other version" : "the other write is newer and stays the file; Python's version"} is kept as ${c.kept}`,
    )
    .join('\n');

/**
 * The permission bits a write should leave behind: an explicit mode wins; an explicit exec bit adjusts
 * the old mode (or starts from 755/644 when there is none); a write that says nothing keeps what the
 * file had, so a chmod in the shell survives the next edit in the app.
 */
function nextMode(prev, opts) {
  if (typeof opts.mode === 'number') return opts.mode & 0o777;
  if (typeof opts.exec !== 'boolean') return typeof prev === 'number' ? prev & 0o777 : undefined;
  const base = typeof prev === 'number' ? prev & 0o777 : opts.exec ? 0o755 : 0o644;
  if (opts.exec === ((base & 0o111) !== 0)) return base;
  return opts.exec ? base | 0o111 : base & ~0o111;
}

export function wsPut(w, path, data, opts = {}) {
  // exact: the path is already a workspace key (the mirror's, taken from the shell's own listing). cleanPath is for
  // what a model or a person typed: it would turn the shell's workspace/a.txt into a.txt and write over that file.
  const p = opts.exact ? String(path || '') : cleanPath(path);
  if (!p) throw new Error('Invalid path');
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  // the mode (and the exec bit it implies) is part of the file. An edit that says nothing about it
  // keeps it, so rewriting a shell script from the app cannot quietly make it non-executable.
  const mode = nextMode(w.files[p]?.mode, opts);
  const exec = typeof mode === 'number' ? (mode & 0o111) !== 0 : opts.exec === undefined ? !!w.files[p]?.exec : !!opts.exec;
  setKey(w.files, p, { data: bytes, mtime: opts.mtime > 0 ? opts.mtime : Date.now(), exec, by: opts.by || 'the app', ...(typeof mode === 'number' ? { mode } : {}) });
  saveWorkspace(w);
  if (sandbox.convId === w.id) sandbox.write([{ path: p, data: bytes, exec, mtime: w.files[p].mtime, ...(typeof mode === 'number' ? { mode } : {}) }]);
  return p;
}

/**
 * A new file name for a capture under `stem`: <stem>-<n>.<ext> (or <stem>.<ext> for the first one when `bare`).
 * The number only goes up within a chat – it is kept on the workspace and is never lower than any capture
 * still there – so a picture that was moved, deleted or undone never hands its name to a different picture,
 * and an earlier result's "Saved as …" keeps meaning that picture.
 */
export function shotName(w, stem, ext = 'jpg', { bare = false } = {}) {
  const re = new RegExp('^' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:-(\\d+))?\\.(?:jpe?g|png)$');
  let top = (w.shotSeq ||= {})[stem] || 0;
  for (const p of Object.keys(w.files)) {
    const m = re.exec(p);
    if (m) top = Math.max(top, m[1] ? Number(m[1]) : 1);
  }
  let n = top + 1;
  while (w.files[n === 1 && bare ? `${stem}.${ext}` : `${stem}-${n}.${ext}`]) n++;
  w.shotSeq[stem] = n;
  return n === 1 && bare ? `${stem}.${ext}` : `${stem}-${n}.${ext}`;
}

export function wsDelete(w, path, { exact = false } = {}) {
  const p = exact ? String(path || '') : cleanPath(path);
  delete w.files[p];
  saveWorkspace(w);
  if (sandbox.convId === w.id) sandbox.remove([p]);
}

// ---------- checkpoints: undo what an agent turn did to the files ----------
// Files are replaced, never edited in place, so a snapshot is just the old map of references.
export const snapshotFiles = (w) => ({ ...w.files });
const MAX_CHECKPOINTS = 12;
const MAX_CHECKPOINT_BYTES = 60 * 1024 * 1024;

/** Compare the workspace with the snapshot taken before a turn; keep what changed so it can be undone. */
export function recordCheckpoint(w, before, extra = {}) {
  const changes = [];
  for (const p of new Set([...Object.keys(before), ...Object.keys(w.files)])) {
    const b = before[p] || null;
    const a = w.files[p] || null;
    if (b !== a) changes.push({ path: p, before: b, kind: !b ? 'created' : !a ? 'deleted' : 'changed' });
  }
  const phone = (extra.phone || []).filter(Boolean);
  if (!changes.length && !phone.length) return null;
  const ck = { id: 'ck_' + Math.random().toString(36).slice(2, 10), at: Date.now(), changes, ...(phone.length ? { phone, folder: extra.folder || null } : {}) };
  w.checkpoints = [ck, ...(w.checkpoints || [])];
  let bytes = 0;
  w.checkpoints = w.checkpoints.filter((c, i) => {
    bytes += c.changes.reduce((n, x) => n + (x.before?.data?.byteLength || 0), 0) + (c.phone || []).reduce((n, x) => n + (x.before?.byteLength || 0), 0);
    return i < MAX_CHECKPOINTS && (i === 0 || bytes <= MAX_CHECKPOINT_BYTES);
  });
  saveWorkspace(w);
  return ck;
}

/** Put every file of that turn back as it was before. Returns { restored, removed } or null if the checkpoint is gone. */
/**
 * Everything the checkpoints still remember, as one set of changes: for each file, how it was before the OLDEST
 * checkpoint that touched it, against how it is now. → [{ path, before, kind }] (unchanged files left out)
 */
export function sessionChanges(w) {
  const first = new Map();
  for (const ck of [...(w.checkpoints || [])].reverse()) for (const c of ck.changes) if (!first.has(c.path)) first.set(c.path, c.before || null);
  const out = [];
  for (const [path, before] of first) {
    const now = w.files[path] || null;
    if (!before && !now) continue; // made and deleted again
    if (before && now && before.data.byteLength === now.data.byteLength && before.data.every((b, i) => b === now.data[i])) continue; // back to how it was
    out.push({ path, before, kind: !before ? 'created' : !now ? 'deleted' : 'changed' });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function undoCheckpoint(w, id) {
  const ck = (w.checkpoints || []).find((c) => c.id === id);
  if (!ck) return null;
  let restored = 0;
  let removed = 0;
  const write = [];
  const gone = [];
  for (const c of ck.changes) {
    if (c.before) {
      setKey(w.files, c.path, c.before);
      write.push({ path: c.path, data: c.before.data, exec: !!c.before.exec, ...modeOf(c.before) });
      restored++;
    } else {
      delete w.files[c.path];
      gone.push(c.path);
      removed++;
    }
  }
  w.checkpoints = w.checkpoints.filter((c) => c.id !== id);
  saveWorkspace(w);
  const phone = ck.phone || [];
  if (sandbox.convId === w.id) {
    if (write.length) sandbox.write(write);
    if (gone.length) sandbox.remove(gone);
  }
  return { restored, removed, phone, folder: ck.folder || null };
}

/** Add phone-folder changes (applied after the turn, e.g. once the user accepted them) to a checkpoint, creating one if the turn changed no workspace files. */
export function addPhoneLog(w, ckId, entries, folder) {
  let ck = (w.checkpoints || []).find((c) => c.id === ckId);
  if (!ck) {
    ck = { id: 'ck_' + Math.random().toString(36).slice(2, 10), at: Date.now(), changes: [] };
    w.checkpoints = [ck, ...(w.checkpoints || [])].slice(0, MAX_CHECKPOINTS);
  }
  ck.phone = [...(ck.phone || []), ...entries];
  ck.folder = folder || ck.folder || null;
  saveWorkspace(w);
  return ck;
}

export const wsList = (w) => Object.entries(w.files).map(([path, f]) => ({ path, size: f.data.byteLength, mtime: f.mtime }));

export function looksText(bytes) {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}
export const bytesToText = (b) => dec.decode(b);

// ---------- Python sandbox (one worker, bound to one chat at a time) ----------
class PySandbox {
  constructor() {
    this.worker = null;
    this.convId = null;
    this.ready = null;
    this.pending = new Map();
    this.onStatus = null;
    // one run at a time: the worker holds one chat's files, and switching chats restarts it – a second chat's run
    // used to kill the first one mid-way. Runs wait their turn; Stop cancels only the run(s) of its own chat.
    this.queue = Promise.resolve();
    this.jobs = new Set();
    this.busyWith = null;
  }

  async ensure(w) {
    if (this.worker && this.convId === w.id) return this.ready;
    this.kill();
    this.convId = w.id;
    this.worker = new Worker('py-worker.js', { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') resolve();
        else if (m.type === 'fatal') reject(new Error(m.error));
        else if (m.type === 'status') this.onStatus?.(m.text);
        else if (m.type === 'wrote' || m.type === 'gone') this.pending.get(m.id)?.live?.(m);
        else if (m.type === 'result') {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            p.resolve(m);
          }
        }
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'Python failed to start'));
    });
    const files = Object.entries(w.files).map(([path, f]) => ({ path, data: f.data, exec: !!f.exec, ...modeOf(f), ...(f.mtime ? { mtime: f.mtime } : {}) }));
    this.worker.postMessage({ type: 'init', indexURL: PYODIDE_URL, files });
    return this.ready;
  }

  write(files) {
    this.worker?.postMessage({ type: 'write', files });
  }

  remove(paths) {
    this.worker?.postMessage({ type: 'delete', paths });
  }

  /**
   * Run code in the workspace, after any run already going. owner: the chat (for cancel); signal: stops this run (a
   * cancelled ask_model job). Rejects on timeout or Stop – keeping the files the run had finished writing until then
   * (decision 183): the error's `kept` lists them.
   */
  run(w, code, { timeoutMs = 120000, onStatus, owner = null, signal = null } = {}) {
    const job = { owner, cancelled: false, stop: null };
    this.jobs.add(job);
    const onAbort = () => {
      job.cancelled = true;
      job.stop?.();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    if (this.busyWith && this.busyWith !== owner) onStatus?.('waiting for Python (it is busy in another chat)…');
    const p = this.queue.then(() => {
      if (job.cancelled) throw new Error('Stopped');
      this.busyWith = owner;
      return this._run(w, code, { timeoutMs, onStatus }, job);
    });
    this.queue = p.catch(() => {});
    p.finally(() => {
      signal?.removeEventListener('abort', onAbort);
      this.jobs.delete(job);
      if (!this.jobs.size) this.busyWith = null;
    }).catch(() => {});
    return p;
  }

  /** Stop the runs of one chat (all runs when owner is left out). */
  cancel(owner) {
    for (const j of this.jobs)
      if (owner == null || j.owner === owner) {
        j.cancelled = true;
        j.stop?.();
      }
  }

  async _run(w, code, { timeoutMs, onStatus }, job) {
    this.onStatus = onStatus;
    await this.ensure(w);
    const id = Math.random().toString(36).slice(2);
    if (job.cancelled) throw new Error('Stopped');
    // what the run has finished writing so far (the worker sends it as it goes): kept if the run is stopped
    const wrote = new Map(); // path -> file, or null when it deleted the file
    const atStart = new Map(Object.entries(w.files)); // what the files were when it began (a change since is someone else's)
    const keep = () => {
      const changed = [...wrote].filter(([, c]) => c).map(([, c]) => c);
      const deleted = [...wrote].filter(([, c]) => !c).map(([p]) => p);
      const conflicts = applyPython(w, changed, deleted, atStart);
      this.resync(w, conflicts);
      if (wrote.size) saveWorkspace(w);
      return [...[...wrote].map(([path, c]) => (c ? path : `${path} (deleted)`)), ...conflicts.map((c) => `${c.path} (CONFLICT – the other version is kept as ${c.kept || c.path})`)];
    };
    const stopped = (msg) => {
      const kept = keep();
      return Object.assign(new Error(msg + (kept.length ? ` It had already written ${kept.length} file${kept.length === 1 ? '' : 's'}, kept: ${kept.slice(0, 20).join(', ')}${kept.length > 20 ? ', …' : ''}.` : ' It had not finished writing any file yet.')), { kept });
    };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        reject(stopped(`Timed out after ${Math.round(timeoutMs / 1000)}s (the sandbox was restarted).`));
      }, timeoutMs);
      this.pending.set(id, {
        live: (m) => wrote.set(m.path, m.type === 'wrote' ? m : null),
        resolve: (m) => {
          clearTimeout(t);
          // sync changes back into the workspace
          m.conflicts = applyPython(w, m.changed, m.deleted, atStart);
          this.resync(w, m.conflicts);
          if ((m.changed || []).length || (m.deleted || []).length) saveWorkspace(w);
          resolve(m);
        },
      });
      job.stop = () => {
        clearTimeout(t);
        this.pending.delete(id);
        this.kill();
        reject(stopped('Stopped: the Python run was ended mid-way.'));
      };
      this.worker.postMessage({ type: 'run', id, code });
    });
  }

  /** After a conflict, Python's own copy of those files is put back in line with the chat's (the file and the kept one). */
  resync(w, conflicts) {
    if (!conflicts?.length || this.convId !== w.id) return;
    const files = [];
    for (const c of conflicts)
      for (const p of [c.path, c.kept]) {
        const f = p && w.files[p];
        if (f) files.push({ path: p, data: f.data, exec: !!f.exec, ...modeOf(f), ...(f.mtime ? { mtime: f.mtime } : {}) });
      }
    if (files.length) this.write(files);
  }

  kill() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.convId = null;
    this.ready = null;
    for (const p of this.pending.values()) p.resolve({ error: 'Sandbox restarted', stdout: '', stderr: '', changed: [], deleted: [] });
    this.pending.clear();
  }
}

export const sandbox = new PySandbox();
