// A stand-in for @capacitor/filesystem (same shape as tests/unit/bridge.test.js's fakeFs), with an
// indexed readdir so a 20,000-file tree stays fast. readdir returns names sorted, which is one
// legal order: Android's File.listFiles() promises none, so whether om/ is walked before output/
// is down to the filesystem.
const enc = (s) => new TextEncoder().encode(s);
const dec = (u8) => new TextDecoder().decode(u8);
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

export function fakeFs() {
  const files = new Map(); // /data/<path> -> { bytes, mtime }
  const dirs = new Set(['/data']);
  const kids = new Map(); // dir -> Set(name)
  let clock = 1000;
  const abs = (p) => '/data/' + String(p).replace(/^\/+/, '');
  const parent = (p) => p.slice(0, p.lastIndexOf('/'));
  const link = (p) => {
    let cur = p;
    while (cur !== '/data') {
      const up = parent(cur);
      if (!kids.has(up)) kids.set(up, new Set());
      kids.get(up).add(cur.slice(up.length + 1));
      if (cur !== p) dirs.add(cur);
      cur = up;
    }
  };
  const unlink = (p) => kids.get(parent(p))?.delete(p.slice(parent(p).length + 1));
  const api = {
    files,
    dirs,
    get(p) {
      const f = files.get(abs(p));
      return f ? dec(f.bytes) : undefined;
    },
    put(p, s) {
      link(abs(p));
      files.set(abs(p), { bytes: typeof s === 'string' ? enc(s) : s, mtime: ++clock });
    },
    rmTree(p) {
      const d = abs(p);
      for (const k of [...files.keys()]) if (k.startsWith(d + '/')) (files.delete(k), unlink(k));
      for (const k of [...dirs]) if (k === d || k.startsWith(d + '/')) (dirs.delete(k), kids.delete(k), unlink(k));
    },
    async mkdir({ path }) {
      const d = abs(path);
      dirs.add(d);
      link(d);
    },
    async getUri({ path }) {
      return { uri: 'file://' + abs(path) };
    },
    async readdir({ path }) {
      const dir = abs(path);
      if (!dirs.has(dir)) throw new Error('ENOENT ' + dir);
      const names = [...(kids.get(dir) || [])].sort();
      return {
        files: names.map((n) => {
          const full = dir + '/' + n;
          const f = files.get(full);
          return f ? { name: n, type: 'file', size: f.bytes.length, mtime: f.mtime } : { name: n, type: 'directory', size: 0, mtime: 0 };
        }),
      };
    },
    async readFile({ path }) {
      const f = files.get(abs(path));
      if (!f) throw new Error('ENOENT ' + path);
      return { data: b64(f.bytes) };
    },
    async writeFile({ path, data }) {
      link(abs(path));
      files.set(abs(path), { bytes: unB64(data), mtime: ++clock });
    },
    async appendFile({ path, data }) {
      const f = files.get(abs(path));
      if (!f) throw new Error('ENOENT ' + path);
      const add = unB64(data);
      const merged = new Uint8Array(f.bytes.length + add.length);
      merged.set(f.bytes);
      merged.set(add, f.bytes.length);
      files.set(abs(path), { bytes: merged, mtime: ++clock });
    },
    async rename({ from, to }) {
      const f = files.get(abs(from));
      if (!f) throw new Error('ENOENT ' + from);
      link(abs(to));
      files.set(abs(to), f);
      files.delete(abs(from));
      unlink(abs(from));
    },
    async stat({ path }) {
      const p = abs(path);
      const f = files.get(p);
      if (f) return { type: 'file', size: f.bytes.length, mtime: f.mtime };
      if (dirs.has(p)) return { type: 'directory', size: 0, mtime: 0 };
      throw new Error('ENOENT');
    },
    async deleteFile({ path }) {
      files.delete(abs(path));
      unlink(abs(path));
    },
    async rmdir({ path }) {
      api.rmTree(path);
    },
  };
  return api;
}
