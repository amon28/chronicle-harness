// A Python run that is stopped mid-way (a cancelled ask_model job, Stop, a time-out) keeps the files it had finished
// writing until then (decision 183): the worker sends each one as it is closed, and the stop puts them in the chat.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/store.js', () => ({ workspaces: { put: async () => {} } }));
vi.mock('../../src/shellfs.js', () => ({ forgetChat: async () => {} }));
const { sandbox, conflictText } = await import('../../src/sandbox.js');

const enc = (s) => new TextEncoder().encode(s);
const dec = (u8) => new TextDecoder().decode(u8);
const workers = [];
class FakeWorker {
  constructor() {
    this.terminated = false;
    workers.push(this);
  }
  postMessage(m) {
    setTimeout(() => {
      if (m.type === 'init') this.onmessage({ data: { type: 'ready' } });
      if (m.type === 'run' && globalThis.__pyRun) return globalThis.__pyRun(this, m);
      if (m.type === 'run') {
        // "partial" written and closed, then the run sleeps 90 s: no result comes
        this.onmessage({ data: { type: 'wrote', id: m.id, path: 'r4_cancel.txt', data: enc('partial'), mode: 0o644, exec: false, mtime: Date.now() } });
        this.onmessage({ data: { type: 'gone', id: m.id, path: 'old.txt' } });
      }
    }, 5);
  }
  terminate() {
    this.terminated = true;
  }
}
globalThis.Worker = FakeWorker;

describe('a stopped Python run', () => {
  it('its signal ends the worker at once and keeps what it had written', async () => {
    const w = { id: 'c1', files: Object.assign(Object.create(null), { 'old.txt': { data: enc('o'), mtime: 1 } }) };
    const ac = new AbortController();
    const run = sandbox.run(w, 'open("r4_cancel.txt","w").write("partial"); time.sleep(90)', { owner: 'c1', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 40));
    ac.abort();
    const err = await run.catch((e) => e);
    expect(err.message).toMatch(/^Stopped: the Python run was ended mid-way\. It had already written 2 files, kept: r4_cancel\.txt, old\.txt \(deleted\)\./);
    expect(err.kept).toEqual(['r4_cancel.txt', 'old.txt (deleted)']);
    expect(dec(w.files['r4_cancel.txt'].data)).toBe('partial');
    expect(w.files['old.txt']).toBeUndefined();
    expect(workers.at(-1).terminated).toBe(true);
  });
  it('a signal stopped before the run began: nothing runs', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await sandbox.run({ id: 'c2', files: Object.create(null) }, 'print(1)', { signal: ac.signal }).catch((e) => e);
    expect(err.message).toBe('Stopped');
  });
  it('a file changed elsewhere while Python ran is a conflict: the newer write is the file, the other kept beside it (decision 188)', async () => {
    const w = { id: 'c3', files: Object.assign(Object.create(null), { 'collide.txt': { data: enc('BASE'), mtime: 1000 }, 'keep.txt': { data: enc('k'), mtime: 1000 } }) };
    // the run sleeps 25 s; 6 s in, Claude Code writes LOCAL (a sync brings it into the chat's files); then Python writes
    // HELPER (newer), and deletes keep.txt – which was also changed meanwhile
    globalThis.__pyRun = (worker, m) => {
      setTimeout(() => {
        w.files['collide.txt'] = { data: enc('LOCAL'), mtime: Date.now() - 5000 };
        w.files['keep.txt'] = { data: enc('k2'), mtime: Date.now() - 5000 };
      }, 5);
      setTimeout(() => worker.onmessage({ data: { type: 'result', id: m.id, stdout: '', stderr: '', changed: [{ path: 'collide.txt', data: enc('HELPER'), mode: 0o644, mtime: Date.now() }, { path: 'a.txt', data: enc('a'), mode: 0o644, mtime: Date.now() }], deleted: ['keep.txt'] } }), 30);
    };
    const r = await sandbox.run(w, 'helper', { owner: 'c3' });
    delete globalThis.__pyRun;
    expect(dec(w.files['collide.txt'].data)).toBe('HELPER');
    expect(dec(w.files['collide.conflict-other.txt'].data)).toBe('LOCAL'); // nothing lost
    expect(dec(w.files['a.txt'].data)).toBe('a'); // an ordinary write: no conflict
    expect(dec(w.files['keep.txt'].data)).toBe('k2'); // its delete is not done: it was changed meanwhile
    expect(r.conflicts).toEqual([
      { path: 'collide.txt', kept: 'collide.conflict-other.txt', winner: 'python' },
      { path: 'keep.txt', kept: '', winner: 'other', deleted: true },
    ]);
    expect(conflictText(r.conflicts)).toMatch(/^CONFLICT: collide\.txt was changed elsewhere while this Python ran – Python's write is newer and is the file now; the other version is kept as collide\.conflict-other\.txt\nCONFLICT: keep\.txt .*its delete was not done/);
  });
  it('a file nobody else touched is just written, as before', async () => {
    const w = { id: 'c4', files: Object.assign(Object.create(null), { 'x.txt': { data: enc('old'), mtime: 1000 } }) };
    globalThis.__pyRun = (worker, m) => setTimeout(() => worker.onmessage({ data: { type: 'result', id: m.id, stdout: '', stderr: '', changed: [{ path: 'x.txt', data: enc('new'), mode: 0o644, mtime: Date.now() }], deleted: [] } }), 10);
    const r = await sandbox.run(w, 'x', { owner: 'c4' });
    delete globalThis.__pyRun;
    expect(dec(w.files['x.txt'].data)).toBe('new');
    expect(r.conflicts).toEqual([]);
    expect(Object.keys(w.files)).toEqual(['x.txt']);
  });
});
