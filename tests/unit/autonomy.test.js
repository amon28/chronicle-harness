import { describe, it, expect } from 'vitest';
import { repeatGuard, runGoalTool, goalPrompt, goalNudge, runRalph, RALPH_DONE, firstRun, takeDue, runScheduleTool } from '../../src/autonomy.js';

describe('repeat guard', () => {
  it('stops the third identical call that keeps getting the same answer', () => {
    const g = repeatGuard();
    const a = JSON.stringify({ command: 'ls' });
    expect(g.check('shell', a)).toBe(null);
    g.record('shell', a, 'x [surface=linux-shell ok=1 ms=12]');
    expect(g.check('shell', a)).toBe(null);
    g.record('shell', a, 'x [surface=linux-shell ok=1 ms=40]'); // only the timing differs: the same answer
    expect(g.check('shell', '{ "command": "ls" }')).toMatch(/2 times.*same result/); // same arguments, other spacing
    expect(g.check('shell', JSON.stringify({ command: 'ls -la' }))).toBe(null);
  });
  it('lets a call repeat while its answer changes, up to a limit, and never blocks job polling', () => {
    const g = repeatGuard();
    // a result that keeps changing is progress (a test run in a fix loop, a page being scrolled): allowed up to 40 times
    for (let i = 0; i < 40; i++) {
      expect(g.check('read_file', '{"path":"log"}')).toBe(null);
      g.record('read_file', '{"path":"log"}', 'line ' + i);
    }
    expect(g.check('read_file', '{"path":"log"}')).toMatch(/40 times/);
    for (let i = 0; i < 8; i++) g.record('shell_job', '{"action":"wait"}', 'running');
    expect(g.check('shell_job', '{"action":"wait"}')).toBe(null);
  });
});

describe('goal', () => {
  const holder = () => {
    let g = null;
    return { goal: { get: () => g, set: (x) => (g = x) }, now: () => g };
  };
  it('set → nudge text → done needs evidence', () => {
    const h = holder();
    runGoalTool({ action: 'set', text: 'All tests pass' }, h);
    expect(h.now()).toMatchObject({ status: 'active', text: 'All tests pass' });
    expect(goalPrompt(h.now())).toMatch(/## Goal \(open\)\nAll tests pass/);
    expect(goalNudge(h.now(), 1)).toMatch(/Goal check 1\/3/);
    expect(() => runGoalTool({ action: 'done' }, h)).toThrow(/evidence/);
    runGoalTool({ action: 'done', summary: 'ran pytest: 12 passed' }, h);
    expect(h.now().status).toBe('done');
    expect(goalPrompt(h.now())).toBe('');
    expect(goalPrompt(null)).toMatch(/goal with action set/);
  });
});

describe('Ralph loop', () => {
  it('runs fresh helpers until the progress file says done', async () => {
    const w = { files: {} };
    const enc = (s) => ({ data: new TextEncoder().encode(s) });
    const prompts = [];
    const ctx = {
      workspace: w,
      delegate: async (prompt, _s, o) => {
        prompts.push({ prompt, mode: o.mode });
        const round = prompts.length;
        w.files['PROGRESS.md'] = enc(round < 3 ? `- [x] piece ${round}` : `${RALPH_DONE}\n- [x] all`);
        return { text: `did piece ${round}`, steps: [{ name: 'shell' }] };
      },
    };
    const r = await runRalph({ task: 'convert all files', max_rounds: 10 }, ctx);
    expect(prompts.length).toBe(3);
    expect(prompts.every((p) => p.mode === 'full')).toBe(true);
    expect(prompts[0].prompt).toMatch(/helper 1 of at most 10[\s\S]*convert all files[\s\S]*Read PROGRESS\.md first/);
    expect(r.result).toMatch(/^Done/);
    expect(r.result).toMatch(/Helper 3 \(1 steps\): did piece 3/);
  });
  it('reports an unfinished job honestly', async () => {
    const w = { files: {} };
    const r = await runRalph({ task: 'x', max_rounds: 2 }, { workspace: w, delegate: async () => ({ text: 'tried', steps: [] }) });
    expect(r.result).toMatch(/^Not finished after 2 helpers/);
  });
});

describe('scheduled tasks', () => {
  const now = new Date('2026-11-11T10:00:00').getTime();
  it('reads when to run', () => {
    expect(firstRun({ in_minutes: 30 }, now)).toBe(now + 30 * 60000);
    expect(new Date(firstRun({ at: '09:30' }, now)).getDate()).toBe(12); // already past today: tomorrow
    expect(new Date(firstRun({ at: '2026-11-11 18:15' }, now)).getHours()).toBe(18);
    expect(() => firstRun({ at: '2026-11-10 08:00' }, now)).toThrow(/past/);
    expect(() => firstRun({}, now)).toThrow(/in_minutes/);
  });
  it('a repeating task moves on, a one-off goes, a limited one counts down', () => {
    const tasks = [
      { id: 'a', next: now - 1000, prompt: 'once' },
      { id: 'b', next: now - 1000, every: 60, prompt: 'hourly' },
      { id: 'c', next: now + 5000, prompt: 'later' },
      { id: 'd', next: now - 10 * 3600000, every: 60, left: 2, prompt: 'twice' },
    ];
    const { due, keep } = takeDue(tasks, now);
    expect(due.map((t) => t.id)).toEqual(['a', 'b', 'd']);
    expect(keep.find((t) => t.id === 'b').next).toBe(now - 1000 + 3600000);
    expect(keep.find((t) => t.id === 'd')).toMatchObject({ left: 1, next: now + 3600000 }); // missed while closed: once, then from now
    expect(keep.some((t) => t.id === 'a')).toBe(false);
    expect(takeDue([{ id: 'e', next: now - 1, every: 60, left: 1 }], now).keep).toEqual([]);
  });
  it('the tool adds, lists and cancels', () => {
    let list = [];
    const ctx = { schedules: { list: () => list, add: (t) => list.push(t), remove: (id) => list.length !== (list = list.filter((t) => t.id !== id)).length } };
    const r = runScheduleTool({ prompt: 'check the build', in_minutes: 60, every_minutes: 2 }, ctx);
    expect(r.result).toMatch(/every 5 min/); // at least 5
    expect(runScheduleTool({ action: 'list' }, ctx).result).toMatch(/check the build/);
    expect(runScheduleTool({ action: 'cancel', id: list[0].id }, ctx).ok).toBe(true);
    expect(list).toEqual([]);
  });
});
