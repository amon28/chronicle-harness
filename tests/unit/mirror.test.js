import { describe, it, expect } from 'vitest';
import { reconcile, changed } from '../../src/mirror.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (u8) => (u8 ? new TextDecoder().decode(u8) : undefined);

/** A side of the tree. withHash: content identity (the workspace); otherwise size+mtime (the disk). */
function mkSide(withHash) {
  const files = new Map(); // path -> { bytes: Uint8Array, mtime }
  let clock = 1;
  let reads = 0;
  return {
    files,
    reads: () => reads,
    set(p, content) {
      files.set(p, { bytes: enc(content), mtime: ++clock });
    },
    async list() {
      const m = new Map();
      for (const [p, f] of files) m.set(p, withHash ? { size: f.bytes.length, hash: dec(f.bytes) } : { size: f.bytes.length, mtime: f.mtime });
      return m;
    },
    async read(p) {
      reads++;
      return files.get(p).bytes;
    },
    async write(p, bytes) {
      const e = { bytes, mtime: ++clock };
      files.set(p, e);
      return withHash ? { size: bytes.length, hash: dec(bytes) } : { size: bytes.length, mtime: e.mtime };
    },
    async remove(p) {
      files.delete(p);
    },
  };
}

const content = (side, p) => dec(side.files.get(p)?.bytes);
const NL = String.fromCharCode(10);

describe('reconciler', () => {
  it('copies what is new in either direction', async () => {
    const a = mkSide(true);
    const b = mkSide(false);
    const state = {};
    a.set('notes.txt', 'hello');
    let r = await reconcile(a, b, state);
    expect(r.up).toBe(1);
    expect(content(b, 'notes.txt')).toBe('hello');

    b.set('out.csv', 'a,b');
    r = await reconcile(a, b, state);
    expect(r.down).toBe(1);
    expect(content(a, 'out.csv')).toBe('a,b');
  });

  it('follows an edit on the side that changed, and gives the shell the last word', async () => {
    const a = mkSide(true);
    const b = mkSide(false);
    const state = {};
    a.set('f.txt', 'one');
    await reconcile(a, b, state);

    b.set('f.txt', 'two-from-shell');
    let r = await reconcile(a, b, state, { prefer: 'b' });
    expect(r.down).toBe(1);
    expect(content(a, 'f.txt')).toBe('two-from-shell');

    a.set('f.txt', 'three-from-app');
    r = await reconcile(a, b, state, { prefer: 'a' });
    expect(r.up).toBe(1);
    expect(content(b, 'f.txt')).toBe('three-from-app');
  });

  it('deletes on the other side - the reason this is not a copy', async () => {
    const a = mkSide(true);
    const b = mkSide(false);
    const state = {};
    a.set('keep.txt', 'k');
    a.set('secret.key', 'AES-KEY');
    await reconcile(a, b, state);
    expect(content(b, 'secret.key')).toBe('AES-KEY');

    // the app deletes it (a tool cleaning up after itself)
    a.files.delete('secret.key');
    const r = await reconcile(a, b, state);
    expect(r.deletedB).toBe(1);
    expect(content(b, 'secret.key')).toBeUndefined();

    // and the shell deleting something removes it from the app
    b.files.delete('keep.txt');
    const r2 = await reconcile(a, b, state);
    expect(r2.deletedA).toBe(1);
    expect(content(a, 'keep.txt')).toBeUndefined();
  });

  it('does not delete what it has never seen: a new file on one side is copied, not tombstoned', async () => {
    const a = mkSide(true);
    const b = mkSide(false);
    const state = {};
    b.set('made-in-shell.txt', 'x');
    const r = await reconcile(a, b, state);
    expect(r.down).toBe(1);
    expect(content(a, 'made-in-shell.txt')).toBe('x');
    expect(r.deletedA + r.deletedB).toBe(0);
  });

  it('refuses a file over the limit once, then leaves it alone', async () => {
    const a = mkSide(true);
    const b = mkSide(false);
    const state = {};
    a.set('big.bin', 'x'.repeat(200));
    const r = await reconcile(a, b, state, { fileBytes: 100 });
    expect(r.skipped).toEqual(['big.bin']);
    expect(content(b, 'big.bin')).toBeUndefined();

    const readsBefore = a.reads();
    const r2 = await reconcile(a, b, state, { fileBytes: 100 });
    expect(r2.skipped).toEqual([]); // silent the second time
    expect(a.reads()).toBe(readsBefore); // and it did not read the file again
    expect(content(b, 'big.bin')).toBeUndefined(); // nor did it delete anything

    a.set('big.bin', 'small'); // it changed: try again
    const r3 = await reconcile(a, b, state, { fileBytes: 100 });
    expect(content(b, 'big.bin')).toBe('small');
    expect(r3.up).toBe(1);
  });

  it('stops at the per-command budget instead of crawling', async () => {
    const a = mkSide(true);
    const b = mkSide(false);
    const state = {};
    a.set('a.bin', 'x'.repeat(60));
    a.set('b.bin', 'y'.repeat(60));
    const r = await reconcile(a, b, state, { fileBytes: 100, totalBytes: 80 });
    expect(r.up).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(content(b, 'a.bin')).toBeDefined();
    expect(content(b, 'b.bin')).toBeUndefined();
  });

  it('never lets an empty copy replace content - that is a failed transfer, not an edit', async () => {
    const a = mkSide(true);
    const b = mkSide(false);
    const state = {};
    a.set('key.bin', 'IMPORTANT');
    await reconcile(a, b, state);

    b.set('key.bin', ''); // a write that allocated, failed and left zero bytes
    const r = await reconcile(a, b, state, { prefer: 'b' });
    expect(content(a, 'key.bin')).toBe('IMPORTANT'); // not lost
    expect(content(b, 'key.bin')).toBe('IMPORTANT'); // and put back
    expect(r.conflicts).toContain('key.bin');
  });

  it('does not guess silently when both sides have content and nothing was agreed', async () => {
    const a = mkSide(true);
    const b = mkSide(false);
    const state = {};
    a.set('f.txt', 'app-version');
    await new Promise((r) => setTimeout(r, 2));
    b.set('f.txt', 'shell-version-newer');
    const r = await reconcile(a, b, state, { prefer: 'a' });
    expect(content(a, 'f.txt')).toBe('shell-version-newer'); // newer mtime wins
    expect(r.conflicts).toContain('f.txt'); // and it says so
  });

  it('a first meeting with an empty copy is "nothing yet": the content crosses, without a warning', async () => {
    const a = mkSide(false);
    const b = mkSide(false);
    a.set('hb.txt', '');
    b.set('hb.txt', '1\n2\n');
    const r = await reconcile(a, b, {});
    expect(content(a, 'hb.txt')).toBe('1\n2\n');
    expect(r.conflicts).toEqual([]);
  });

  it('a file that only grew (a log, a heartbeat) is taken quietly; a longer but OLDER copy is still a conflict', async () => {
    const a = mkSide(false);
    const b = mkSide(false);
    a.files.set('log.txt', { bytes: enc('1\n2\n'), mtime: 10 });
    b.files.set('log.txt', { bytes: enc('1\n2\n3\n4\n'), mtime: 20 });
    const r = await reconcile(a, b, {});
    expect(content(a, 'log.txt')).toBe('1\n2\n3\n4\n');
    expect(r.conflicts).toEqual([]);
    // no line is ever dropped as it goes on growing
    const st = {};
    for (let n = 1; n <= 20; n++) {
      const text = Array.from({ length: n }, (_, i) => i + '\n').join('');
      b.files.set('beat.txt', { bytes: enc(text), mtime: 100 + n });
      await reconcile(a, b, st);
      expect(content(a, 'beat.txt')).toBe(text);
    }

    const c = mkSide(false);
    const d = mkSide(false);
    c.files.set('jobs.json', { bytes: enc('[1,2]'), mtime: 20 });
    d.files.set('jobs.json', { bytes: enc('[1,2,3]'), mtime: 10 }); // longer, but left from earlier
    const r2 = await reconcile(c, d, {});
    expect(content(d, 'jobs.json')).toBe('[1,2]');
    expect(r2.conflicts).toContain('jobs.json');
  });

  it('a file that grew between listing and reading crosses as read, without a warning, on every sync', async () => {
    const a = mkSide(false);
    const b = mkSide(false);
    const st = {};
    b.set('hb.txt', '');
    await reconcile(a, b, st); // both agree on the empty file
    expect(content(a, 'hb.txt')).toBe('');
    let text = '';
    for (let n = 1; n <= 6; n++) {
      text += n + NL;
      b.set('hb.txt', text);
      const realRead = b.read.bind(b);
      b.read = async (p) => (b.set(p, text + 'x' + NL), realRead(p)); // one more line lands between list and read
      const r = await reconcile(a, b, st);
      b.read = realRead;
      expect(r.conflicts).toEqual([]);
      expect(content(a, 'hb.txt')).toBe(text + 'x' + NL);
      text += 'x' + NL;
    }
  });

  it('a copy that is still the agreed empty file is not a conflict when the other side writes to it', async () => {
    const a = mkSide(false);
    const b = mkSide(false);
    const st = {};
    a.set('log.txt', '');
    await reconcile(a, b, st);
    b.set('log.txt', 'line 1' + NL);
    const r = await reconcile(a, b, st);
    expect(content(a, 'log.txt')).toBe('line 1' + NL);
    expect(r.conflicts).toEqual([]);
  });

  it('does not trust a file that changed between listing and reading', async () => {
    const a = mkSide(true);
    const b = mkSide(false);
    const state = {};
    a.set('racy.bin', 'abc');
    const realList = a.list.bind(a);
    a.list = async () => {
      const m = await realList();
      m.set('racy.bin', { size: 99, hash: 'stale' }); // the listing says 99 bytes
      return m;
    };
    const r = await reconcile(a, b, state);
    expect(content(b, 'racy.bin')).toBeUndefined(); // nothing was written
    expect(r.conflicts).toContain('racy.bin');
  });

  it('tells changed from missing, per side', () => {
    expect(changed({ size: 1, hash: 'a' }, { size: 1, hash: 'b' })).toBe(true);
    expect(changed({ size: 1, hash: 'a' }, { size: 1, hash: 'a' })).toBe(false);
    expect(changed({ size: 2, mtime: 5 }, { size: 1, mtime: 5 })).toBe(true);
    expect(changed({ size: 1, mtime: 9 }, { size: 1, mtime: 5 })).toBe(true);
    expect(changed({ size: 1, mtime: 5 }, undefined)).toBe(true);
  });
});
