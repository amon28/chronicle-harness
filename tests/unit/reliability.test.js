import { describe, it, expect } from 'vitest';
import { workTracker, changedPaths, isCheckCall, checkRan, evidenceOf, doneCheckNote } from '../../src/donecheck.js';
import { runAdvisorTool, advisorDefs, advisorMessages, ADVISOR_CAP } from '../../src/advisor.js';
import { btwMessages, BTW_NOTE } from '../../src/sidequestion.js';
import { toolDefs, toolsSystemPrompt } from '../../src/tools.js';
import { isWriteCall, asksFirst } from '../../src/planmode.js';
import { helperMayUse } from '../../src/subagent.js';
import { shellDefs } from '../../src/shell.js';

const ev = (extra = '') => `\n\n[surface=linux-shell ok=1 bytes=3 ms=5${extra}]`;
let n = 0;
const f = () => ({ data: new Uint8Array([++n % 251, (n >> 8) % 251, 9]) });

describe('done check: workTracker', () => {
  it('a write with nothing after it is pending; a check after it clears it', () => {
    const w = workTracker();
    w.record('write_file', '{"path":"app.js"}', { paths: ['app.js'] });
    expect(w.pending()).toEqual(['app.js']);
    w.record('shell', { command: 'node app.js' }, { ran: true });
    expect(w.pending()).toEqual([]);
  });
  it('a check before the change does not count', () => {
    const w = workTracker();
    w.record('run_python', '{}', {});
    w.record('edit_file', '{"path":"a.py"}', { paths: ['a.py'] });
    expect(w.pending()).toEqual(['a.py']);
  });
  it('a shell command that only writes files is a change, not a check', () => {
    const w = workTracker();
    w.record('shell', { command: "cat > a.py <<'EOF'\nprint(1)\nEOF" }, { paths: ['a.py'], ran: true });
    expect(w.pending()).toEqual(['a.py']);
    w.record('shell', { command: 'python3 a.py' }, { ran: true });
    expect(w.pending()).toEqual([]);
  });
  it('a check that never ran (blocked, no Linux) does not count', () => {
    const w = workTracker();
    w.record('apply_patch', '{}', { paths: ['x.js', 'y.js'] });
    w.record('shell', { command: 'npm test' }, { ran: false });
    expect(w.pending()).toEqual(['x.js', 'y.js']);
  });
  it('preview_page, shell_job and the browser on a served page are checks; on a web site it is not', () => {
    for (const [name, args] of [
      ['preview_page', { path: 'index.html' }],
      ['shell_job', { action: 'wait', job_id: 'job_1' }],
      ['browser', { action: 'open', url: 'http://127.0.0.1:8000/' }],
      ['browser', { action: 'open', url: 'https://abc.workspace.localhost/index.html' }],
      ['browser', { action: 'open', url: '/workspace/index.html' }],
    ]) {
      const w = workTracker();
      w.record('write_file', '{}', { paths: ['index.html'] });
      w.record(name, args, {});
      expect(w.pending(), name + JSON.stringify(args)).toEqual([]);
    }
    const w = workTracker();
    w.record('write_file', '{}', { paths: ['index.html'] });
    w.record('browser', { action: 'open', url: 'https://example.com/' }, {});
    w.record('browser', { action: 'screenshot' }, {});
    expect(w.pending()).toEqual(['index.html']);
    // once the browser is on a served page, its later actions look at the work
    const w2 = workTracker();
    w2.record('browser', { action: 'open', url: 'http://localhost:3000/' }, {});
    w2.record('edit_file', '{}', { paths: ['app.css'] });
    w2.record('browser', { action: 'screenshot' }, {});
    expect(w2.pending()).toEqual([]);
  });
  it("the user's post-tool hook, a stop hook, or a check inside a script count", () => {
    const a = workTracker();
    a.record('write_file', '{}', { paths: ['a.js'], hookRan: true });
    expect(a.pending()).toEqual([]);
    const b = workTracker();
    b.record('write_file', '{}', { paths: ['a.js'] });
    b.checked();
    expect(b.pending()).toEqual([]);
    const c = workTracker();
    c.record('run_script', '{}', { paths: ['a.js', 'b.js'], innerCheck: true });
    expect(c.pending()).toEqual([]);
    const d = workTracker();
    d.record('run_script', '{}', { paths: ['a.js'] });
    expect(d.pending()).toEqual(['a.js']);
  });
  it('phone writes count by their path; a failed one does not', () => {
    const w = workTracker();
    w.record('phone_write', '{"path":"site/index.html"}', { ok: true });
    w.record('phone_write', '{"path":"x.js"}', { ok: false });
    expect(w.pending()).toEqual(['/phone/site/index.html']);
  });
  it('a failed write that changed nothing is not pending', () => {
    const w = workTracker();
    w.record('edit_file', '{"path":"a.js"}', { ok: false, paths: [] });
    expect(w.pending()).toEqual([]);
  });
});

describe('done check: helpers', () => {
  it('changedPaths: added and replaced files, without deletions, notes, captures and spilled output', () => {
    const a = f();
    const b = f();
    const before = { 'a.js': a, 'b.js': b, 'gone.py': f(), 'README.md': f() };
    const after = { 'a.js': a, 'b.js': f(), 'new.css': f(), '.out/shell-1.txt': f(), 'output/screenshots/p.jpg': f(), 'notes.txt': f(), 'README.md': f() };
    expect(changedPaths(before, after).sort()).toEqual(['b.js', 'new.css']);
    expect(changedPaths(null, after)).toEqual([]);
    // a turn that only deleted or moved files wrote nothing to check
    const x = f();
    expect(changedPaths({ 'a.js': x, 'b.py': f() }, {})).toEqual([]);
    expect(changedPaths({ 'a.js': x }, { 'src/a.js': x })).toEqual([]);
    expect(changedPaths({ 'a.js': x }, { 'src/a.js': { data: x.data } })).toEqual([]); // move_file: a new object, the same bytes
    expect(changedPaths({ 'a.js': { data: new Uint8Array([1, 2]) } }, { 'b.js': { data: new Uint8Array([1, 2]) } })).toEqual([]); // shell mv
    expect(changedPaths({ 'a.js': { data: new Uint8Array([1, 2]) } }, { 'a.js': { data: new Uint8Array([1, 3]) } })).toEqual(['a.js']); // an edit
    expect(changedPaths({ 'a.js': x }, { 'src/a.js': x, 'c.js': { data: new Uint8Array([7, 7]) } })).toEqual(['c.js']);
  });
  it('evidenceOf reads the evidence line; checkRan follows it', () => {
    expect(evidenceOf('out' + ev(' exit=1'))).toMatchObject({ surface: 'linux-shell', ok: '1', exit: '1' });
    expect(evidenceOf('no line')).toBeNull();
    expect(checkRan('shell', 'exit code 1\nFAIL' + ev(' exit=1'))).toBe(true); // a failing test is still a check
    expect(checkRan('shell', 'still running' + ev(' job=job_1'))).toBe(true);
    expect(checkRan('shell', 'Linux is not installed yet.\n\n[surface=linux-shell ok=0 bytes=3 ms=1]')).toBe(false);
    expect(checkRan('shell', 'x' + ev(' exit=0'), { blocked: true })).toBe(false);
    expect(checkRan('preview_page', 'shot\n\n[surface=android-webview ok=1 bytes=1 ms=1]')).toBe(true);
    expect(checkRan('preview_page', 'The preview needs the Android app.\n\n[surface=android-webview ok=0 bytes=1 ms=1]')).toBe(false);
  });
  it('isCheckCall', () => {
    expect(isCheckCall('shell', '{"command":"pytest -q"}')).toBe(true);
    expect(isCheckCall('shell', '{"command":"mkdir -p a && touch a/b"}')).toBe(false);
    expect(isCheckCall('read_file', '{}')).toBe(false);
    expect(isCheckCall('run_python', 'not json')).toBe(true);
  });
  it('the note names the files and both ways out', () => {
    const n = doneCheckNote(['a.js']);
    expect(n).toContain('a.js');
    expect(n).toContain('exactly these files: a.js');
    expect(n).toContain('do not look for other changes');
    expect(n).toContain('Check it now (run, test, preview)');
    expect(n).toContain('unchecked');
    expect(doneCheckNote(Array.from({ length: 12 }, (_, i) => `f${i}.js`))).toContain('and 4 more');
  });
});

describe('advisor', () => {
  it('is offered only when switched on, is read-only for plan mode and never given to helpers', () => {
    const base = { files: true };
    expect(toolDefs(base).some((d) => d.function.name === 'advisor')).toBe(false);
    const on = toolDefs({ ...base, advisor: true, advisorName: 'Big Model' }).find((d) => d.function.name === 'advisor');
    expect(on.function.description).toContain('Big Model');
    expect(toolsSystemPrompt({ ...base, advisor: true }, 0)).toContain('advisor tool');
    expect(toolsSystemPrompt(base, 0)).not.toContain('advisor tool');
    expect(isWriteCall('advisor', { question: 'x' })).toBe(false);
    expect(asksFirst('advisor', '{}')).toBe(false);
    expect(helperMayUse('advisor', 'full')).toBe(false);
    expect(advisorDefs()[0].function.description).toContain(`At most ${ADVISOR_CAP} times`);
  });
  it('asks with the conversation and the question, and says where the advice came from', async () => {
    const asked = [];
    const r = await runAdvisorTool({ question: 'Why does npm test fail?' }, { advise: async (q) => (asked.push(q), { text: 'Check the import path.', model: 'Big' }), advisorLeft: () => 2 });
    expect(asked).toEqual(['Why does npm test fail?']);
    expect(r.ok).toBe(true);
    expect(r.result).toContain('Advice from Big');
    expect(r.result).toContain('Check the import path.');
    const msgs = advisorMessages('User: hi', 'q?');
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('User: hi');
    expect(msgs[1].content).toContain('q?');
  });
  it('stops at the cap, refuses without an advisor, needs a question', async () => {
    let called = 0;
    const r = await runAdvisorTool({ question: 'x' }, { advise: async () => (called++, { text: 'y' }), advisorLeft: () => 0 });
    expect(r.ok).toBe(false);
    expect(r.result).toContain(`${ADVISOR_CAP} times`);
    expect(called).toBe(0);
    expect((await runAdvisorTool({ question: 'x' }, {})).result).toContain('not available');
    await expect(runAdvisorTool({}, { advise: async () => ({}) })).rejects.toThrow(/question/);
    expect((await runAdvisorTool({ question: 'x' }, { advise: async () => ({ text: ' ' }) })).ok).toBe(false);
  });
});

describe('/btw request', () => {
  it('keeps the chat, writes tool calls out as text, and ends with the question', () => {
    const hist = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"command":"npm test"}' } }], reasoning_content: 'hmm' },
      { role: 'tool', tool_call_id: 'c1', content: '1 failed' },
    ];
    const out = btwMessages(hist, 'what failed?');
    expect(out.some((m) => m.role === 'tool' || m.tool_calls)).toBe(false);
    expect(out[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(out[2].content).toContain('[called shell {"command":"npm test"}]');
    expect(out[3]).toEqual({ role: 'user', content: '[result of shell]\n1 failed' });
    expect(out.some((m) => 'reasoning_content' in m)).toBe(false);
    expect(out.at(-1).content).toBe(`${BTW_NOTE}\n\nwhat failed?`);
    expect(hist).toHaveLength(4); // the chat's own list is not changed
  });
});

describe('shell guard in the tool description', () => {
  it('tells the model in one sentence', () => {
    expect(shellDefs()[0].function.description).toMatch(/waits for the user to allow it, even in Auto/);
  });
});
