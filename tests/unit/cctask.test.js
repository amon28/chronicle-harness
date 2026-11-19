// Claude Code and Chronicle's models calling each other (decision 167): when claude_code is offered, ask_model /
// list_models for Claude Code, the no-loop rules, and the hidden-session runner over a fake ACP client.
import { describe, it, expect } from 'vitest';
import { toolDefs, toolsSystemPrompt } from '../../src/tools.js';
import { applyToolset, TOOL_GROUPS } from '../../src/toolset.js';
import { ccEnabled, crossTools, listModelsText, mcpToolList } from '../../src/cctools.js';
import { ccTaskInfo, claudeCodeDefs, ORIGIN_MODEL, progressLine, runClaudeCodeTask, runClaudeCodeTool, taskSystemPrompt } from '../../src/cctask.js';
import { helperMayUse, helperToolDefs } from '../../src/subagent.js';
import { SCRIPT_BLOCKED } from '../../src/runscript.js';
import { isWriteCall, asksFirst } from '../../src/planmode.js';
import { PERMISSION_TOOLS } from '../../src/permissions.js';

const READY = { installed: true, auth: 'yes' };
const CACHE = { models: [{ value: 'default', name: 'Default (recommended)', description: 'Opus 4.8' }, { value: 'sonnet', name: 'Sonnet' }], effort: { default: ['low', 'high'], sonnet: ['low', 'medium'] } };
const ALL = { web: true, python: true, files: true, delegate: true, shell: true, autonomy: true, skills: [] };
const names = (defs) => defs.map((d) => d.function?.name || d.name);

describe('when claude_code is offered to a chat', () => {
  it('only with the switch on, Claude Code installed and signed in (cached), and not in roleplay or across', () => {
    expect(ccTaskInfo({ on: false, ready: READY, cache: CACHE })).toBeNull();
    expect(ccTaskInfo({ on: true, ready: null, cache: CACHE })).toBeNull(); // nothing cached: not offered (Linux is not asked)
    expect(ccTaskInfo({ on: true, ready: { installed: false, auth: 'yes' } })).toBeNull();
    expect(ccTaskInfo({ on: true, ready: { installed: true, auth: 'no' } })).toBeNull();
    expect(ccTaskInfo({ on: true, ready: { installed: true, auth: 'unknown' } })).toBeNull();
    expect(ccTaskInfo({ on: true, ready: READY, rp: true, cache: CACHE })).toBeNull();
    expect(ccTaskInfo({ on: true, ready: READY, origin: ORIGIN_MODEL, cache: CACHE })).toBeNull();
    const info = ccTaskInfo({ on: true, ready: READY, cache: CACHE });
    expect(info.models.map((m) => m.value)).toEqual(['default', 'sonnet']);
    expect(info.efforts.sort()).toEqual(['high', 'low', 'medium']);
    expect(ccTaskInfo({ on: true, ready: READY })).toEqual({ models: [], efforts: [] }); // before any model list: no model choice
  });
  it('is a tool with its model and effort choices, says it uses the Claude plan, and follows the toolset', () => {
    const info = ccTaskInfo({ on: true, ready: READY, cache: CACHE });
    const d = toolDefs({ ...ALL, claudecode: info }).find((x) => x.function.name === 'claude_code');
    expect(d.function.parameters.required).toEqual(['task']);
    expect(d.function.parameters.properties.model.enum).toEqual(['default', 'sonnet']);
    expect(d.function.parameters.properties.effort.enum).toContain('medium');
    expect(d.function.description).toMatch(/Claude subscription/);
    expect(d.function.description).toMatch(/substantial coding or agentic work/);
    expect(claudeCodeDefs({ models: [], efforts: [] })[0].function.parameters.properties.model).toBeUndefined();
    expect(names(toolDefs({ ...ALL, claudecode: false }))).not.toContain('claude_code');
    expect(toolsSystemPrompt({ ...ALL, claudecode: info }, 0)).toMatch(/claude_code hands the task/);
    // a persona toolset without the group, and the group in the editor's list
    expect(TOOL_GROUPS.some(([k]) => k === 'claudecode')).toBe(true);
    expect(names(toolDefs(applyToolset({ ...ALL, claudecode: info }, { claudecode: false })))).not.toContain('claude_code');
    // a permission of its own; it changes things: blocked in plan mode, asks in 🛡 Ask first; never in a script
    expect(PERMISSION_TOOLS.some(([k]) => k === 'claude_code')).toBe(true);
    expect(isWriteCall('claude_code', {})).toBe(true);
    expect(asksFirst('claude_code', '{}')).toBe(true);
    expect(SCRIPT_BLOCKED.has('claude_code')).toBe(true);
  });
  it('no loops: a helper never gets it, and Claude Code itself never sees it', () => {
    const info = ccTaskInfo({ on: true, ready: READY, cache: CACHE });
    expect(helperMayUse('claude_code', 'full')).toBe(false);
    expect(names(helperToolDefs(toolDefs({ ...ALL, claudecode: info }), 'full'))).not.toContain('claude_code');
    const e = ccEnabled({ ...ALL, claudecode: info }, true);
    expect(e.claudecode).toBe(false);
    expect(names(mcpToolList(toolDefs(e)))).not.toContain('claude_code');
  });
});

describe('ask_model and list_models for Claude Code', () => {
  it('offered with helper agents on, never in a session a model started', () => {
    expect(names(crossTools({ delegate: true }))).toEqual(['ask_model', 'ask_model_status', 'ask_model_cancel', 'list_models']);
    expect(crossTools({ delegate: false })).toEqual([]);
    expect(crossTools({ delegate: true, origin: ORIGIN_MODEL })).toEqual([]);
    const ask = crossTools({ delegate: true })[0];
    expect(ask.inputSchema.required).toEqual(['task']);
    expect(ask.inputSchema.properties.tools.enum).toEqual(['none', 'read', 'full']);
  });
  it("list_models: the user's models with context, vision and price – never Claude Code's own", () => {
    const models = [
      { id: 'glm-5.3', name: 'GLM 5.3', limit: { context: 200000 }, cost: { text: { input: { price: 1.4 }, output: { price: 4.4 } } } },
      { id: 'kimi-free', name: 'Kimi', modalities: { input: ['text', 'image'] }, limit: { context: 128000 } },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', capabilities: { image: { input: { supported: true } } }, limit: { context: 1000000 }, cost: { text: { input: { price: 5 }, output: { price: 25 } } } },
      { id: 'cc:default', name: 'Claude Code', source: 'claudecode' },
      { id: 'x', source: 'claudecode' },
    ];
    const t = listModelsText(models, 'kimi-free');
    expect(t).toMatch(/^3 models/);
    expect(t).toContain('- glm-5.3 (GLM 5.3): 200K context, text only, $1.4 in / $4.4 out per M tokens');
    expect(t).toContain('- kimi-free (Kimi) [helper model – the default]: 128K context, sees images, free');
    expect(t).toContain('claude-opus-5-5 (Claude Opus 5.5): 1000K context, sees images, $5 in');
    expect(t).not.toContain('cc:');
    expect(t).not.toMatch(/^- x/m);
    expect(listModelsText([])).toMatch(/No models/);
  });
  it('list_models: helper first then A–Z, 80 a page with the way to the rest, and query finds one anywhere in the list (decision 214)', () => {
    const models = Array.from({ length: 91 }, (_, i) => ({ id: `m${String(i).padStart(2, '0')}`, name: `Model ${String(i).padStart(2, '0')}` }));
    models.push({ id: 'pvc5b520:claude-sonnet-5-5', name: 'Claude Sonnet 5.5' });
    const first = listModelsText(models);
    expect(first).toMatch(/^92 models, showing 1–80 \(the helper model first, then A–Z/);
    expect(first.split('\n')[1]).toContain('Claude Sonnet 5.5'); // A–Z: "Claude…" before "Model…"
    expect(first).toMatch(/… 12 more: call list_models with offset 80, or use query/);
    const next = listModelsText(models, '', { offset: 80 });
    expect(next).toMatch(/showing 81–92/);
    expect(next).toContain('- m90 (Model 90)');
    expect(next).not.toMatch(/more:/);
    const q = listModelsText(models, '', { query: 'SONNET 5.5' });
    expect(q).toMatch(/^1 of 92 models match "SONNET 5.5"/);
    expect(q).toContain('pvc5b520:claude-sonnet-5-5 (Claude Sonnet 5.5)');
    expect(listModelsText(models, '', { query: 'gpt' })).toMatch(/No model matches "gpt" \(of 92\)/);
  });
  it('list_models says where each model runs and who pays: an Anthropic API key is not the subscription (decision 215)', () => {
    const models = [
      { id: 'pvc5b520:claude-opus-5-5', name: 'Claude Opus 5.5', source: 'custom', providerId: 'pvc5b520', providerName: 'Claude API', anthropic: { adaptive: true } },
      { id: 'pvx:gpt-6', name: 'GPT 6', source: 'custom', providerId: 'pvx', providerName: 'OpenAI' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', cost: { text: { input: { price: 0.1 }, output: { price: 0.5 } } } },
      { id: 'gemma', name: 'Gemma', source: 'local' },
    ];
    const t = listModelsText(models);
    expect(t).toContain('- pvc5b520:claude-opus-5-5 (Claude Opus 5.5): text only, Anthropic\'s API prices · via Anthropic API key "Claude API" – billed per token to that key, not the Claude subscription');
    expect(t).toContain('· via the user\'s own key at "OpenAI"');
    expect(t).toContain('- claude-haiku-5-5 (Claude Haiku 5.5): text only, $0.1 in / $0.5 out per M tokens · via OpenCode (Zen / Go)');
    expect(t).toContain('· via on this phone – free');
    expect(t).toMatch(/None of these is your own Claude subscription: you, Claude Code, run on that/);
    // the API-key ones can be found by asking for them
    expect(listModelsText(models, '', { query: 'api key' })).toMatch(/^1 of 4 models match/);
  });
});

/** A fake ACP client: one session, scripted updates and questions on prompt, cancel ends the turn. */
function fakeClient(script) {
  const c = { configs: new Map(), calls: [], watchers: new Map(), permits: new Map() };
  const cfg = (model, effort) => [
    { id: 'model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'default', name: 'Default' }, { value: 'sonnet', name: 'Sonnet' }] },
    { id: 'effort', category: 'thought_level', type: 'select', currentValue: effort, options: [{ value: 'default', name: 'Default' }, { value: 'low' }, { value: 'high' }] },
  ];
  let endTurn = null;
  c.newSession = async (cwd, o) => (c.calls.push(['new', cwd, o]), c.configs.set('s1', cfg('default', 'default')), 's1');
  c.setConfigOption = async (sid, id, v) => {
    c.calls.push(['set', id, v]);
    const cur = c.configs.get(sid);
    c.configs.set(sid, cfg(id === 'model' ? v : cur[0].currentValue, id === 'effort' ? v : cur[1].currentValue));
  };
  c.prompt = (sid, text) =>
    new Promise((resolve) => {
      c.calls.push(['prompt', text]);
      endTurn = resolve;
      const up = (u) => c.watchers.get(sid)?.(u);
      script({ up, ask: (p) => c.permits.get(sid)?.({ sessionId: sid, ...p }), end: (r) => resolve(r || { stopReason: 'end_turn' }) });
    });
  c.cancel = (sid) => {
    c.calls.push(['cancel', sid]);
    endTurn?.({ stopReason: 'cancelled' });
  };
  c.closeSession = async (sid) => (c.calls.push(['close', sid]), true);
  return c;
}
const runner = (client, extra = {}) =>
  runClaudeCodeTask({ client, watch: (sid, fn) => (fn ? client.watchers.set(sid, fn) : client.watchers.delete(sid)), permit: (sid, fn) => (fn ? client.permits.set(sid, fn) : client.permits.delete(sid)), ask: async () => 'Allow', cwd: '/chats/c1', task: 'Build it', ...extra });

describe('the hidden-session runner', () => {
  it('progress, a permission question forwarded, the final text, the session closed', async () => {
    const seen = [];
    const asked = [];
    const client = fakeClient(async ({ up, ask, end }) => {
      up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will edit it. ' } });
      up({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit main.py', kind: 'edit', status: 'pending' });
      const pick = await ask({ toolCall: { title: 'Edit main.py' }, options: [{ optionId: 'ok', name: 'Allow' }, { optionId: 'no', name: 'Reject' }] });
      up({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: pick === 'ok' ? 'completed' : 'failed' });
      up({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'npm test', kind: 'execute', status: 'failed' });
      up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Done (${pick}).` } });
      end();
    });
    const r = await runner(client, {
      model: 'sonnet',
      effort: 'high',
      systemPrompt: 'SP',
      mcpServers: [{ name: 'chronicle' }],
      onProgress: (p) => seen.push(progressLine(p)),
      ask: async (q, opts) => (asked.push([q, opts]), 'Allow'),
    });
    expect(r.text).toBe('I will edit it. Done (ok).');
    expect(r.steps).toEqual([
      { name: 'edit', label: 'Edit main.py', status: 'done' },
      { name: 'shell', label: 'npm test', status: 'error' },
    ]);
    expect(r.cancelled).toBe(false);
    expect(r.model).toBe('sonnet');
    expect(asked).toEqual([['Claude Code (in Linux, working for the assistant) wants to: Edit main.py', ['Allow', 'Reject']]]);
    expect(seen).toContain('Claude Code · step 1: edit Edit main.py');
    expect(seen).toContain('Claude Code is waiting for your OK: Edit main.py');
    expect(client.calls[0]).toEqual(['new', '/chats/c1', { systemPrompt: 'SP', mcpServers: [{ name: 'chronicle' }], meta: null }]);
    expect(client.calls.filter((x) => x[0] === 'set')).toEqual([['set', 'model', 'sonnet'], ['set', 'effort', 'high']]);
    expect(client.calls.find((x) => x[0] === 'prompt')).toEqual(['prompt', 'Build it']);
    expect(client.calls.at(-1)).toEqual(['close', 's1']);
    expect(client.watchers.size + client.permits.size).toBe(0);
  });
  it('Stop cancels the session (session/cancel) and still closes it', async () => {
    const ac = new AbortController();
    const client = fakeClient(({ up }) => {
      up({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Long build', kind: 'execute', status: 'in_progress' });
      setTimeout(() => ac.abort(), 5);
    });
    const r = await runner(client, { signal: ac.signal });
    expect(client.calls.some((x) => x[0] === 'cancel')).toBe(true);
    expect(r.cancelled).toBe(true);
    expect(r.steps[0].status).toBe('error');
    expect(client.calls.at(-1)).toEqual(['close', 's1']);
  });
  it('a model Claude Code does not offer is refused (not swapped for the default), and the session is closed', async () => {
    const client = fakeClient(({ end }) => end());
    await expect(runner(client, { model: 'opus-9' })).rejects.toThrow(/no model "opus-9" – use one of: default, sonnet/);
    expect(client.calls.some((x) => x[0] === 'prompt')).toBe(false);
    expect(client.calls.at(-1)).toEqual(['close', 's1']);
  });
  it('already stopped: no session at all', async () => {
    const ac = new AbortController();
    ac.abort();
    const client = fakeClient(({ end }) => end());
    await expect(runner(client, { signal: ac.signal })).rejects.toThrow(/Stopped/);
    expect(client.calls).toEqual([]);
  });
});

describe('the claude_code tool result', () => {
  it('the final text is the result, with a note; the card gets the task, steps and answer', async () => {
    const status = [];
    const r = await runClaudeCodeTool({ task: 'Fix the tests', model: 'sonnet' }, {
      onStatus: (t) => status.push(t),
      claudeCode: async (t, signal, onProgress) => {
        expect(t).toEqual({ task: 'Fix the tests', model: 'sonnet', effort: '' });
        onProgress({ steps: [{ name: 'shell', label: 'npm test', status: 'running' }] });
        return { text: 'All green.', steps: [{ name: 'shell', label: 'npm test', status: 'done' }], stopReason: 'end_turn', model: 'sonnet' };
      },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("All green.\n\n[Claude Code (model sonnet), on the user's Claude plan; it took 1 step: shell]");
    expect(r.display).toMatchObject({ path: 'Claude Code · sonnet', task: 'Fix the tests', output: 'All green.', steps: [{ name: 'shell', label: 'npm test', status: 'done' }] });
    expect(status).toEqual(['Starting Claude Code…', 'Claude Code · step 1: shell npm test']);
    const stopped = await runClaudeCodeTool({ task: 'x' }, { claudeCode: async () => ({ text: '', steps: [], cancelled: true }) });
    expect(stopped.ok).toBe(false);
    expect(stopped.result).toMatch(/sent no answer[\s\S]*stopped before it finished/);
    expect((await runClaudeCodeTool({ task: 'x' }, {})).ok).toBe(false);
    await expect(runClaudeCodeTool({}, { claudeCode: async () => ({}) })).rejects.toThrow(/task is required/);
    expect(taskSystemPrompt({ cwd: '/chats/c1', toolsLine: 'TOOLS' })).toMatch(/working for another AI assistant[\s\S]*\/chats\/c1[\s\S]*TOOLS$/);
  });
});
