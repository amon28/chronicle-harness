/**
 * A filesystem for isomorphic-git over two maps: the chat's workspace (its files, as the tools see them) at /work,
 * and the repository's own data at /git (kept apart, so ".git" never shows up among the workspace files).
 * Directories are implied by paths, plus the empty ones git makes.
 */
const err = (code, path) => Object.assign(new Error(`${code}: ${path}`), { code });
const enc = new TextEncoder();
const dec = new TextDecoder();
const fnv = (b) => {
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619);
  return h >>> 0;
};

export function makeFs({ work, git }) {
  // work: { files: { path: { data: Uint8Array, mtime } } } – the workspace object itself (edited in place)
  // git: { [path]: Uint8Array } – the repository's data
  const dirs = new Set(['/', '/work', '/git']);
  const where = (p) => {
    const segs = [];
    for (const s of String(p).split('/')) {
      if (!s || s === '.') continue;
      if (s === '..') segs.pop();
      else segs.push(s);
    }
    const path = '/' + segs.join('/');
    if (path === '/work' || path.startsWith('/work/')) return { kind: 'work', rel: path.slice(6), path };
    if (path === '/git' || path.startsWith('/git/')) return { kind: 'git', rel: path.slice(5), path };
    return { kind: 'root', rel: '', path };
  };
  const getFile = (w) => (w.kind === 'work' ? work.files[w.rel]?.data : w.kind === 'git' ? git[w.rel] : undefined);
  const childrenOf = (w) => {
    const pre = w.rel ? w.rel + '/' : '';
    const keys = w.kind === 'work' ? Object.keys(work.files) : w.kind === 'git' ? Object.keys(git) : [];
    const out = new Set();
    for (const k of keys) if (k.startsWith(pre)) out.add(k.slice(pre.length).split('/')[0]);
    for (const d of dirs) if (d.startsWith(w.path + '/') && d !== w.path) out.add(d.slice(w.path.length + 1).split('/')[0]);
    if (w.kind === 'root') ['work', 'git'].forEach((x) => out.add(x));
    return [...out].filter(Boolean);
  };
  const isDir = (w) => dirs.has(w.path) || (w.kind !== 'root' && childrenOf(w).length > 0 && getFile(w) === undefined) || w.path === '/';
  const stat = async (p) => {
    const w = where(p);
    const f = getFile(w);
    const mtime = w.kind === 'work' ? work.files[w.rel]?.mtime || 0 : 0;
    if (f !== undefined) {
      const exec = w.kind === 'work' && work.files[w.rel]?.exec;
      // ino is a hash of the bytes: git trusts unchanged stats, and a workspace edit may keep size and time
      return { type: 'file', mode: exec ? 0o100755 : 0o100644, size: f.byteLength, ino: w.kind === 'work' ? fnv(f) : 0, mtimeMs: mtime, ctimeMs: mtime, uid: 1, gid: 1, dev: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
    }
    if (isDir(w)) return { type: 'dir', mode: 0o40000, size: 0, ino: 0, mtimeMs: 0, ctimeMs: 0, uid: 1, gid: 1, dev: 1, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
    throw err('ENOENT', p);
  };
  const promises = {
    async readFile(p, opts) {
      const f = getFile(where(p));
      if (f === undefined) throw err('ENOENT', p);
      const enc8 = typeof opts === 'string' ? opts : opts?.encoding;
      return enc8 === 'utf8' ? dec.decode(f) : f;
    },
    async writeFile(p, data, opts) {
      const w = where(p);
      const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
      if (w.kind === 'work') {
        const old = work.files[w.rel];
        work.files[w.rel] = { ...(old || {}), data: bytes, mtime: Date.now(), ...((opts?.mode & 0o111) ? { exec: true } : {}) };
      } else if (w.kind === 'git') git[w.rel] = bytes;
      else throw err('EACCES', p);
    },
    async unlink(p) {
      const w = where(p);
      if (getFile(w) === undefined) throw err('ENOENT', p);
      if (w.kind === 'work') delete work.files[w.rel];
      else delete git[w.rel];
    },
    async readdir(p) {
      const w = where(p);
      if (getFile(w) !== undefined) throw err('ENOTDIR', p);
      if (!isDir(w)) throw err('ENOENT', p);
      return childrenOf(w);
    },
    async mkdir(p) {
      const w = where(p);
      if (getFile(w) !== undefined || dirs.has(w.path)) throw err('EEXIST', p);
      dirs.add(w.path);
    },
    async rmdir(p) {
      const w = where(p);
      if (childrenOf(w).length) throw err('ENOTEMPTY', p);
      dirs.delete(w.path);
    },
    stat,
    lstat: stat,
    async readlink(p) {
      throw err('ENOENT', p);
    },
    async symlink(target, p) {
      await promises.writeFile(p, target);
    },
    async chmod() {},
  };
  return { promises };
}
