import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { runScript, scriptDocument, SCRIPT_BLOCKED, frameChannel } from '../../src/runscript.js';
import { isWriteCall, planAnswer, runProposePlan, changeList, agentsInstructions, APPROVE, REJECT } from '../../src/planmode.js';
import { lineDiff, collapseDiff } from '../../src/diff.js';

/** Runs the sandbox page's script in a Node VM: the same code the iframe runs, with the same hello → MessagePort
 *  handshake as the app (frameChannel), so everything after the hello goes through the port. */
function vmRunner(doc, onMessage, token) {
  const js = /<script>([\s\S]*)<\/script>/.exec(doc)[1];
  const inFrame = [];
  const atHost = [];
  const on = (list) => (_t, f) => _t === 'message' && list.push(f);
  const off = (list) => (_t, f) => list.includes(f) && list.splice(list.indexOf(f), 1);
  const contentWindow = { postMessage: (m, _o, ports) => setTimeout(() => inFrame.slice().forEach((f) => f({ data: m, source: parent, ports: ports || [] })), 0) };
  const parent = { postMessage: (m) => setTimeout(() => atHost.slice().forEach((f) => f({ data: m, source: contentWindow })), 0) };
  const win = { addEventListener: on(atHost), removeEventListener: off(atHost) };
  const ch = frameChannel({ contentWindow }, { tag: '__script', token, onMessage, onLeft: () => onMessage({ __script: token, type: 'left' }), win });
  const sandbox = { parent, setTimeout, addEventListener: on(inFrame), removeEventListener: off(inFrame), Proxy, Promise, JSON, String, Map, Object };
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox);
  return { post: ch.post, stop: ch.close };
}

describe('run_script', () => {
  it('loops over tool calls and returns only what it prints', async () => {
    const seen = [];
    const callTool = async (c) => {
      seen.push(c.name);
      const a = JSON.parse(c.arguments);
      if (c.name === 'glob_files') return { ok: true, result: 'a.js\nb.js\nc.js' };
      return { ok: true, result: `${a.path}: 2 TODOs\n\n[surface=workspace ok=1 bytes=9 ms=1 proof=x]` };
    };
    const code = `const files = (await tools.glob_files({ pattern: '*.js' })).result.split('\\n');
let n = 0;
for (const f of files) { const r = await tools.read_file({ path: f }); n += Number(r.result.match(/(\\d+) TODO/)[1]); }
print('files', files.length);
return { todos: n };`;
    const r = await runScript({ code }, { callTool, runner: vmRunner });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['glob_files', 'read_file', 'read_file', 'read_file']);
    expect(r.result).toMatch(/^files 3\n\{\n "todos": 6\n\}/);
    expect(r.result).toMatch(/\[4 tool calls: glob_files, read_file×3\]/);
  });
  it('glob_files gives the script its files as a list: the notes after the listing are not taken for files', async () => {
    const seen = [];
    const callTool = async (c) => {
      seen.push(c.name);
      if (c.name === 'glob_files') return { ok: true, result: 'a.py\t9 bytes\nb.py\t4 bytes\n(3 files in .out/, node_modules, .git, dist… not searched)', paths: ['a.py', 'b.py'] };
      return { ok: true, result: 'x' };
    };
    const code = `for (const p of (await tools.glob_files({ pattern: '*.py' })).paths) await tools.read_file({ path: p });`;
    const r = await runScript({ code }, { callTool, runner: vmRunner });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['glob_files', 'read_file', 'read_file']);
  });
  it('the card lists each call the script made, what it was about and whether it worked; independent calls run together', async () => {
    let running = 0;
    let most = 0;
    const callTool = async (c) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      const a = JSON.parse(c.arguments);
      return a.path === 'missing.txt' ? { ok: false, result: 'Error: not found' } : { ok: true, result: 'x' };
    };
    const code = `const r = await Promise.all(['a.txt', 'b.txt', 'missing.txt'].map((path) => tools.read_file({ path })));
await tools.shell({ command: 'ls -la /workspace' });
print(r.filter((x) => x.ok).length, 'read');`;
    const r = await runScript({ code }, { callTool, runner: vmRunner });
    expect(r.result).toMatch(/^2 read/);
    expect(most).toBe(3); // the three reads were in flight at once
    expect(r.display.calls).toBe(4);
    expect(r.display.steps).toEqual([
      { name: 'read_file', label: 'a.txt', status: 'done' },
      { name: 'read_file', label: 'b.txt', status: 'done' },
      { name: 'read_file', label: 'missing.txt', status: 'error' },
      { name: 'shell', label: 'ls -la /workspace', status: 'done' },
    ]);
    expect(r.display.more).toBe(0);
  });
  it('refuses tools that must not run from a script, and reports errors', async () => {
    const r = await runScript({ code: "const a = await tools.ask_user({ question: 'x' }); print(a.ok, a.result); throw new Error('boom')" }, { callTool: async () => ({ ok: true, result: '' }), runner: vmRunner });
    expect(SCRIPT_BLOCKED.has('ask_user')).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/false ask_user cannot be called from a script/);
    expect(r.result).toMatch(/\[error\] Error: boom/);
  });
  it('stops a script that runs too long', async () => {
    const r = await runScript({ code: 'await new Promise(() => {})', timeout_s: 1 }, { callTool: async () => ({}), runner: vmRunner });
    expect(r.result).toMatch(/longer than 1s/);
  });
  it('the sandbox page allows only its own inline script', () => {
    const d = scriptDocument('t', 'print("</script><b>")');
    expect(d).toMatch(/default-src 'none'; script-src 'unsafe-inline'/);
    expect(d.match(/<\/script>/g)).toHaveLength(1); // a </script> inside the code cannot end the script early
  });
});

describe('plan mode', () => {
  it('knows which calls change things', () => {
    expect(isWriteCall('read_file', {})).toBe(false);
    expect(isWriteCall('edit_file', {})).toBe(true);
    expect(isWriteCall('delegate', { tools: 'read' })).toBe(false);
    expect(isWriteCall('delegate', { tools: 'full' })).toBe(true);
    expect(isWriteCall('mcp_x_do', {})).toBe(true);
  });
  it('approve, reject or revise from the answer', () => {
    expect(planAnswer(APPROVE, {}).plan.status).toBe('approved');
    expect(planAnswer('ok', {}).plan.status).toBe('approved');
    expect(planAnswer(REJECT, {}).plan.status).toBe('rejected');
    const r = planAnswer('use sqlite instead of json', {});
    expect(r.plan).toMatchObject({ status: 'revise', feedback: 'use sqlite instead of json' });
    expect(r.result).toMatch(/call propose_plan again/);
  });
  it('propose_plan asks through the question sheet and records the answer', async () => {
    let plan = null;
    let asked = null;
    const ctx = { ask: async (q, opts) => ((asked = { q, opts }), APPROVE), planMode: { set: (p) => (plan = p) } };
    const r = await runProposePlan({ title: 'Add login', steps: ['write login.html', 'test it'] }, ctx);
    expect(asked.q).toMatch(/📋 Add login\n\n1\. write login\.html\n2\. test it/);
    expect(asked.opts).toEqual([APPROVE, REJECT]);
    expect(plan.status).toBe('approved');
    expect(r.result).toMatch(/approved/);
  });
  it('write tools are refused through runTool until the plan is approved', async () => {
    const { runTool } = await import('../../src/tools.js');
    let approved = false;
    const w = { id: 'pm', files: {} };
    const ctx = { workspace: w, settings: {}, planMode: { blocking: () => !approved } };
    const r = await runTool({ name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'x' }) }, ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/plan mode is on/);
    expect(w.files['a.txt']).toBeUndefined();
    expect((await runTool({ name: 'glob_files', arguments: '{"pattern":"*"}' }, ctx)).ok).toBe(true);
    approved = true;
    expect((await runTool({ name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'x' }) }, ctx)).ok).toBe(true);
  });
});

describe('changes card and AGENTS.md', () => {
  const f = (s) => ({ data: new TextEncoder().encode(s) });
  it('lists what a turn changed with line counts, leaving out spilled output', () => {
    const before = f('a\nb\nc');
    const files = { 'x.py': f('a\nB\nc\nd'), 'new.md': f('hi'), '.out/shell-1.txt': f('log') };
    const list = changeList(
      [
        { path: 'x.py', kind: 'changed', before },
        { path: 'new.md', kind: 'created', before: null },
        { path: '.out/shell-1.txt', kind: 'created', before: null },
        { path: 'gone.txt', kind: 'deleted', before: f('bye') },
      ],
      files,
      (a, b) => collapseDiff(lineDiff(a, b), 2),
    );
    expect(list.map((x) => [x.path, x.kind, x.added, x.removed])).toEqual([
      ['x.py', 'changed', 2, 1],
      ['new.md', 'created', 1, 0],
      ['gone.txt', 'deleted', 0, 1],
    ]);
    expect(list[0].diff.map((o) => o.t + o.s)).toEqual([' a', '-b', '+B', ' c', '+d']);
  });
  it('reads the project instructions from the workspace', () => {
    expect(agentsInstructions({ 'AGENTS.md': f('Use pytest. Never touch prod.') })).toMatch(/## Project instructions \(AGENTS\.md in the workspace\)[\s\S]*Use pytest/);
    expect(agentsInstructions({ 'CLAUDE.md': f('x') })).toMatch(/CLAUDE\.md/);
    expect(agentsInstructions({})).toBe('');
  });
});
