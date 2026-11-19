// ask_model jobs (decision 179).
import { describe, it, expect, beforeEach } from 'vitest';
import { KEEP, _clearJobs, beginStep, cancelJob, failJob, finishJob, getJob, jobListText, jobStatusText, jobsOf, loadJobs, markRead, mentions, noteActivity, noteFileChanges, noteOverwrites, noteQueue, saveJobs, snapshotFiles, startJob } from '../../src/modeljobs.js';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

describe('ask_model jobs', () => {
  beforeEach(() => _clearJobs());
  it('a job: activity, its tail and touched files, then its answer – also after the caller gave up', () => {
    const j = startJob({ conv: 'c1', model: 'DeepSeek V4.1 Flash', task: 'add a brush size slider to painter_gen.js', tools: 'full', background: true });
    expect(j.id).toMatch(/^job_[a-z0-9]{6}$/);
    noteActivity(j, 'read_file painter_gen.js');
    noteActivity(j, 'edit_file painter_gen.js');
    noteActivity(j, 'x'.repeat(400), { kind: 'text' });
    noteActivity(j, 'run_python node --check');
    const running = jobStatusText(j);
    expect(running).toMatch(/: running – DeepSeek V4\.1 Flash, tools full, background/);
    expect(running).toMatch(/last activity \d+ s ago: run_python node --check/);
    expect(running).toMatch(/about 100 tokens written so far/);
    expect(running).toMatch(/recent steps:\n {2}\d+ s ago {2}read_file painter_gen\.js/);
    finishJob(j, 'Added the slider.\n\n[model: deepseek]');
    const done = jobStatusText(getJob(j.id));
    expect(done).toMatch(/: done/);
    expect(done).toMatch(/Its answer:\nAdded the slider\./);
  });
  it('cancel stops the helper (its signal) and says so; a finished job cannot be cancelled', () => {
    const j = startJob({ conv: 'c1', task: 't' });
    expect(cancelJob(j)).toBe(true);
    expect(j.signal.aborted).toBe(true);
    expect(j.state).toBe('cancelled');
    expect(cancelJob(j)).toBe(false);
    const k = startJob({ conv: 'c1', task: 'u' });
    failJob(k, new Error('HTTP 502'));
    expect(jobStatusText(k)).toMatch(/It failed: HTTP 502/);
  });
  it('lists a chat’s jobs newest first, and forgets the oldest finished ones past the limit', () => {
    const a = startJob({ conv: 'c1', task: 'first' });
    finishJob(a, 'ok');
    startJob({ conv: 'c2', task: 'other chat' });
    const b = startJob({ conv: 'c1', task: 'second' });
    expect(jobsOf('c1').map((j) => j.id)).toEqual([b.id, a.id]);
    expect(jobListText(jobsOf('c1'))).toMatch(new RegExp(`^${b.id} +running`));
    expect(jobListText([])).toMatch(/No ask_model jobs/);
    for (let i = 0; i < KEEP + 5; i++) finishJob(startJob({ conv: 'c3', task: 'n' + i }), 'x');
    expect(getJob(a.id)).toBeNull(); // the oldest finished went
    expect(getJob(b.id)).not.toBeNull(); // a running one stays
  });
  it('every step is compared: files written by Python or the shell count, created / changed / deleted (decision 181)', () => {
    const j = startJob({ conv: 'c1', task: 'code' });
    const old = Date.now() - 600000;
    const files = { 'a.txt': { data: new Uint8Array(3), mtime: old }, 'gone.txt': { data: new Uint8Array(1), mtime: old } };
    const before = snapshotFiles(files);
    files['a.txt'] = { data: new Uint8Array(9), mtime: Date.now() }; // run_python rewrote it
    files['mid_1.txt'] = { data: new Uint8Array(2), mtime: Date.now() }; // the shell made it
    delete files['gone.txt']; // and removed this one
    const changed = noteFileChanges(j, before, snapshotFiles(files));
    expect(changed).toEqual([{ path: 'a.txt', kind: 'changed' }, { path: 'mid_1.txt', kind: 'created' }, { path: 'gone.txt', kind: 'deleted' }]);
    expect(jobStatusText(j)).toMatch(/files \(every step, also Python and the shell\): created mid_1\.txt; changed a\.txt; deleted gone\.txt/);
  });
  it('two jobs changing the same file while both run: a conflict, in the status (decision 181)', () => {
    const a = startJob({ conv: 'c1', task: 'A' });
    const b = startJob({ conv: 'c1', task: 'B' });
    const f0 = { 'x.js': { data: new Uint8Array(1), mtime: 1 } };
    noteFileChanges(a, snapshotFiles(f0), snapshotFiles({ 'x.js': { data: new Uint8Array(2), mtime: 2 } }));
    noteFileChanges(b, snapshotFiles({ 'x.js': { data: new Uint8Array(2), mtime: 2 } }), snapshotFiles({ 'x.js': { data: new Uint8Array(3), mtime: 3 } }));
    expect(b.conflicts).toEqual([{ path: 'x.js', by: `job ${a.id}` }]);
    expect(jobStatusText(b)).toMatch(new RegExp(`⚠ conflicts – changed by this job and by job ${a.id} \\(x\\.js\\)`));
  });
  it('two jobs running at once, each writing its own file in the shell: each lists only its own, and neither warns (round 11)', () => {
    const a = startJob({ conv: 'c1', task: 'collide' });
    const b = startJob({ conv: 'c1', task: 'setsid' });
    const endA = beginStep(a, 'shell', JSON.stringify({ command: "for i in $(seq 1 20); do printf 'HELPER %s' $i > collide.txt; sleep 0.5; done; cat collide.txt" }));
    const endB = beginStep(b, 'shell', JSON.stringify({ command: "setsid sh -c 'for i in $(seq 1 30); do echo $i >> s_setsid.txt; sleep 1; done' & sleep 60", timeout_s: 10 }));
    const both = { 'collide.txt': { data: new Uint8Array(9), mtime: 5 }, 's_setsid.txt': { data: new Uint8Array(4), mtime: 6 } };
    // A's step ends first: the sync after it brings in both files
    expect(noteFileChanges(a, snapshotFiles({}), snapshotFiles(both))).toEqual([{ path: 'collide.txt', kind: 'created' }]);
    endA();
    // then B's: it saw both appear too
    const later = { ...both, 's_setsid.txt': { data: new Uint8Array(8), mtime: 7 } };
    expect(noteFileChanges(b, snapshotFiles({}), snapshotFiles(later))).toEqual([{ path: 's_setsid.txt', kind: 'created' }]);
    endB();
    expect([...a.changes.keys()]).toEqual(['collide.txt']);
    expect([...b.changes.keys()]).toEqual(['s_setsid.txt']);
    expect(a.conflicts).toEqual([]);
    expect(b.conflicts).toEqual([]);
    expect(jobStatusText(b)).not.toMatch(/conflicts/);
  });
  it('two jobs whose steps both name the same file: still a conflict between them', () => {
    const a = startJob({ conv: 'c1', task: 'A' });
    const b = startJob({ conv: 'c1', task: 'B' });
    const endA = beginStep(a, 'shell', '{"command":"echo A > shared.txt"}');
    const endB = beginStep(b, 'shell', '{"command":"echo B > shared.txt"}');
    noteFileChanges(a, snapshotFiles({}), snapshotFiles({ 'shared.txt': { data: new Uint8Array(2), mtime: 2 } }));
    endA();
    noteFileChanges(b, snapshotFiles({ 'shared.txt': { data: new Uint8Array(2), mtime: 2 } }), snapshotFiles({ 'shared.txt': { data: new Uint8Array(3), mtime: 3 } }));
    endB();
    expect(b.conflicts).toEqual([{ path: 'shared.txt', by: `job ${a.id}` }]);
  });
  it('a file name counts as named only as a whole word', () => {
    expect(mentions('echo 1 > a.txt', 'a.txt')).toBe(true);
    expect(mentions('echo 1 > data.txt', 'a.txt')).toBe(false);
    expect(mentions('cat out/a.txt.bak', 'a.txt')).toBe(false);
    expect(mentions('{"path":"out/report.md"}', 'out/report.md')).toBe(true);
    expect(mentions('cd out && cat report.md.', 'out/report.md')).toBe(true);
  });
  it("another job's file that landed during this step is that job's, not this one's (round 5)", () => {
    const py = startJob({ conv: 'c1', task: 'python' });
    const sh = startJob({ conv: 'c1', task: 'shell' });
    const stepAt = Date.now();
    const pyBefore = snapshotFiles({});
    // the shell job's step ends first: its file is brought in and counted as its own
    const shFile = { 'sh.txt': { data: new Uint8Array(8), mtime: 5 } };
    expect(noteFileChanges(sh, snapshotFiles({}), snapshotFiles(shFile))).toEqual([{ path: 'sh.txt', kind: 'created' }]);
    // then the Python step ends: it sees sh.txt as new too, but only py.txt is its own
    const now = { ...shFile, 'py.txt': { data: new Uint8Array(8), mtime: 6 } };
    expect(noteFileChanges(py, pyBefore, snapshotFiles(now), Date.now(), stepAt)).toEqual([{ path: 'py.txt', kind: 'created' }]);
    expect([...py.changes.keys()]).toEqual(['py.txt']);
    expect(py.conflicts).toEqual([]);
    // the Python job then really changing that file is its change (and a conflict with the shell job)
    const later = { ...now, 'sh.txt': { data: new Uint8Array(9), mtime: 7 } };
    expect(noteFileChanges(py, snapshotFiles(now), snapshotFiles(later), Date.now(), Date.now())).toEqual([{ path: 'sh.txt', kind: 'changed' }]);
    expect(py.conflicts).toEqual([{ path: 'sh.txt', by: `job ${sh.id}` }]);
  });
  it('jobs are kept across an app restart; one still running then is "interrupted"; a read answer is marked (decision 181)', async () => {
    const done = startJob({ conv: 'c1', task: 'finished one' });
    finishJob(done, 'the answer');
    markRead(done);
    const busy = startJob({ conv: 'c1', task: 'was running' });
    noteActivity(busy, 'shell node build.js');
    await new Promise((r) => setTimeout(r, 350)); // the save is a moment later
    _clearJobs(); // the app restarts
    loadJobs();
    expect(getJob(done.id)).toMatchObject({ state: 'done', result: 'the answer' });
    expect(getJob(done.id).readAt).toBeGreaterThan(0);
    expect(getJob(busy.id).state).toBe('interrupted');
    expect(jobStatusText(getJob(busy.id))).toMatch(/The app stopped while it ran/);
    expect(jobStatusText(getJob(busy.id))).toMatch(/shell node build\.js/);
  });
  it('a cancel during a step is "cancelling" until that step has ended, then "cancelled" (decision 183)', async () => {
    const j = startJob({ conv: 'c1', task: 'write partial, sleep 90 s, append finished', tools: 'full', background: true });
    const end = beginStep(j, 'run_python');
    const step = j.step;
    expect(cancelJob(j)).toBe(true);
    expect(j.signal.aborted).toBe(true); // the step is being killed
    expect(j.state).toBe('cancelling');
    expect(jobStatusText(j)).toMatch(/cancel pending: its run_python step is still running.*may still land.*"cancelled" once it has ended/);
    expect(jobListText(jobsOf('c1'))).toMatch(/cancelling/);
    failJob(j, new Error('Cancelled')); // the helper's loop gives up first: the job still waits for its step
    expect(j.state).toBe('cancelling');
    expect(cancelJob(j)).toBe(false);
    end([{ path: 'r4_cancel.txt', kind: 'created' }]);
    expect(j.state).toBe('cancelled');
    expect(jobStatusText(j)).toMatch(/run_python stopped by the cancel \(1 file change kept\)/);
    expect(await step.done).toEqual([{ path: 'r4_cancel.txt', kind: 'created' }]);
    expect(j.step).toBe(null);
    // between steps: cancelled at once
    const k = startJob({ conv: 'c1', task: 'list files' });
    expect(cancelJob(k)).toBe(true);
    expect(k.state).toBe('cancelled');
  });
  it('a job that was being cancelled when the app stopped is "interrupted" after a restart', () => {
    const j = startJob({ conv: 'c1', task: 't' });
    beginStep(j, 'shell');
    cancelJob(j);
    saveJobs({ now: true });
    _clearJobs();
    loadJobs();
    expect(getJob(j.id).state).toBe('interrupted');
  });
  it('a file both sides only appended to is merged, not a conflict', () => {
    const j = startJob({ conv: 'c1', task: 't' });
    noteFileChanges(j, snapshotFiles({}), snapshotFiles({ 'log.txt': { mtime: Date.now(), data: new Uint8Array(4) } }));
    noteOverwrites('c1', [{ path: 'log.txt', merged: true }]);
    expect(j.conflicts).toEqual([]);
    expect(jobStatusText(j)).toMatch(/changed \(merged\) log\.txt \(changed – merged: text was also added at its end elsewhere/);
  });
  it('a call waiting its turn is listed; a cancel drops it and says so (decision 189)', () => {
    const j = startJob({ conv: 'c1', task: 'two shells' });
    beginStep(j, 'shell');
    noteQueue(j, ["shell printf 'second\\n' > c_second.txt"]);
    expect(jobStatusText(j)).toMatch(/waiting its turn \(planned, not started\):\n  shell printf 'second\\n' > c_second\.txt/);
    cancelJob(j);
    expect(j.queue).toEqual([]);
    expect(jobStatusText(j)).toMatch(/not run – dropped by the cancel while waiting its turn \(it will not run later\):\n  shell printf/);
    expect(jobStatusText(j)).not.toMatch(/waiting its turn \(planned/);
  });
});
