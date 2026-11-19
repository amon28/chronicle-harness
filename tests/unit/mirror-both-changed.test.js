// One file edited on both sides between two syncs (write_file while a job that also writes it is running; a file
// changed in the terminal and by the assistant). One copy has to win - but the edit that lost must be named, or the
// model goes on believing its acknowledged write is what the file holds.
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeFs } from './helpers/fakefs.js';
import { syncWork } from '../../src/bridge.js';
import { wsPut } from '../../src/sandbox.js';

const dec = (u8) => (u8 ? new TextDecoder().decode(u8) : undefined);
const W = 'shell/work/c1/';
let fs;
beforeEach(() => {
  fs = fakeFs();
  globalThis.__ocmFiles = fs;
  delete globalThis.__ocmMode;
});

describe('a file changed on both sides since the last sync', () => {
  it('after a command the shell wins, and the result says the app edit was replaced', async () => {
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'config.json', '{"v":1}');
    await syncWork(w, 'c1');
    wsPut(w, 'config.json', '{"v":2,"from":"write_file"}', { by: 'the assistant' }); // while the job runs
    fs.put(W + 'config.json', '{"v":3,"from":"the job"}');
    const r = await syncWork(w, 'c1', { prefer: 'b' });
    expect(dec(w.files['config.json'].data)).toBe('{"v":3,"from":"the job"}');
    expect(r.overwritten).toEqual([{ path: 'config.json', lost: 'a', kept: 'config.conflict-other.json' }]);
    expect(r.note).toMatch(/CONFLICT: config\.json.*changed on both sides.*copy on disk is the file now.*kept as config\.conflict-other\.json/);
    // the edit that lost is not gone (decision 182): kept beside it, and on both sides after the next sync
    expect(dec(w.files['config.conflict-other.json'].data)).toBe('{"v":2,"from":"write_file"}');
    await syncWork(w, 'c1', { prefer: 'b' });
    expect(fs.get(W + 'config.conflict-other.json')).toBe('{"v":2,"from":"write_file"}');
  });

  it('before a command the app wins, and that is said too', async () => {
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'config.json', '{"v":1}');
    await syncWork(w, 'c1');
    fs.put(W + 'config.json', '{"v":3,"from":"the terminal"}');
    wsPut(w, 'config.json', '{"v":2}', { by: 'the assistant' });
    const r = await syncWork(w, 'c1', { prefer: 'a' });
    expect(fs.get(W + 'config.json')).toBe('{"v":2}');
    expect(r.note).toMatch(/CONFLICT: config\.json.*changed on both sides.*app's copy is the file now.*kept as config\.conflict-other\.json/);
    expect(fs.get(W + 'config.conflict-other.json')).toBe('{"v":3,"from":"the terminal"}');
  });

  it('both sides only added to the end (two appends to a log): both additions are kept in the file (decision 183)', async () => {
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'r4_conf.txt', 'base\n');
    await syncWork(w, 'c1');
    fs.put(W + 'r4_conf.txt', 'base\nmain-edit\n');
    wsPut(w, 'r4_conf.txt', 'base\njob-edit\n', { by: 'python' });
    const r = await syncWork(w, 'c1', { prefer: 'a' });
    const both = fs.get(W + 'r4_conf.txt');
    expect(['base\nmain-edit\njob-edit\n', 'base\njob-edit\nmain-edit\n']).toContain(both);
    expect(dec(w.files['r4_conf.txt'].data)).toBe(both);
    expect(r.overwritten).toEqual([]);
    expect(r.note).toMatch(/MERGED: r4_conf\.txt had text added at the end on both sides/);
    expect(Object.keys(w.files).some((p) => /conflict/.test(p))).toBe(false);
    // and the next sync has nothing left to do
    const again = await syncWork(w, 'c1', { prefer: 'b' });
    expect(again.note || '').not.toMatch(/MERGED|CONFLICT/);
  });

  it('an edit that is not an append is still a conflict; a second one on the same file does not write over the first copy', async () => {
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'n.txt', 'base\n');
    await syncWork(w, 'c1');
    fs.put(W + 'n.txt', 'BASE changed\n');
    wsPut(w, 'n.txt', 'base\nmore\n');
    await syncWork(w, 'c1', { prefer: 'a' });
    expect(fs.get(W + 'n.conflict-other.txt')).toBe('BASE changed\n');
    fs.put(W + 'n.txt', 'third\n');
    wsPut(w, 'n.txt', 'fourth\n');
    const r = await syncWork(w, 'c1', { prefer: 'a' });
    expect(r.note).toMatch(/kept as n\.conflict-other-2\.txt/);
    expect(fs.get(W + 'n.conflict-other.txt')).toBe('BASE changed\n');
    expect(fs.get(W + 'n.conflict-other-2.txt')).toBe('third\n');
  });

  it('says nothing when only one side changed, or both made the same change', async () => {
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'a.txt', 'one');
    await syncWork(w, 'c1');
    fs.put(W + 'a.txt', 'two');
    const r = await syncWork(w, 'c1', { prefer: 'b' });
    expect(r.overwritten).toEqual([]);
    expect(r.note).not.toMatch(/both sides/);
  });

  it('an older copy arriving after a newer write in the shell does not replace it, even before a command', async () => {
    const T = 1763300000000;
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'collide.txt', 'START', { mtime: T });
    await syncWork(w, 'c1');
    // the shell writes A at t=0 and B at t=2; a copy dated t=1 comes in from outside at t=3
    fs.put(W + 'collide.txt', 'HELPER A');
    fs.files.get('/data/' + W + 'collide.txt').mtime = T + 10000;
    fs.put(W + 'collide.txt', 'HELPER B');
    fs.files.get('/data/' + W + 'collide.txt').mtime = T + 12000;
    wsPut(w, 'collide.txt', 'LOCAL 1', { mtime: T + 11000, by: 'Claude Code' });
    const r = await syncWork(w, 'c1', { prefer: 'a' });
    expect(fs.get(W + 'collide.txt')).toBe('HELPER B');
    expect(dec(w.files['collide.txt'].data)).toBe('HELPER B');
    expect(dec(w.files['collide.conflict-other.txt'].data)).toBe('LOCAL 1');
    expect(r.overwritten).toEqual([{ path: 'collide.txt', lost: 'a', kept: 'collide.conflict-other.txt' }]);
    expect(r.note).toMatch(/CONFLICT: collide\.txt.*copy on disk is the file now \(the newer write\).*kept as collide\.conflict-other\.txt/);
    await syncWork(w, 'c1');
    expect(fs.get(W + 'collide.conflict-other.txt')).toBe('LOCAL 1');
  });

  it('a shell write that lands while the app copy is going in is not written over (job_er36gs)', async () => {
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'collide.txt', 'START');
    await syncWork(w, 'c1');
    wsPut(w, 'collide.txt', 'LOCAL 11', { by: 'Claude Code' });
    // the listing is taken; before the copy is written, the helper's shell writes the file again
    const stat = fs.stat;
    let once = true;
    fs.stat = async (o) => {
      if (once && String(o.path).endsWith('collide.txt')) {
        once = false;
        fs.put(W + 'collide.txt', 'HELPER 12');
        fs.files.get('/data/' + W + 'collide.txt').mtime = Date.now() + 5000;
      }
      return stat(o);
    };
    const r = await syncWork(w, 'c1', { prefer: 'a' });
    fs.stat = stat;
    expect(fs.get(W + 'collide.txt')).toBe('HELPER 12');
    expect(dec(w.files['collide.txt'].data)).toBe('HELPER 12');
    expect(dec(w.files['collide.conflict-other.txt'].data)).toBe('LOCAL 11');
    expect(r.note).toMatch(/CONFLICT: collide\.txt/);
  });

  it('two syncs of one chat at the same time run one after the other', async () => {
    const w = { id: 'c1', files: {}, shellState: {} };
    let inside = 0;
    let most = 0;
    const readdir = fs.readdir;
    fs.readdir = async (o) => {
      most = Math.max(most, ++inside);
      await new Promise((r) => setTimeout(r, 5));
      inside--;
      return readdir(o);
    };
    wsPut(w, 'x.txt', 'x');
    await Promise.all([syncWork(w, 'c1'), syncWork(w, 'c1', { prefer: 'b' }), syncWork(w, 'c1')]);
    fs.readdir = readdir;
    expect(most).toBe(1);
    expect(fs.get(W + 'x.txt')).toBe('x');
  });

  it('a conflict reaches the ask_model jobs that changed the file (decision 182)', async () => {
    const { startJob, noteOverwrites, jobStatusText, _clearJobs } = await import('../../src/modeljobs.js');
    _clearJobs();
    const j = startJob({ conv: 'c1', task: 'append job-edit' });
    j.changes.set('harness_test/r3_conflict.txt', 'changed');
    noteOverwrites('c1', [{ path: 'harness_test/r3_conflict.txt', lost: 'a', kept: 'harness_test/r3_conflict.conflict-other.txt' }]);
    const t = jobStatusText(j);
    expect(t).toMatch(/changed – CONFLICT/);
    expect(t).toMatch(/⚠ conflicts – .*r3_conflict\.txt; the other version is kept as harness_test\/r3_conflict\.conflict-other\.txt/);
  });
});

describe('a copy keeps the time the file was written', () => {
  it('the shell side is given the app copy\'s mtime (decision 182)', async () => {
    const touched = [];
    globalThis.__ocmMode = { chmod: async () => ({}), touch: async (o) => touched.push(o) };
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'r3_py.txt', 'py', { mtime: 1763251957000 });
    await syncWork(w, 'c1', { prefer: 'a' });
    expect(touched).toContainEqual({ path: expect.stringMatching(/c1\/r3_py\.txt$/), mtime: 1763251957000 });
    delete globalThis.__ocmMode;
  });
});
