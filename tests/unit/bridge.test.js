import { describe, it, expect, beforeEach } from 'vitest';
import { mountSpec, syncWork, prepareShell, syncPhoneIn, syncPhoneOut, WORK, PHONE, LIMITS } from '../../src/bridge.js';
import { sandbox, wsPut } from '../../src/sandbox.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (u8) => new TextDecoder().decode(u8);
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

/** A stand-in for @capacitor/filesystem: the app's private files dir, as a map. */
function fakeFs() {
  const files = new Map(); // /data/<path> -> { bytes, mtime }
  const dirs = new Set(['/data']);
  let clock = 1000;
  let readFiles = 0;
  const abs = (p) => '/data/' + String(p).replace(/^\/+/, '');
  const ensure = (p) => {
    const parts = p.split('/');
    let cur = '';
    for (const s of parts.slice(1, -1)) {
      cur += '/' + s;
      dirs.add(cur);
    }
  };
  return {
    files,
    dirs,
    readCount: () => readFiles,
    get(p) {
      const f = files.get(abs(p));
      return f ? dec(f.bytes) : undefined;
    },
    put(p, s) {
      ensure(abs(p));
      files.set(abs(p), { bytes: enc(s), mtime: ++clock });
    },
    async mkdir({ path }) {
      dirs.add(abs(path));
    },
    async getUri({ path }) {
      return { uri: 'file://' + abs(path) };
    },
    async readdir({ path }) {
      const dir = abs(path);
      const out = new Map();
      for (const d of dirs) {
        if (!d.startsWith(dir + '/')) continue;
        const rest = d.slice(dir.length + 1);
        if (!rest || rest.includes('/')) continue;
        out.set(rest, { name: rest, type: 'directory', size: 0, mtime: 0 });
      }
      for (const [p, f] of files) {
        if (!p.startsWith(dir + '/')) continue;
        const rest = p.slice(dir.length + 1);
        if (rest.includes('/')) continue;
        out.set(rest, { name: rest, type: 'file', size: f.bytes.length, mtime: f.mtime });
      }
      if (!out.size && !dirs.has(dir)) throw new Error('ENOENT ' + dir);
      return { files: [...out.values()] };
    },
    async readFile({ path }) {
      readFiles++;
      const f = files.get(abs(path));
      if (!f) throw new Error('ENOENT ' + path);
      return { data: b64(f.bytes) };
    },
    async writeFile({ path, data }) {
      ensure(abs(path));
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
      ensure(abs(to));
      files.set(abs(to), f);
      files.delete(abs(from));
    },
    async stat({ path }) {
      const f = files.get(abs(path));
      if (!f) throw new Error('ENOENT');
      return { size: f.bytes.length, mtime: f.mtime };
    },
    async deleteFile({ path }) {
      files.delete(abs(path));
    },
    async rmdir({ path }) {
      const dir = abs(path);
      for (const p of [...files.keys()]) if (p.startsWith(dir + '/')) files.delete(p);
      for (const d of [...dirs]) if (d.startsWith(dir)) dirs.delete(d);
    },
  };
}

let fs;
let modes;
let disk; // the phone folder, path -> bytes
const phoneStub = (localPath = null) => {
  globalThis.__ocmPhoneFolder = {
    pick: async () => ({ uri: 'content://p', name: 'Projects' }),
    list: async ({ path = '' }) => ({
      entries: Object.entries(disk)
        .filter(([p]) => (path ? p.startsWith(path + '/') : true))
        .map(([p, d]) => ({ path: p, isDir: false, size: d.length, mtime: 2000 })),
    }),
    read: async ({ path }) => {
      if (!disk[path]) throw new Error('No such file: ' + path);
      return { base64: b64(disk[path]) };
    },
    write: async ({ path, base64 }) => {
      disk[path] = unB64(base64);
      return { existed: true };
    },
    remove: async ({ path }) => (delete disk[path], { ok: true }),
    exists: async ({ path }) => ({ exists: !!disk[path], isDir: false, size: disk[path]?.length || 0 }),
    localPath: async () => (localPath ? { path: localPath } : {}),
  };
};

const workspace = (id = 'c1') => ({ id, files: {}, shellState: {} });

beforeEach(() => {
  fs = fakeFs();
  globalThis.__ocmFiles = fs;
  modes = new Map(); // '/data/<path>' -> mode, as the FileMode plugin reports it
  globalThis.__ocmMode = {
    stat: async ({ path }) => {
      const m = modes.get('/data/' + path);
      return { exists: true, ...(m === undefined ? {} : { mode: m }), executable: ((m || 0) & 0o111) !== 0 };
    },
    modes: async ({ path }) => {
      const base = '/data/' + path + '/';
      const files = {};
      for (const [p, m] of modes) if (p.startsWith(base)) files[p.slice(base.length)] = m;
      return { files };
    },
    chmod: async ({ path, mode }) => {
      modes.set('/data/' + path, mode);
      return { mode };
    },
  };
  disk = {};
});

describe('/workspace is a mount', () => {
  it('binds a real directory for this chat into /workspace', async () => {
    const m = await mountSpec({ phone: { folder: () => null } }, 'c1');
    expect(m.mounts).toMatch(/:\/workspace$/);
    expect(m.mounts.split(':')[0]).toMatch(/^\/data\/shell\/work\/c1/);
    expect(fs.dirs.has('/data/shell/work/c1')).toBe(true);
    // each chat gets its own directory: one chat's files are not another's
    const other = await mountSpec({ phone: { folder: () => null } }, 'c2');
    expect(other.mounts).not.toBe(m.mounts);
  });

  it('carries files both ways, and brings the shell\'s writes back', async () => {
    const w = workspace();
    w.files['notes.txt'] = { data: enc('hello') };
    let r = await syncWork(w, 'c1');
    expect(r.up).toBe(1);
    expect(fs.get('shell/work/c1/notes.txt')).toBe('hello');

    fs.put('shell/work/c1/out/chart.csv', 'a,b');
    r = await syncWork(w, 'c1');
    expect(r.down).toBe(1);
    expect(dec(w.files['out/chart.csv'].data)).toBe('a,b');
  });

  it('a first meeting is won by the newer copy - the app side has a time too, so an old shell file loses', async () => {
    fs.put('shell/work/c1/jobs.json', '[1,2,3]'); // left in the shell folder by an earlier life of this chat
    const w = workspace();
    w.files['jobs.json'] = { data: enc('[1,2]'), mtime: Date.now() };
    const r = await syncWork(w, 'c1');
    expect(r.conflicts).toContain('jobs.json');
    expect(fs.get('shell/work/c1/jobs.json')).toBe('[1,2]');
    expect(dec(w.files['jobs.json'].data)).toBe('[1,2]');
    // and the other way round: a shell file newer than the app's copy wins
    fs.put('shell/work/c1/b.txt', 'shell');
    w.files['b.txt'] = { data: enc('app!'), mtime: 1 };
    await syncWork(w, 'c1');
    expect(dec(w.files['b.txt'].data)).toBe('shell');
  });

  it('deletes on the other side - the AES key does not stay behind', async () => {
    const w = workspace();
    w.files['session.key'] = { data: enc('AES') };
    w.files['keep.txt'] = { data: enc('k') };
    await syncWork(w, 'c1');
    expect(fs.get('shell/work/c1/session.key')).toBe('AES');

    // a tool deletes its secret in the app side
    delete w.files['session.key'];
    const r = await syncWork(w, 'c1');
    expect(fs.get('shell/work/c1/session.key')).toBeUndefined();
    expect(r.deletedB).toBe(1);

    // and a delete in the shell removes it from the app
    fs.files.delete('/data/shell/work/c1/keep.txt');
    const r2 = await syncWork(w, 'c1');
    expect(w.files['keep.txt']).toBeUndefined();
    expect(r2.deletedA).toBe(1);
  });

  it('remembers a file too big to copy instead of paying for it every call', async () => {
    const w = workspace();
    w.files['huge.bin'] = { data: new Uint8Array(70 * 1024 * 1024) };
    const r = await syncWork(w, 'c1');
    expect(r.skipped).toEqual(['huge.bin']);

    const before = fs.readCount();
    const r2 = await syncWork(w, 'c1');
    expect(r2.skipped).toEqual([]);
    expect(fs.readCount()).toBe(before); // not read again
    expect(fs.get('shell/work/c1/huge.bin')).toBeUndefined(); // and not deleted either
  });

  it('a refused crossing leaves the shell alone and does not destroy the app copy', async () => {
    const w = workspace();
    const big = new Uint8Array(33 * 1024 * 1024); // over the 32 MiB crossing cap
    big[0] = 7;
    w.files['big.bin'] = { data: big };
    const r = await syncWork(w, 'c1');
    expect(r.skipped).toContain('big.bin');
    expect(fs.get('shell/work/c1/big.bin')).toBeUndefined();
    // and the pass that used to prefer the shell side cannot empty it
    await syncWork(w, 'c1', { prefer: 'b' });
    expect(w.files['big.bin'].data.byteLength).toBe(big.byteLength);
  });

  it('a zero-byte file in the shell never replaces real content', async () => {
    const w = workspace();
    w.files['keep.bin'] = { data: enc('important') };
    await syncWork(w, 'c1');
    fs.put('shell/work/c1/keep.bin', ''); // what a failed write used to leave behind
    const r = await syncWork(w, 'c1', { prefer: 'b' });
    expect(dec(w.files['keep.bin'].data)).toBe('important');
    expect(fs.get('shell/work/c1/keep.bin')).toBe('important');
    expect(r.conflicts).toContain('keep.bin');
  });

  it('a failed write leaves no half file under the real name', async () => {
    const w = workspace();
    w.files['a.bin'] = { data: enc('first') };
    await syncWork(w, 'c1');
    expect(fs.get('shell/work/c1/a.bin')).toBe('first');

    // the next write fails half way (a chunk it cannot allocate)
    const realAppend = fs.appendFile;
    fs.appendFile = async () => {
      throw new Error('Failed to allocate');
    };
    const huge = new Uint8Array(5 * 1024 * 1024); // 2 chunks
    huge[0] = 9;
    w.files['a.bin'] = { data: huge };
    const r = await syncWork(w, 'c1'); // said, not thrown: one file that cannot cross does not stop the others
    expect(r.failed).toEqual([{ path: 'a.bin', error: 'Failed to allocate' }]);
    expect(r.note).toMatch(/could NOT copy a\.bin \(Failed to allocate\)/);
    fs.appendFile = realAppend;
    // the old, complete copy is still what the shell sees - no zero-byte corpse
    expect(fs.get('shell/work/c1/a.bin')).toBe('first');
    expect(fs.files.has('/data/shell/work/c1/a.bin.ocm-tmp')).toBe(false);
  });

  it('carries the exec bit, so a script the app rewrites still runs', async () => {
    fs.put('shell/work/c1/run.sh', '#!/bin/sh\necho hi');
    modes.set('/data/shell/work/c1/run.sh', 0o755); // created in the shell with chmod +x
    const w = workspace();

    await syncWork(w, 'c1'); // download: the mode comes with it
    expect(w.files['run.sh'].exec).toBe(true);

    w.files['run.sh'] = { data: enc('#!/bin/sh\necho changed'), exec: true }; // the app edits the script
    await syncWork(w, 'c1'); // upload: a plain write would leave it 600
    expect((modes.get('/data/shell/work/c1/run.sh') || 0) & 0o111).not.toBe(0);
    expect(fs.get('shell/work/c1/run.sh')).toBe('#!/bin/sh\necho changed');
  });

  it('a refused file leaves no name behind, its delete reaches the placeholder, and nothing re-reports', async () => {
    const w = workspace();
    // the shape the device produced: an empty copy on the shell side, agreed once, then a real file over the cap
    fs.put('shell/work/c1/output/_p1.bin', '');
    await syncWork(w, 'c1');
    expect(w.files['output/_p1.bin'].data.byteLength).toBe(0);
    w.files['output/_p1.bin'] = { data: new Uint8Array(34 * 1024 * 1024) };

    const r1 = await syncWork(w, 'c1');
    expect(fs.files.has('/data/shell/work/c1/output/_p1.bin')).toBe(false); // [ ! -e ] in the shell
    expect(r1.note).toContain('kept in the shell only: output/_p1.bin');
    expect(r1.note).not.toContain('disagreed');
    expect(w.files['output/_p1.bin'].data.byteLength).toBe(34 * 1024 * 1024); // the original is intact

    for (let i = 0; i < 3; i++) expect((await syncWork(w, 'c1', { prefer: i % 2 ? 'a' : 'b' })).note).not.toContain('_p1.bin');

    delete w.files['output/_p1.bin'];
    const r2 = await syncWork(w, 'c1');
    expect(fs.files.has('/data/shell/work/c1/output/_p1.bin')).toBe(false);
    expect(w.files['output/_p1.bin']).toBeUndefined();
    for (let i = 0; i < 3; i++) expect((await syncWork(w, 'c1')).note).not.toContain('_p1.bin');
    expect(r2.note || '').not.toContain('could NOT');
  });

  it('a placeholder left by an older build is deleted by name when the real file goes', async () => {
    const w = workspace();
    w.files['big.bin'] = { data: new Uint8Array(34 * 1024 * 1024) };
    await syncWork(w, 'c1'); // refused: state knows only the app side
    fs.put('shell/work/c1/big.bin', ''); // an empty name appears on the shell side by any route
    delete w.files['big.bin'];
    await syncWork(w, 'c1', { prefer: 'b' });
    expect(fs.files.has('/data/shell/work/c1/big.bin')).toBe(false);
    expect(w.files['big.bin']).toBeUndefined(); // and it was not copied into the app as an empty file
  });

  it('an empty file that crosses is announced with who wrote it', async () => {
    const w = workspace();
    wsPut(w, 'made-by-app.txt', '');
    const r1 = await syncWork(w, 'c1');
    expect(r1.note).toContain('an EMPTY file crossed: made-by-app.txt (written by the app)');
    fs.put('shell/work/c1/made-in-shell.txt', '');
    const r2 = await syncWork(w, 'c1', { prefer: 'b' });
    expect(r2.note).toContain('made-in-shell.txt (written by the shell)');
    w.files['py.txt'] = { data: new Uint8Array(0), by: 'python' };
    expect((await syncWork(w, 'c1')).note).toContain('py.txt (written by python)');
    wsPut(w, 'full.txt', 'x');
    expect((await syncWork(w, 'c1')).note || '').not.toContain('EMPTY');
  });

  it('a delete that did not happen is said, not counted as done', async () => {
    const w = workspace();
    w.files['keep.txt'] = { data: enc('x') };
    await syncWork(w, 'c1');
    const real = fs.deleteFile;
    fs.deleteFile = async () => {}; // the platform refuses silently
    delete w.files['keep.txt'];
    const r = await syncWork(w, 'c1');
    fs.deleteFile = real;
    expect(r.note).toContain('could NOT delete keep.txt');
    expect(r.note).not.toContain('deleted on both sides');
    const again = await syncWork(w, 'c1'); // and it is tried again
    expect(again.note).toContain('deleted on both sides (keep.txt)');
    expect(fs.files.has('/data/shell/work/c1/keep.txt')).toBe(false);
  });

  it('falls back to one execs call when the plugin cannot list modes', async () => {
    fs.put('shell/work/c1/a.sh', '#!/bin/sh\n');
    fs.put('shell/work/c1/sub/b.txt', 'b');
    let stats = 0;
    let lists = 0;
    // an older build of the plugin: execs, but no modes()
    globalThis.__ocmMode = {
      chmod: globalThis.__ocmMode.chmod,
      stat: async () => (stats++, { exists: true, executable: false }),
      execs: async ({ path }) => (lists++, { paths: path === 'shell/work/c1' ? ['a.sh'] : [] }),
    };
    const w = workspace();
    await syncWork(w, 'c1');
    expect(lists).toBe(1);
    expect(stats).toBe(0);
    expect(w.files['a.sh'].exec).toBe(true);
    expect(w.files['sub/b.txt'].exec).toBe(false);
  });

  it('falls back to a stat per file when the plugin can list neither', async () => {
    fs.put('shell/work/c1/conf', 'c');
    modes.set('/data/shell/work/c1/conf', 0o640);
    let stats = 0;
    const { stat } = globalThis.__ocmMode;
    globalThis.__ocmMode = {
      chmod: globalThis.__ocmMode.chmod,
      stat: async (a) => (stats++, stat(a)),
    };
    const w = workspace();
    await syncWork(w, 'c1');
    expect(stats).toBeGreaterThan(0);
    expect(w.files['conf'].mode).toBe(0o640);
    expect(w.files['conf'].exec).toBe(false);
  });

  it('reads the whole tree\'s modes in one native call, with no stat per file', async () => {
    fs.put('shell/work/c1/a.sh', '#!/bin/sh\n');
    fs.put('shell/work/c1/sub/b.txt', 'b');
    modes.set('/data/shell/work/c1/a.sh', 0o755);
    modes.set('/data/shell/work/c1/sub/b.txt', 0o600);
    let stats = 0;
    let calls = 0;
    const real = globalThis.__ocmMode;
    globalThis.__ocmMode = {
      ...real,
      stat: async (a) => (stats++, real.stat(a)),
      modes: async (a) => (calls++, real.modes(a)),
    };
    const w = workspace();
    await syncWork(w, 'c1');
    expect(calls).toBe(1);
    expect(stats).toBe(0);
    expect(w.files['a.sh'].mode).toBe(0o755);
    expect(w.files['a.sh'].exec).toBe(true);
    expect(w.files['sub/b.txt'].mode).toBe(0o600);
    expect(w.files['sub/b.txt'].exec).toBe(false);
  });

  it('a shell 644 arrives as 644, not as 666 with the write bits added', async () => {
    fs.put('shell/work/c1/notes.txt', 'n');
    modes.set('/data/shell/work/c1/notes.txt', 0o644);
    const w = workspace();
    await syncWork(w, 'c1');
    expect(w.files['notes.txt'].mode).toBe(0o644);
    expect(w.files['notes.txt'].exec).toBe(false);
  });

  it('a shell 600 keeps its protection', async () => {
    fs.put('shell/work/c1/secret.key', 'k');
    modes.set('/data/shell/work/c1/secret.key', 0o600);
    const w = workspace();
    await syncWork(w, 'c1');
    expect(w.files['secret.key'].mode).toBe(0o600);
    expect(w.files['secret.key'].mode & 0o077).toBe(0); // nothing for the group, nothing for the world
    expect(w.files['secret.key'].exec).toBe(false);
  });

  it('a mode the app states reaches the shell exactly', async () => {
    const w = workspace();
    wsPut(w, 'secret.key', 'k', { mode: 0o640 });
    expect(w.files['secret.key'].mode).toBe(0o640);
    expect(w.files['secret.key'].exec).toBe(false);
    await syncWork(w, 'c1');
    expect(modes.get('/data/shell/work/c1/secret.key')).toBe(0o640);
    expect(w.shellState['secret.key'].b.mode).toBe(0o640);
  });

  it('a chmod with the same bytes crosses both ways', async () => {
    fs.put('shell/work/c1/conf', 'same bytes');
    modes.set('/data/shell/work/c1/conf', 0o644);
    const w = workspace();
    await syncWork(w, 'c1');
    expect(w.files['conf'].mode).toBe(0o644);

    // chmod 600 in the shell: same size, same mtime, same bytes
    modes.set('/data/shell/work/c1/conf', 0o600);
    const down = await syncWork(w, 'c1');
    expect(down.down).toBe(1);
    expect(w.files['conf'].mode).toBe(0o600);
    expect(dec(w.files['conf'].data)).toBe('same bytes');

    // and back: the app sets 640, the bytes do not move
    wsPut(w, 'conf', enc('same bytes'), { mode: 0o640 });
    const up = await syncWork(w, 'c1');
    expect(up.up).toBe(1);
    expect(modes.get('/data/shell/work/c1/conf')).toBe(0o640);
    expect(fs.get('shell/work/c1/conf')).toBe('same bytes');
  });

  it('a state entry with an exec bit but no mode does not trigger a copy', async () => {
    fs.put('shell/work/c1/old.txt', 'same');
    modes.set('/data/shell/work/c1/old.txt', 0o644);
    const w = workspace();
    await syncWork(w, 'c1');

    // what a state persisted before modes were carried looks like: exec, no mode
    for (const e of Object.values(w.shellState)) {
      if (e.a) delete e.a.mode;
      if (e.b) delete e.b.mode;
    }
    const before = fs.readCount();
    const r = await syncWork(w, 'c1');
    expect(r.up).toBe(0);
    expect(r.down).toBe(0);
    expect(fs.readCount()).toBe(before);
  });

  it('a file the app marks executable crosses to the shell with mode 755', async () => {
    const w = workspace();
    wsPut(w, 'deploy.sh', '#!/bin/sh\necho deploying', { exec: true });
    expect(w.files['deploy.sh'].exec).toBe(true);
    await syncWork(w, 'c1');
    expect((modes.get('/data/shell/work/c1/deploy.sh') || 0) & 0o111).not.toBe(0);
    expect(fs.get('shell/work/c1/deploy.sh')).toBe('#!/bin/sh\necho deploying');
  });

  it('an executable in the shell arrives with exec, and an app edit that says nothing keeps it', async () => {
    fs.put('shell/work/c1/tool.sh', '#!/bin/sh\n');
    modes.set('/data/shell/work/c1/tool.sh', 0o755);
    const w = workspace();

    await syncWork(w, 'c1');
    expect(w.files['tool.sh'].exec).toBe(true);

    // write_file from the app, with no mode in the call: the file is still a script
    wsPut(w, 'tool.sh', enc('#!/bin/sh\necho edited'));
    expect(w.files['tool.sh'].exec).toBe(true);
    await syncWork(w, 'c1');
    expect((modes.get('/data/shell/work/c1/tool.sh') || 0) & 0o111).not.toBe(0);
    expect(fs.get('shell/work/c1/tool.sh')).toBe('#!/bin/sh\necho edited');
  });

  it('the worker is told the mode in the same message as the bytes', () => {
    const w = workspace();
    const msgs = [];
    const realWorker = sandbox.worker;
    const realConv = sandbox.convId;
    sandbox.convId = w.id; // as if this chat's sandbox were running
    sandbox.worker = { postMessage: (m) => msgs.push(m) };
    try {
      wsPut(w, 'run.sh', '#!/bin/sh\n', { exec: true });
      wsPut(w, 'notes.txt', 'hello');
      expect(msgs[0]).toMatchObject({ type: 'write', files: [{ path: 'run.sh', exec: true }] });
      expect(msgs[1].files[0].exec).toBe(false);
    } finally {
      sandbox.worker = realWorker;
      sandbox.convId = realConv;
    }
  });

  it('a mode-only change crosses on the next sync, both ways, with the bytes untouched', async () => {
    const w = workspace();
    w.files['run.sh'] = { data: enc('echo hi') };
    await syncWork(w, 'c1');
    expect((modes.get('/data/shell/work/c1/run.sh') || 0) & 0o111).toBe(0);

    // chmod +x in the shell: same size, same mtime, same bytes
    modes.set('/data/shell/work/c1/run.sh', 0o755);
    const down = await syncWork(w, 'c1');
    expect(down.down).toBe(1);
    expect(w.files['run.sh'].exec).toBe(true);
    expect(dec(w.files['run.sh'].data)).toBe('echo hi');

    // and back: the app takes the bit away
    wsPut(w, 'run.sh', enc('echo hi'), { exec: false });
    const up = await syncWork(w, 'c1');
    expect(up.up).toBe(1);
    expect((modes.get('/data/shell/work/c1/run.sh') || 0) & 0o111).toBe(0);
  });

  it('a state saved before modes were recorded does not re-copy the world', async () => {
    const w = workspace();
    w.files['a.txt'] = { data: enc('a') };
    w.files['b.txt'] = { data: enc('b') };
    await syncWork(w, 'c1');

    // what a state persisted by an older build looks like: no exec anywhere
    for (const e of Object.values(w.shellState)) {
      if (e.a) delete e.a.exec;
      if (e.b) delete e.b.exec;
    }
    const before = fs.readCount();
    const r = await syncWork(w, 'c1');
    expect(r.up).toBe(0);
    expect(r.down).toBe(0);
    expect(fs.readCount()).toBe(before); // nothing was read, so nothing was copied
  });

  it('prunes the directories a deleted file was the last one in', async () => {
    fs.put('shell/work/c1/deep/a/b/f.txt', 'x');
    fs.dirs.add('/data/shell/work/c1/deep');
    fs.dirs.add('/data/shell/work/c1/deep/a');
    fs.dirs.add('/data/shell/work/c1/deep/a/b');
    const w = workspace();
    await syncWork(w, 'c1');
    expect(w.files['deep/a/b/f.txt']).toBeTruthy();

    delete w.files['deep/a/b/f.txt']; // deleted in the app
    await syncWork(w, 'c1');
    expect(fs.get('shell/work/c1/deep/a/b/f.txt')).toBeUndefined();
    expect([...fs.dirs].some((d) => d.startsWith('/data/shell/work/c1/deep'))).toBe(false);
  });

  it('handles names with spaces, quotes and Japanese - paths never go through a shell word', async () => {
    const w = workspace();
    const names = ['my notes (v2).txt', "it's a file.txt", '日本語のファイル.txt', 'a'.repeat(120) + '.txt'];
    names.forEach((n, i) => (w.files[n] = { data: enc('content ' + i) }));
    const r = await syncWork(w, 'c1');
    expect(r.up).toBe(names.length);
    for (const n of names) expect(fs.get('shell/work/c1/' + n)).toMatch(/^content /);

    // a delete round-trip on an awkward name
    delete w.files["it's a file.txt"];
    const r2 = await syncWork(w, 'c1');
    expect(r2.deletedB).toBe(1);
    expect(fs.get('shell/work/c1/' + "it's a file.txt")).toBeUndefined();
  });

  it('reports what happened, so the result can say it', async () => {
    const w = workspace();
    w.files['a.txt'] = { data: enc('a') };
    const prep = await prepareShell({ w, ctx: { convId: 'c1', workspace: w, phone: { folder: () => null } }, convId: 'c1', mount: await mountSpec({ phone: { folder: () => null } }, 'c1') });
    expect(prep.note).toMatch(/1 file into \/workspace/);
  });
});

describe('the phone folder when it cannot be bound', () => {
  it('copies it in, and saves what the shell writes back', async () => {
    disk = { 'todo.md': enc('buy milk') };
    phoneStub(null);
    const w = workspace();
    const folder = { uri: 'content://p', name: 'Projects' };
    const ctx = { convId: 'c1', workspace: w, phone: { folder: () => folder, mode: () => 'auto', stage: new Map(), log: [] } };

    const inNote = await syncPhoneIn(folder, 'c1', w);
    expect(inNote.wrote).toBe(1);
    expect(fs.get('shell/phone/c1/todo.md')).toBe('buy milk');

    fs.put('shell/phone/c1/report.txt', 'done');
    const out = await syncPhoneOut(folder, 'c1', w, ctx);
    expect(out.saved).toBe(1);
    expect(dec(disk['report.txt'])).toBe('done');
    expect(ctx.phone.log.map((e) => e.path)).toEqual(['report.txt']);
  });

  it('a file too big to carry through memory is streamed by Android; review asks first; one still being written waits', async () => {
    disk = {};
    phoneStub(null);
    const exported = [];
    globalThis.__ocmPhoneFolder.exportLinuxFile = async (o) => (exported.push(o), { name: o.path, folder: 'Projects', bytes: fs.files.get('/data/shell/' + o.guest)?.bytes.length ?? 0 });
    const keep = LIMITS.phoneFile;
    LIMITS.phoneFile = 8;
    try {
      const w = workspace();
      const folder = { uri: 'content://p', name: 'Projects' };
      const asked = [];
      const ctx = (mode, answer) => ({ convId: 'c1', workspace: w, ask: async (q) => (asked.push(q), answer), phone: { folder: () => folder, mode: () => mode, stage: new Map(), log: [] } });
      fs.put('shell/phone/c1/rec/out.mp4', 'a recording of many bytes');
      const auto = await syncPhoneOut(folder, 'c1', w, ctx('auto'));
      expect(exported).toEqual([{ guest: 'phone/c1/rec/out.mp4', base: 'shell', uri: 'content://p', path: 'rec/out.mp4' }]);
      expect(auto.note).toMatch(/saved to the phone: rec\/out.mp4/);
      // review mode: asked, and "not now" saves nothing (and is not asked again for the same file)
      fs.put('shell/phone/c1/b.mp4', 'another long recording');
      const no = await syncPhoneOut(folder, 'c1', w, ctx('ask', 'Not now'));
      expect(asked[0]).toMatch(/b.mp4 .* Save it into “Projects”/);
      expect(exported).toHaveLength(1);
      expect(no.note).toMatch(/you said not now/);
      await syncPhoneOut(folder, 'c1', w, ctx('ask', 'Save it'));
      expect(asked).toHaveLength(1);
      // a file that changed a moment ago is still being written: it waits
      fs.put('shell/phone/c1/live.mp4', 'still recording here');
      fs.files.get('/data/shell/phone/c1/live.mp4').mtime = Date.now();
      const live = await syncPhoneOut(folder, 'c1', w, ctx('auto'));
      expect(live.note).toMatch(/still being written/);
      expect(exported.some((o) => o.path === 'live.mp4')).toBe(false);
    } finally {
      LIMITS.phoneFile = keep;
    }
  });

  it('removes a file from /phone when it was deleted on the phone', async () => {
    disk = { 'a.txt': enc('a'), 'b.txt': enc('b') };
    phoneStub(null);
    const w = workspace();
    const folder = { uri: 'content://p', name: 'Projects' };
    await syncPhoneIn(folder, 'c1', w);
    expect(fs.get('shell/phone/c1/b.txt')).toBe('b');

    delete disk['b.txt'];
    const r = await syncPhoneIn(folder, 'c1', w);
    expect(fs.get('shell/phone/c1/b.txt')).toBeUndefined();
    expect(r.note).toMatch(/removed from \/phone/);
  });

  it('a listing cut at the limit removes nothing from /phone', async () => {
    disk = { 'a.txt': enc('a'), 'b.txt': enc('b'), 'c.txt': enc('c') };
    phoneStub(null);
    const w = workspace();
    const folder = { uri: 'content://p', name: 'Projects' };
    await syncPhoneIn(folder, 'c1', w);
    expect(fs.get('shell/phone/c1/c.txt')).toBe('c');
    const list = globalThis.__ocmPhoneFolder.list;
    const keep = LIMITS.phoneFiles;
    try {
      LIMITS.phoneFiles = 2;
      globalThis.__ocmPhoneFolder.list = async (o) => ({ entries: (await list(o)).entries.slice(0, o.max) });
      const r = await syncPhoneIn(folder, 'c1', w);
      expect(fs.get('shell/phone/c1/c.txt')).toBe('c'); // not reached by the listing: still there
      expect(r.note).toMatch(/nothing was removed from \/phone/);
    } finally {
      LIMITS.phoneFiles = keep;
      globalThis.__ocmPhoneFolder.list = list;
    }
  });

  it('binds the folder instead when Android gives a real path', async () => {
    phoneStub('/storage/emulated/0/Projects');
    const folder = { uri: 'content://p', name: 'Projects' };
    // only in Auto: in Review and Read-only a bind would write to the phone past the chat's mode
    for (const mode of ['ask', 'readonly']) expect((await mountSpec({ phone: { folder: () => folder, mode: () => mode } }, 'c1')).mode).toBe('mirror');
    const m = await mountSpec({ phone: { folder: () => folder, mode: () => 'auto' } }, 'c1');
    expect(m.mode).toBe('bind');
    expect(m.mounts).toContain('/storage/emulated/0/Projects:' + PHONE);
    expect(m.mounts).toContain(':' + WORK);
  });
});

describe('dates cross the mirror', () => {
  it('a file from the shell keeps its own date in the workspace, and a touch alone carries the new date', async () => {
    const w = workspace();
    fs.put('shell/work/c1/tfiles/old.txt', 'old');
    fs.files.get('/data/shell/work/c1/tfiles/old.txt').mtime = 1767605400000; // touch -d 2026-01-05T09:30:00Z
    await syncWork(w, 'c1');
    expect(w.files['tfiles/old.txt'].mtime).toBe(1767605400000);
    // same bytes, another date (touch -d again): the workspace copy follows
    fs.files.get('/data/shell/work/c1/tfiles/old.txt').mtime = 1767000000000;
    await syncWork(w, 'c1');
    expect(w.files['tfiles/old.txt'].mtime).toBe(1767000000000);
  });
});
