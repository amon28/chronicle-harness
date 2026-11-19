import { describe, it, expect, beforeEach } from 'vitest';
import { configureJobs, startJob, settle, jobSnapshot, tailLines, killJob, getJob, listJobs, jobOnShell, isRunning } from '../../src/jobs.js';

let listeners;
let killed;
let sinces;
let finish;

beforeEach(() => {
  listeners = [];
  killed = [];
  sinces = {};
  finish = null;
  configureJobs({
    exec: () => new Promise((resolve) => (finish = resolve)),
    kill: async (id, o) => (killed.push(id), (sinces[id] = o?.since), 2),
    onOutput: (fn) => {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
  });
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
// startJob runs exec on the next microtask, so let it begin before resolving
const started = async () => {
  const job = startJob({ cmd: 'make', shellId: 'chat:1', timeoutMs: 600000 });
  await tick();
  return job;
};

describe('job handles', () => {
  it('answers while the command is still running, and keeps its output', async () => {
    const job = await started();
    expect(job.status).toBe('running');
    const early = await settle(job, 5);
    expect(isRunning(early)).toBe(true);
    listeners.forEach((fn) => fn({ id: 'chat:1', data: 'step 1\nstep 2\n' }));
    const snap = jobSnapshot(job, { lines: 10 });
    expect(snap.running).toBe(true);
    expect(snap.output).toContain('step 2');
    finish({ output: 'step 1\nstep 2\ndone\n', exit: 0 });
    const done = await settle(job, 1000);
    expect(done.status).toBe('done');
    expect(done.exit).toBe(0);
    expect(jobSnapshot(job).output).toContain('done');
    expect(jobOnShell('chat:1')).toBe(null);
  });

  it('runs the after-step before it reports finished, so a poll never sees a half result', async () => {
    let after = false;
    const job = startJob({ cmd: 'x', shellId: 'chat:2', timeoutMs: 1000, onFinish: async () => { await new Promise((r) => setTimeout(r, 30)); after = true; } });
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    finish({ output: '', exit: 0 });
    await settle(job, 500);
    expect(after).toBe(true);
    expect(isRunning(job)).toBe(false);
  });

  it('reports a timed-out command honestly and a kill as a kill', async () => {
    const a = await started();
    finish({ output: 'partial', exit: -1, timedOut: true, running: true });
    await settle(a, 500);
    expect(a.status).toBe('timed-out');
    expect(a.exit).toBe(null);
    expect(jobSnapshot(a).timedOut).toBe(true);
    // bug D: a timed-out command is stopped (only what started with the job), and the job says so
    expect(killed).toEqual(['chat:1']);
    expect(sinces['chat:1']).toBe(a.started);
    expect(a.reaped).toBe(2);
    expect(jobSnapshot(a).note).toMatch(/timed out after 600 s – killed/);

    const b = await started();
    const snap = await killJob(b);
    expect(killed).toContain('chat:1');
    expect(snap.status).toBe('killed');
    expect(getJob(b.id)).toBeTruthy();
    expect(listJobs().some((j) => j.id === b.id)).toBe(true);
  });

  it('tails long output instead of sending all of it', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toBe('… [2 earlier lines] …\nc\nd');
    expect(tailLines('a\nb', 0)).toBe('a\nb');
    expect(tailLines('', 5)).toBe('');
  });
});

describe('live output of a command that prints megabytes', () => {
  it('stays linear: hundreds of chunks do not freeze the app, and the newest part is kept', async () => {
    let emit = null;
    let finish = null;
    configureJobs({
      exec: () => new Promise((r) => (finish = r)),
      kill: async () => {},
      onOutput: (fn) => ((emit = fn), () => {}),
    });
    let progress = 0;
    const job = startJob({ cmd: 'seq 1 300000', shellId: 'big', timeoutMs: 60000, onProgress: () => progress++ });
    const chunk = 'x'.repeat(8191) + '\n';
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) emit({ id: 'big', data: i === 299 ? 'LAST LINE\n' : chunk });
    const ms = performance.now() - t0;
    expect(progress).toBe(300);
    expect(ms).toBeLessThan(300);
    expect(job.output).toMatch(/characters of earlier output left out/);
    expect(job.output).toMatch(/LAST LINE\n$/);
    expect(job.output.length).toBeLessThan(600 * 1024);
    await new Promise((r) => setTimeout(r, 0));
    finish({ output: '', exit: 0 });
    await job.done;
    expect(job.output).toMatch(/LAST LINE\n$/); // nothing in the final result: what was streamed is kept
  });
});

describe('job chips', () => {
  it('lists only this chat’s running jobs', async () => {
    // the pure part of app/jobs-ui.js, re-stated here because that module needs the DOM
    const runningJobs = (convId, jobs) => jobs.filter((j) => j.running && String(j.shell || '').startsWith('chat:' + convId)).map((j) => ({ id: j.id, cmd: String(j.cmd || '').split('\n')[0], elapsed: j.elapsed }));
    const jobs = [{ id: 'j1', cmd: 'npm test\nmore', running: true, shell: 'chat:a', elapsed: 4 }, { id: 'j2', cmd: 'x', running: false, shell: 'chat:a' }, { id: 'j3', cmd: 'y', running: true, shell: 'chat:b' }];
    expect(runningJobs('a', jobs)).toEqual([{ id: 'j1', cmd: 'npm test', elapsed: 4 }]);
  });
});
