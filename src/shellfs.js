// The app's side of the shell's /workspace and /phone - real directories under the app's files dir,
// bound into proot with "-b <dir>:/workspace".
//
// Two rules learned the hard way, both from a 64 MiB file that was destroyed by its own sync:
//   * a write is never visible under its real name until it is complete: chunk it into a temporary
//     file, check the byte count, then rename. A failed transfer leaves nothing behind.
//   * the bridge is base64, so a whole file in one call costs about three times its size in the heap.
//     Chunks keep that spike at a few megabytes.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

const modeNative = Capacitor.isNativePlatform() ? registerPlugin('FileMode') : null;
/** Tests install globalThis.__ocmMode with { stat, chmod } and, when they can, { modes, execs }. */
const modeImpl = () => globalThis.__ocmMode || modeNative;

/** Everything the shell sees lives under <filesDir>/shell (Directory.Data). */
export const ROOT = 'shell';
const MAX_ENTRIES = 20000;
/**
 * Directory names that are never mirrored into the app: a package install or a clone puts tens of
 * thousands of files there, and carrying them into the app's memory costs heap and time for nothing.
 * They are not deleted or hidden in the shell - the app just does not keep a copy.
 */
// (also caches a tool makes in the chat's folder – a virtualenv, Python's bytecode, a build cache, decision 259; the same
// list is in FileModePlugin.java)
export const SHELL_ONLY = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.cache', '.gradle', '.tox', '.mypy_cache', '.pytest_cache', 'target']);
/** Is this path inside a directory the app does not mirror? */
export const shellOnly = (p) => String(p).split('/').some((s) => SHELL_ONLY.has(s));
const CHUNK = 4 * 1024 * 1024; // base64 of this is ~5.3 MB: the heap spike per call
export const TMP_SUFFIX = '.ocm-tmp';

/** Tests install globalThis.__ocmFiles with the same shape as the Capacitor plugin. */
const impl = () => globalThis.__ocmFiles || Filesystem;

const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unB64 = (s) => {
  const bin = atob(String(s || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const join = (dir, path) => (path ? dir + '/' + path : dir);
export const rel = (dir, path) => join(ROOT, join(dir, path));

export async function ensureDir(dir) {
  await impl().mkdir({ path: rel(dir, ''), directory: Directory.Data, recursive: true }).catch(() => {});
  return rel(dir, '');
}

/** The absolute directory proot should bind. Creating it first, so the bind cannot fail on a missing path. */
export async function hostPath(dir) {
  const path = await ensureDir(dir);
  const { uri } = await impl().getUri({ path, directory: Directory.Data });
  const host = decodeURIComponent(String(uri).replace(/^file:\/\//, ''));
  if (!host.startsWith('/')) throw new Error('Could not resolve a host path for ' + path + ' (got ' + uri + ')');
  return host;
}

/**
 * Every file under dir, as path -> { size, mtime, mode?, exec? }, with paths relative to dir. Half-written files are ignored.
 *
 * The map also says how much of the tree it saw, because the reconciler reads "not listed" as "deleted":
 *   out.incomplete - '' when every directory was read; otherwise why not (the entry cap was reached, a
 *                    directory could not be read). A caller must not infer a delete from an incomplete listing.
 *   out.excluded   - directories that are never walked (node_modules, .git): they stay in the shell only.
 */
/** listTree's answer from FileModePlugin.modes({ stat: true }): every file's mode, size and time in one native walk. */
function fromModes(dir, r) {
  const out = new Map();
  const modes = r.files || {};
  for (const [p, st] of Object.entries(r.info || {})) {
    if (p.endsWith(TMP_SUFFIX)) {
      // a transfer that never finished (the app was killed mid-write): it was never visible, drop it
      impl().deleteFile({ path: rel(dir, p), directory: Directory.Data }).catch(() => {});
      continue;
    }
    if (shellOnly(p)) continue;
    const entry = { size: Number(st?.[0]) || 0, mtime: Number(st?.[1]) || 0 };
    const mode = modes[p];
    if (typeof mode === 'number') {
      entry.mode = mode & 0o777;
      entry.exec = (entry.mode & 0o111) !== 0;
    }
    out.set(p, entry);
    if (out.size >= MAX_ENTRIES) {
      out.incomplete = 'more than ' + MAX_ENTRIES.toLocaleString('en-US') + ' files';
      break;
    }
  }
  out.incomplete ||= r.incomplete || '';
  out.excluded = [...(r.excluded || [])];
  return out;
}
export async function listTree(dir) {
  const out = new Map();
  let incomplete = '';
  const excluded = [];
  // only Android reports a mode; without the plugin the listing says nothing about it (rather than
  // saying "not executable", which would chmod every script on every crossing)
  const api = modeImpl();
  // one native call for the whole tree's modes when the plugin can do it, one for the exec bits when
  // it can only do that, a stat per file otherwise
  let modeMap = null;
  let execSet = null;
  let links = new Set(); // symbolic links (Android reports them): never followed, never mirrored
  if (api?.modes) {
    try {
      const r = await api.modes({ path: rel(dir, ''), stat: true });
      // the whole listing in that one call (decision 259): no call per folder
      if (r?.info) return fromModes(dir, r);
      const files = r?.files || {};
      modeMap = files instanceof Map ? files : new Map(Object.entries(files));
      links = new Set(r?.links || []);
    } catch {
      modeMap = null;
    }
  }
  if (!modeMap && api?.execs) {
    try {
      execSet = new Set((await api.execs({ path: rel(dir, '') }))?.paths || []);
    } catch {
      execSet = null;
    }
  }
  const walk = async (sub) => {
    let files = [];
    try {
      files = (await impl().readdir({ path: rel(dir, sub), directory: Directory.Data })).files || [];
    } catch (e) {
      // the root not being there yet is an empty tree; any other directory that cannot be read (chmod 000,
      // an I/O error) is NOT an empty one - its files must not look deleted
      if (sub || (await exists(dir, ''))) incomplete ||= 'could not read ' + (sub || 'the top directory') + ' (' + String((e && e.message) || e).slice(0, 80) + ')';
      return;
    }
    for (const f of files) {
      if (out.size >= MAX_ENTRIES) {
        incomplete ||= 'more than ' + MAX_ENTRIES.toLocaleString('en-US') + ' files (the scan stopped in ' + (sub || 'the top directory') + ')';
        return;
      }
      const p = sub ? sub + '/' + f.name : f.name;
      // a link to ../.. would walk (and mirror, and delete in) the app's own folders: links stay in the shell
      if (links.has(p)) continue;
      if (f.type === 'directory' && SHELL_ONLY.has(f.name)) {
        excluded.push(p); // thousands of files nobody reads through the app: the shell keeps them
        continue;
      }
      if (f.name.endsWith(TMP_SUFFIX)) {
        // a transfer that never finished (the app was killed mid-write): it was never visible, drop it
        impl().deleteFile({ path: rel(dir, p), directory: Directory.Data }).catch(() => {});
        continue;
      }
      if (f.type === 'directory') await walk(p);
      else {
        const entry = { size: f.size || 0, mtime: f.mtime || 0 };
        if (modeMap) {
          const mode = modeMap.get(p);
          if (typeof mode === 'number') {
            entry.mode = mode & 0o777;
            entry.exec = (entry.mode & 0o111) !== 0;
          }
        } else if (execSet) entry.exec = execSet.has(p);
        else if (api) Object.assign(entry, await fileMode(dir, p));
        out.set(p, entry);
      }
    }
  };
  await walk('');
  out.incomplete = incomplete;
  out.excluded = excluded;
  return out;
}

/** One file's entry without a walk (for a path an incomplete listing did not reach), or null when it is not there. */
export async function statEntry(dir, path) {
  try {
    const st = await impl().stat({ path: rel(dir, path), directory: Directory.Data });
    if (st.type === 'directory') return null;
    return { size: st.size || 0, mtime: st.mtime || 0 };
  } catch {
    return null;
  }
}

/**
 * Read a file back from the shell's side. The fast way is the WebView's own file server
 * (convertFileSrc + fetch): raw bytes, no base64. Through the plugin, a 32 MiB file became one 43 MB
 * base64 string across the bridge and a per-character decode loop - why shell -> app measured 3.5 MB/s
 * while app -> shell (chunked writes) did 10. The plugin path stays as the fallback.
 */
export async function readFile(dir, path) {
  if (!globalThis.__ocmFiles && Capacitor.isNativePlatform() && typeof fetch === 'function') {
    try {
      const { uri } = await impl().getUri({ path: rel(dir, path), directory: Directory.Data });
      const res = await fetch(Capacitor.convertFileSrc(uri), { cache: 'no-store' });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch {
      /* fall through to the plugin */
    }
  }
  const r = await impl().readFile({ path: rel(dir, path), directory: Directory.Data });
  if (typeof r.data === 'string') return unB64(r.data);
  return new Uint8Array(await r.data.arrayBuffer());
}

/**
 * Write bytes so that the real name only ever holds a complete file: chunk into <path>.ocm-tmp,
 * check the size, then rename over the old copy. On any failure the temporary is removed and the
 * destination is untouched - a short write can never become "the new content".
 */
export async function writeFile(dir, path, bytes, { exec, mode, mtime } = {}) {
  const full = rel(dir, path);
  const tmp = full + TMP_SUFFIX;
  try {
    const total = bytes.byteLength;
    if (total === 0) {
      await impl().writeFile({ path: tmp, data: '', directory: Directory.Data, recursive: true });
    } else {
      for (let off = 0; off < total; off += CHUNK) {
        const part = bytes.subarray(off, Math.min(total, off + CHUNK));
        if (off === 0) await impl().writeFile({ path: tmp, data: b64(part), directory: Directory.Data, recursive: true });
        else await impl().appendFile({ path: tmp, data: b64(part), directory: Directory.Data });
      }
    }
    const st = await impl().stat({ path: tmp, directory: Directory.Data });
    if ((st.size ?? -1) !== total) throw new Error('wrote ' + st.size + ' of ' + total + ' bytes to ' + path);
    // renamed over the old copy first (one step: the name never goes missing, as a shell reading it would see), and
    // only when that is refused is the old copy deleted first (decision 256: deleting first left no file at all when the
    // rename then failed for another reason)
    try {
      await impl().rename({ from: tmp, to: full, directory: Directory.Data });
    } catch {
      await impl().deleteFile({ path: full, directory: Directory.Data }).catch(() => {});
      try {
        await impl().rename({ from: tmp, to: full, directory: Directory.Data });
      } catch (e) {
        // a folder of that name is in the way: one with no file anywhere in it (mkdir, or what a delete left) goes
        if (!(await emptyTree(full))) throw e;
        await impl().rmdir({ path: full, directory: Directory.Data, recursive: true });
        await impl().rename({ from: tmp, to: full, directory: Directory.Data });
      }
    }
    // The mode the caller states is applied as it is: a 644 must not arrive 666, a 600 must keep its
    // protection. A caller that only knows the exec bit keeps the old rule - a script that was
    // executable stays executable, and one the app says is not a script must not keep the bit, or
    // "chmod -x" could never cross back.
    let applied; // the mode this write left behind, when it said anything about it
    if (typeof mode === 'number') applied = mode & 0o777;
    else if (exec) applied = 0o755;
    else if (exec === false && (await isExecutable(dir, path))) applied = 0o644;
    if (applied !== undefined) await setMode(dir, path, applied);
    // the time the file was written where it came from (a helper's Python step), not the moment of this copy
    if (mtime > 0) await modeImpl()?.touch?.({ path: rel(dir, path), mtime: Math.round(mtime) }).catch(() => {});
    const after = await impl().stat({ path: full, directory: Directory.Data });
    const out = { size: after.size ?? total, mtime: after.mtime || 0 };
    if (applied !== undefined) {
      out.mode = applied;
      out.exec = (applied & 0o111) !== 0;
    }
    return out;
  } catch (e) {
    await impl().deleteFile({ path: tmp, directory: Directory.Data }).catch(() => {});
    throw e;
  }
}

/** Is this a directory with no file anywhere under it (folders only)? false for a file, a missing path or an error. */
async function emptyTree(full, depth = 0) {
  if (depth > 32) return false;
  let list;
  try {
    list = (await impl().readdir({ path: full, directory: Directory.Data })).files || [];
  } catch {
    return false;
  }
  for (const e of list) {
    if (e.type !== 'directory' || !(await emptyTree(full + '/' + e.name, depth + 1))) return false;
  }
  return true;
}

/** The mode and the exec bit of one file, when the plugin can tell us. */
export async function fileMode(dir, path) {
  try {
    const r = await modeImpl()?.stat({ path: rel(dir, path) });
    if (!r) return null;
    const mode = typeof r.mode === 'number' ? r.mode & 0o777 : undefined;
    const exec = typeof r.executable === 'boolean' ? r.executable : mode === undefined ? undefined : (mode & 0o111) !== 0;
    if (mode === undefined && exec === undefined) return null;
    return { ...(mode === undefined ? {} : { mode }), ...(exec === undefined ? {} : { exec }) };
  } catch {
    return null;
  }
}

/** Can this file run? (the exec bit Capacitor's stat does not report) */
export async function isExecutable(dir, path) {
  return !!(await fileMode(dir, path))?.exec;
}

export async function setMode(dir, path, mode) {
  try {
    await modeImpl()?.chmod({ path: rel(dir, path), mode });
  } catch {
    /* a mode is a nicety: never fail a crossing over it */
  }
}

/** Is there a file (or anything) at this path? Used to check that a delete really happened. */
export async function exists(dir, path) {
  try {
    await impl().stat({ path: rel(dir, path), directory: Directory.Data });
    return true;
  } catch {
    return false;
  }
}

export async function removeFile(dir, path) {
  await impl().deleteFile({ path: rel(dir, path), directory: Directory.Data }).catch(() => {});
  // and the directories it was the last file in, so "rm -rf out/" does not leave an empty tree behind
  let p = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  while (p) {
    try {
      const { files } = await impl().readdir({ path: rel(dir, p), directory: Directory.Data });
      if (files && files.length) break;
      await impl().rmdir({ path: rel(dir, p), directory: Directory.Data, recursive: true });
    } catch {
      break;
    }
    p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  }
}

/** Where a chat's /workspace and its copy of the phone folder (/phone, when it cannot be bound) live under ROOT. */
const safe = (s) => String(s || 'main').replace(/[^\w.-]/g, '_').slice(0, 48) || 'main';
export const workDir = (convId) => 'work/' + safe(convId);
export const phoneDir = (convId) => 'phone/' + safe(convId);

/**
 * A chat's files were deleted (Delete all files, Delete chat, Storage › Delete files): the shell's copies go too.
 * Without this the "deleted" files came back with the chat's next shell command, and a deleted chat's files - and
 * its copy of the linked phone folder - stayed in the app's storage for good.
 */
export async function forgetChat(convId) {
  await removeDir(workDir(convId));
  await removeDir(phoneDir(convId));
}

/** Remove a whole directory tree (when a chat's shell workspace is thrown away). */
export async function removeDir(dir) {
  await impl().rmdir({ path: rel(dir, ''), directory: Directory.Data, recursive: true }).catch(() => {});
}
