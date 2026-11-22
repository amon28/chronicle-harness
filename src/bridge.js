// The edge between surfaces. The shell's /workspace is a real directory under the app's files dir,
// bound into proot; /phone is the linked phone folder, bound when Android gives us a path and mirrored
// otherwise. Both are reconciled by hash and identity, not copied blind: a file deleted on either side
// is deleted on the other, and a file that cannot cross is remembered as refused instead of retried.
import { wsPut, wsDelete, saveWorkspace, sandbox, fileMap } from './sandbox.js';
import { listFolder, readPhoneFile, folderLocalPath, exportLinuxFile, canExportLinux, copyIntoShell, canCopyIntoShell } from './phonefolder.js';
import { saveToPhone } from './phonetools.js';
import { sha256Hex } from './hash.js';
import { reconcile } from './mirror.js';
import * as fs from './shellfs.js';

export const WORK = '/workspace';
export const PHONE = '/phone';

/** One home per artifact; everything else is a cache. These are the cache's limits. */
export const LIMITS = {
  // The workspace is memory (a wasm heap capped at 256 MB), so a crossing costs about the file's
  // size in heap on both sides of the bridge. 32 MiB measured fine; 64 MiB ran the heap out and
  // used to leave a zero-byte file behind, which is why writes are chunked and atomic now.
  fileBytes: 32 * 1024 * 1024, // one file in or out of the shell
  totalBytes: 128 * 1024 * 1024, // per command
  phoneFiles: 2000, // how deep to walk the linked folder
  phoneFile: 32 * 1024 * 1024,
};

/** A big file changed this recently is still being written (a recording): it is saved once it stops changing. */
const GROWING_MS = 15000;
const MB = (n) => (n / 1048576).toFixed(1) + ' MB';
export const workDir = fs.workDir;
const phoneDir = fs.phoneDir;

const hashCache = new WeakMap(); // File object -> sha256 (wsPut replaces the object, so this cannot go stale)
async function fileHash(f) {
  let h = hashCache.get(f);
  if (!h) {
    h = await sha256Hex(f.data);
    hashCache.set(f, h);
  }
  return h;
}

// the mtime decides a first meeting (no agreement yet): without it the shell's copy always looked newer
const memoryEntry = async (f) => ({ size: f.data.byteLength, mtime: f.mtime || 0, hash: await fileHash(f), exec: !!f.exec, ...(f.by ? { by: f.by } : {}), ...(typeof f.mode === 'number' ? { mode: f.mode & 0o777 } : {}) });

const memorySide = (w) => ({
  atomic: true, // a workspace file is replaced whole or not at all: an empty one was written empty
  async list() {
    const out = new Map();
    for (const [p, f] of Object.entries(w.files || {})) out.set(p, await memoryEntry(f));
    return out;
  },
  // the tools keep writing while a sync runs (a job's files come back in the background): what is there right now
  current: async (p) => (w.files[p] ? memoryEntry(w.files[p]) : null),
  async read(p) {
    return w.files[p].data;
  },
  async write(p, bytes, entry) {
    // one call, so the mode is in the same message the bytes travel in
    const exec = typeof entry?.exec === 'boolean' ? entry.exec : undefined;
    const mode = typeof entry?.mode === 'number' ? entry.mode & 0o777 : undefined;
    // the file keeps the date it has in the shell (touch -d, an unpacked archive): not the moment it was copied
    const key = wsPut(w, p, bytes, { exec, mode, by: 'the shell', mtime: entry?.mtime, exact: true }); // the shell's path is the key, as it is
    const f = w.files[key] || {};
    return { size: bytes.byteLength, hash: await sha256Hex(bytes), exec: !!f.exec, ...(typeof f.mode === 'number' ? { mode: f.mode } : {}) };
  },
  async remove(p) {
    wsDelete(w, p, { exact: true });
  },
  has: async (p) => !!w.files[p],
});

const diskSide = (dir) => ({
  list: () => fs.listTree(dir),
  read: (p) => fs.readFile(dir, p),
  exec: (p) => fs.isExecutable(dir, p),
  async write(p, bytes, entry) {
    const exec = typeof entry?.exec === 'boolean' ? entry.exec : undefined;
    const mode = typeof entry?.mode === 'number' ? entry.mode & 0o777 : undefined;
    const after = await fs.writeFile(dir, p, bytes, { exec, mode, mtime: entry?.mtime });
    // the mode it now has, so an agreement includes it
    const out = { size: after.size, mtime: after.mtime };
    if (typeof after.mode === 'number') out.mode = after.mode;
    out.exec = typeof after.exec === 'boolean' ? after.exec : !!exec;
    return out;
  },
  remove: (p) => fs.removeFile(dir, p),
  has: (p) => fs.exists(dir, p),
  stat: (p) => fs.statEntry(dir, p),
});

/**
 * How the two directories are mounted for this chat. The workspace is always a real bind; the phone
 * folder is bound when Android exposes a plain directory, mirrored otherwise.
 */
export async function mountSpec(ctx, convId) {
  const folder = ctx?.phone?.folder?.() || null;
  const mounts = [];
  let workHost = null;
  let error = '';
  try {
    workHost = await fs.hostPath(workDir(convId));
    mounts.push(workHost + ':' + WORK);
  } catch (e) {
    // no writable app storage (the web build, or a broken install): run without a shared workspace
    error = 'the shell workspace could not be mounted (' + String((e && e.message) || e) + '), so /workspace is not shared this time';
  }
  let mode = 'none';
  if (folder) {
    // bound straight into the shell only in Auto mode: a bind writes to the phone at once, so in Review and
    // Read-only the folder is a copy instead, and what the shell changed goes through the chat's mode on the way out
    const direct = (ctx?.phone?.mode?.() || 'ask') === 'auto';
    const host = direct ? await folderLocalPath(folder).catch(() => null) : null;
    if (host) {
      mounts.push(host + ':' + PHONE);
      mode = 'bind';
    } else {
      try {
        mounts.push((await fs.hostPath(phoneDir(convId))) + ':' + PHONE);
        mode = 'mirror';
      } catch (e) {
        error = error || 'the phone folder could not be shared (' + String((e && e.message) || e) + ')';
      }
    }
  }
  return { mounts: mounts.join(';'), mode, folder, workHost, error };
}

const overwriteListeners = new Set();
/** Told of every file changed on both sides in a sync (ask_model jobs mark it a conflict, decision 182). */
export const onOverwrite = (fn) => (overwriteListeners.add(fn), () => overwriteListeners.delete(fn));

/**
 * The workspace and the shell's /workspace, reconciled in both directions. One sync per chat at a time: Claude Code's
 * tool calls and a helper's shell steps each sync, and two at once each decide on a listing the other one is changing.
 */
const syncing = new Map(); // convId -> the last sync started (the next one waits for it)
export function syncWork(w, convId, opts = {}) {
  const run = (syncing.get(convId) || Promise.resolve()).then(() => syncOnce(w, convId, opts));
  const tail = run.catch(() => {});
  syncing.set(convId, tail);
  tail.then(() => syncing.get(convId) === tail && syncing.delete(convId));
  return run;
}

async function syncOnce(w, convId, { prefer = 'a' } = {}) {
  w.shellState = fileMap(w.shellState); // keyed by the shell's file names: a file called __proto__ is just a file
  // copies of node_modules / .git the app took before they stayed in the shell: the shell still has them
  // (they were agreed with it), so the app's copy only costs memory – dropped once
  const dropped = Object.keys(w.files).filter((p) => fs.shellOnly(p) && w.shellState[p]?.b);
  for (const p of dropped) {
    delete w.files[p];
    delete w.shellState[p];
  }
  if (dropped.length && sandbox.convId === w.id) sandbox.remove(dropped);
  const pruned = dropped.length;
  const r = await reconcile(memorySide(w), diskSide(workDir(convId)), w.shellState, { ...LIMITS, prefer, ignore: fs.shellOnly });
  saveWorkspace(w);
  const notes = [];
  if (pruned) notes.push('dropped the app\'s copy of ' + pruned + ' file' + (pruned === 1 ? '' : 's') + ' under node_modules/.git (they stay in the shell)');
  // said first and in full: a partial scan is the one thing that must not be mistaken for "nothing changed"
  if (r.incomplete.b)
    notes.push(
      'the shell\'s /workspace could not be compared in full: ' + r.incomplete.b + '. Files past that point may be missing from list_files and read_file; nothing was deleted because of it' +
        (r.held.length ? ' (' + r.held.length + ' file' + (r.held.length === 1 ? '' : 's') + ' not seen in the shell were kept, e.g. ' + r.held.slice(0, 3).join(', ') + ')' : '') +
        '. Keep big trees (clones, builds, caches) outside /workspace, e.g. under /root, or delete them when done'
    );
  if (r.up) notes.push(r.up + ' file' + (r.up === 1 ? '' : 's') + ' into /workspace');
  if (r.down) notes.push(r.down + ' file' + (r.down === 1 ? '' : 's') + ' back from /workspace');
  if (r.deletedA || r.deletedB) notes.push((r.deletedA + r.deletedB) + ' deleted on both sides (' + r.deleted.slice(0, 4).join(', ') + ')');
  if (r.empty?.length) notes.push('an EMPTY file crossed: ' + r.empty.slice(0, 3).map((e) => e.path + ' (written by ' + e.from + ')').join(', ') + ' - 0 bytes; if that was not meant, the write that made it failed');
  if (r.cleared?.length) notes.push('removed the empty placeholder of ' + r.cleared.slice(0, 3).join(', ') + ' (the real file stays on the side it was written on)');
  if (r.undeletable?.length) notes.push('could NOT delete ' + r.undeletable.slice(0, 3).join(', ') + ' - it is still there; will try again');
  if (r.failed?.length) notes.push('could NOT copy ' + r.failed.slice(0, 3).map((f) => f.path + ' (' + f.error + ')').join(', ') + (r.failed.length > 3 ? ' and ' + (r.failed.length - 3) + ' more' : '') + ' - each stays as it is on the side that has it and is tried again next time');
  if (r.skipped.length) notes.push('too big for the chat workspace (over ' + MB(LIMITS.fileBytes) + '), kept in the shell only: ' + r.skipped.slice(0, 3).join(', ') + (r.skipped.length > 3 ? ' and ' + (r.skipped.length - 3) + ' more' : '') + ' – to give one to the user, phone_write from_shell /workspace/<path> (any size)');
  // the directories that stay in the shell: said when the set changes, not on every command
  const ex = r.excluded.join('\n');
  if (ex !== (w.shellExcluded || '')) {
    w.shellExcluded = ex;
    if (r.excluded.length) notes.push('not mirrored into the app (they stay in the shell; list_files and read_file do not show them): ' + r.excluded.slice(0, 4).join(', ') + (r.excluded.length > 4 ? ' and ' + (r.excluded.length - 4) + ' more' : ''));
  }
  if (r.revived.length) notes.push('kept ' + r.revived.slice(0, 3).join(', ') + (r.revived.length > 3 ? ' and ' + (r.revived.length - 3) + ' more' : '') + ': deleted on one side but changed on the other since, so the changed copy was put back');
  if (r.merged?.length)
    notes.push(
      'MERGED: ' + r.merged.slice(0, 3).join(', ') + (r.merged.length > 3 ? ' and ' + (r.merged.length - 3) + ' more' : '') +
        ' had text added at the end on both sides since the last sync: both additions are in the file now, the older one first',
    );
  if (r.merged?.length) for (const fn of overwriteListeners) fn(convId, r.merged.map((path) => ({ path, merged: true })));
  if (r.overwritten?.length) {
    // the newer write wins, so one sync can lose on either side: said per side
    for (const lostApp of [true, false]) {
      const list = r.overwritten.filter((o) => (o.lost === 'a') === lostApp);
      if (!list.length) continue;
      const kept = list.filter((o) => o.kept).map((o) => o.kept);
      notes.push(
        'CONFLICT: ' +
          list.slice(0, 3).map((o) => o.path).join(', ') + (list.length > 3 ? ' and ' + (list.length - 3) + ' more' : '') +
          ' had been changed on both sides since the last sync: ' +
          (lostApp ? 'the copy on disk is the file now (the newer write), and the edit made in the app (write_file, edit_file, Python)' : 'the app\'s copy is the file now (the newer write), and the change made on disk (by the shell, the terminal, or Claude Code in its folder)') +
          (kept.length ? ' is kept as ' + kept.slice(0, 3).join(', ') + ' – merge them and delete the conflict copy' : ' was replaced - read the file again before relying on it')
      );
    }
    for (const fn of overwriteListeners) fn(convId, r.overwritten);
  }
  // only what really collided, each said with what was lost where (a file that only grew, or an empty copy that was
  // only "nothing yet", is no longer here: those cross quietly)
  if (r.conflicts.length) {
    const side = (s) => (s === 'a' ? "the app's copy" : "the shell's copy");
    const other = (s) => (s === 'a' ? "the shell's" : "the app's");
    const said = (r.why || []).slice(0, 3).map((x) =>
      x.kind === 'first' ? `${x.path}: different content on both sides before they were ever synced – ${side(x.lost)} (${x.lostBytes} bytes) was replaced by ${other(x.lost)}, the newer one`
      : x.kind === 'emptied' ? `${x.path}: ${side(x.lost)} became EMPTY since the last sync (a failed write?) – refilled from ${other(x.lost)}, nothing lost`
      : `${x.path}: changed while it was being copied – left as it is on both sides, tried again next time`);
    const rest = r.conflicts.length - said.length;
    notes.push((said.length ? said.join('; ') : 'the two copies of ' + r.conflicts.slice(0, 3).join(', ') + ' disagreed') + (rest > 0 ? ' (and ' + rest + ' more)' : ''));
  }
  return { ...r, note: notes.join('; ') };
}

/**
 * Before a command: the phone folder into its directory, then the workspace into the shell.
 * Never throws: a bridge problem is reported and the command still runs.
 */
export async function prepareShell({ w, ctx, convId, mount, refreshPhone = false }) {
  const notes = [];
  const m = mount || (await mountSpec(ctx, convId));
  const folder = m.folder || null;
  try {
    if (folder && m.mode === 'mirror') {
      const r = await syncPhoneIn(folder, convId, w, { refresh: refreshPhone });
      if (r.note) notes.push(r.note);
    }
    if (!m.workHost) notes.push(m.error || 'the shell workspace is not mounted');
    else {
      const r = await syncWork(w, convId, { prefer: 'a' }); // before the command, the app's copy is the newer one
      if (r.note) notes.push(r.note);
    }
  } catch (e) {
    notes.push('the shell workspace did not sync: ' + String((e && e.message) || e));
  }
  return { mode: m.mode, note: notes.join('; ') };
}

/** After a command: what the shell wrote comes back, and deletes made in the shell land in the app. */
export async function collectShell({ w, ctx, convId, mode = 'none', mounted = true }) {
  const notes = [];
  let files = 0;
  try {
    if (!mounted) return { note: '', files: 0 }; // nothing was mounted, so there is nothing to bring back
    const r = await syncWork(w, convId, { prefer: 'b' }); // after the command, the shell's copy is the newer one
    files = r.down;
    if (r.note) notes.push(r.note);
  } catch (e) {
    notes.push('bringing files back failed: ' + String((e && e.message) || e));
  }
  const folder = ctx?.phone?.folder?.() || null;
  if (folder && mode === 'mirror') {
    try {
      const r = await syncPhoneOut(folder, convId, w, ctx);
      if (r.note) notes.push(r.note);
    } catch (e) {
      notes.push('saving to the phone failed: ' + String((e && e.message) || e));
    }
  }
  return { note: notes.filter(Boolean).join('; '), files };
}

// ---------- the phone folder, when it cannot be bound ----------

/** The linked folder into its directory. Unchanged files cost one listing, not a read. */
export async function syncPhoneIn(folder, convId, w, { refresh = false } = {}) {
  w.phoneState = { in: fileMap(w.phoneState?.in), out: fileMap(w.phoneState?.out) };
  const state = w.phoneState.in;
  let entries = [];
  let cut = false;
  try {
    const all = await listFolder(folder, '', true, LIMITS.phoneFiles);
    cut = all.length >= LIMITS.phoneFiles; // the listing stopped at the limit: what it did not reach is not "deleted"
    entries = all.filter((e) => !e.isDir);
  } catch (e) {
    return { note: 'could not read the phone folder: ' + String((e && e.message) || e) };
  }
  const seen = new Set();
  const notes = [];
  const big = [];
  let wrote = 0;
  for (const e of entries) {
    if (!e.path) continue;
    seen.add(e.path);
    const known = state[e.path];
    const key = { size: e.size || 0, mtime: e.mtime || 0 };
    if (known && known.size === key.size && known.mtime === key.mtime) {
      if (known.skipped) big.push(e.path + ' (' + MB(key.size) + ')');
      continue;
    }
    if (key.size > LIMITS.phoneFile) {
      // too big to mirror on every command: phone_import brings it in when it is needed (streamed, any size). A copy
      // of an older version is taken out, so the shell never works on a stale file
      if (known && !known.skipped) {
        await fs.removeFile(phoneDir(convId), e.path).catch(() => {});
        delete w.phoneState.out[e.path];
      }
      state[e.path] = { ...key, skipped: true };
      big.push(e.path + ' (' + MB(key.size) + ')');
      continue;
    }
    try {
      const bytes = await readPhoneFile(folder, e.path, LIMITS.phoneFile);
      const after = await fs.writeFile(phoneDir(convId), e.path, bytes);
      // remembered by the PHONE's size and date (that is what the next listing is compared with)
      state[e.path] = { ...after, ...key, skipped: false };
      // the phone already has these bytes: the shell has not changed this file
      w.phoneState.out[e.path] = after;
      wrote++;
    } catch {
      /* unreadable: try again next time */
    }
  }
  for (const p of Object.keys(state)) {
    if (seen.has(p) || cut) continue;
    delete state[p];
    delete w.phoneState.out[p];
    await fs.removeFile(phoneDir(convId), p); // deleted on the phone
    notes.push('removed from /phone: ' + p);
  }
  saveWorkspace(w);
  if (cut) notes.push('the phone folder has more than ' + LIMITS.phoneFiles + ' entries: only the first ' + LIMITS.phoneFiles + ' were copied into /phone, and nothing was removed from /phone because of it – link a smaller folder');
  if (wrote) notes.unshift(wrote + ' phone file' + (wrote === 1 ? '' : 's') + ' copied into /phone');
  // said every time, so the assistant does not go looking for them in /phone or under /storage
  if (big.length) notes.push('not in /phone (over ' + MB(LIMITS.phoneFile) + ', copied only when asked): ' + big.slice(0, 5).join(', ') + (big.length > 5 ? ' and ' + (big.length - 5) + ' more' : '') + ' – phone_import one with to_shell:true to get it at /phone/<path>');
  return { note: notes.join('; '), wrote };
}

/**
 * A file too big to mirror, brought into the shell's /phone copy on request (decision 224): streamed by Android, any
 * size. Remembered as in sync both ways, so the next command neither copies it again nor offers to save it back.
 * → { ok, where, bytes, already } – already: /phone is the folder itself (bound), nothing to copy.
 */
export async function bringIntoShell(folder, convId, w, path, { bound = false, onProgress } = {}) {
  if (bound) return { ok: true, where: PHONE + '/' + path, already: true };
  if (!canCopyIntoShell()) return { ok: false, why: 'this needs the Android app' };
  const r = await copyIntoShell(folder, path, phoneDir(convId) + '/' + path, onProgress);
  const after = await fs.statEntry(phoneDir(convId), path);
  if (!after || after.size !== r.bytes) return { ok: false, why: 'the copy in Linux does not have the whole file' };
  w.phoneState = { in: fileMap(w.phoneState?.in), out: fileMap(w.phoneState?.out) };
  const listed = (await listFolder(folder, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', false).catch(() => [])).find((e) => e.path === path);
  w.phoneState.in[path] = { size: listed?.size ?? r.bytes, mtime: listed?.mtime || 0, skipped: false };
  w.phoneState.out[path] = after;
  saveWorkspace(w);
  return { ok: true, where: PHONE + '/' + path, bytes: r.bytes };
}

/** What the shell wrote under /phone goes to the linked folder, following this chat's mode. */
export async function syncPhoneOut(folder, convId, w, ctx) {
  w.phoneState = { in: fileMap(w.phoneState?.in), out: fileMap(w.phoneState?.out) };
  const state = w.phoneState.out;
  const tree = await fs.listTree(phoneDir(convId));
  const saved = [];
  const staged = [];
  const refused = [];
  const skipped = [];
  const growing = [];
  for (const [p, e] of tree) {
    const known = state[p];
    if (known && known.size === e.size && known.mtime === e.mtime) continue;
    if (e.size > LIMITS.phoneFile) {
      // too big to carry through the app's memory: streamed by Android from the shell's copy straight into the folder
      if (!canExportLinux()) {
        state[p] = { ...e, skipped: true };
        skipped.push(p + ' (' + MB(e.size) + ')');
        continue;
      }
      // still being written (a recording): saved once it stops changing, not copied again after every command
      if (e.mtime && Date.now() - e.mtime < GROWING_MS) {
        growing.push(p + ' (' + MB(e.size) + ' so far)');
        continue;
      }
      const m = ctx?.phone?.mode?.() || 'ask';
      if (m === 'readonly') {
        refused.push(p);
        state[p] = e;
        continue;
      }
      if (m === 'ask') {
        const yes = 'Save it';
        const ans = ctx?.ask ? await ctx.ask(`The shell made ${p} (${MB(e.size)}) in /phone. Save it into “${folder.name}”?`, [yes, 'Not now'], ctx.signal) : null;
        if (ans !== yes) {
          state[p] = { ...e, skipped: true }; // asked once for this version of the file
          skipped.push(p + ' (you said not now)');
          continue;
        }
      }
      try {
        const r = await exportLinuxFile(phoneDir(convId) + '/' + p, { folder, path: p, base: 'shell' }, (done, total) => ctx?.onStatus?.(`saving ${p} to the phone – ${Math.round((done / Math.max(1, total)) * 100)}%`));
        if (r.bytes !== e.size) {
          skipped.push(p + ' (only ' + MB(r.bytes) + ' of ' + MB(e.size) + ' written)');
          continue;
        }
        ctx?.phone?.log?.push({ path: p, kind: 'new', before: null });
        state[p] = e;
        saved.push(p + ' (' + MB(e.size) + ')');
      } catch (err) {
        skipped.push(p + ' (' + String((err && err.message) || err).replace(/^Could not save it: /, '') + ')');
      }
      continue;
    }
    const bytes = await fs.readFile(phoneDir(convId), p);
    const r = await saveToPhone(ctx, folder, p, bytes);
    if (!r.ok && r.why === 'read-only') refused.push(p);
    else if (!r.ok) skipped.push(p + ' (read-back differs)');
    else {
      state[p] = e;
      (r.staged ? staged : saved).push(p);
    }
  }
  const gone = Object.keys(state).filter((p) => !tree.has(p));
  for (const p of gone) delete state[p]; // files removed in the shell are not deleted on the phone: too easy to lose data
  saveWorkspace(w);
  const notes = [];
  if (saved.length) notes.push('saved to the phone: ' + saved.slice(0, 6).join(', ') + (saved.length > 6 ? ' and ' + (saved.length - 6) + ' more' : ''));
  if (staged.length) notes.push('staged for review (phone): ' + staged.slice(0, 6).join(', '));
  if (refused.length) notes.push('NOT saved - the phone folder is read-only: ' + refused.slice(0, 6).join(', '));
  if (skipped.length) notes.push('not saved: ' + skipped.slice(0, 3).join(', '));
  if (growing.length) notes.push('still being written, saved to the phone once it stops changing: ' + growing.slice(0, 3).join(', '));
  return { note: notes.join('; '), saved: saved.length, staged: staged.length };
}
