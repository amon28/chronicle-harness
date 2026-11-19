import { describe, it, expect } from 'vitest';
import { runSubagent, helperToolDefs, helperMayUse, runsInParallel, helperMode } from '../../src/subagent.js';
import { runDelegate, delegateDefs } from '../../src/delegate.js';
import { toolDefs } from '../../src/tools.js';

// a scripted model: each request takes the next reply
const scripted = (replies) => {
  const seen = [];
  return {
    seen,
    chat: async (req) => {
      seen.push({ messages: req.messages.map((m) => ({ ...m })), tools: req.tools });
      return replies.shift() || { content: 'done' };
    },
  };
};
const call = (name, args, id = name + Math.random()) => ({ id, name, arguments: JSON.stringify(args) });

describe('helper agents with tools', () => {
  it('a read helper only gets tools that look, never delegate or ask_user', () => {
    const defs = toolDefs({ web: true, python: true, files: true, delegate: true, shell: false });
    const names = helperToolDefs(defs, 'read').map((d) => d.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('web_search');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_python');
    expect(names).not.toContain('delegate');
    const full = helperToolDefs(defs, 'full').map((d) => d.function.name);
    expect(full).toContain('run_python');
    expect(full).toContain('write_file');
    expect(full).not.toContain('delegate');
    expect(full).not.toContain('ask_user');
    expect(full).not.toContain('save_tool');
    expect(helperToolDefs(defs, 'none')).toEqual([]);
    expect(helperMayUse('phone_write', 'full')).toBe(false);
    expect(helperMayUse('shell', 'full')).toBe(true);
    expect(helperMayUse('shell', 'read')).toBe(false);
  });

  it('only helpers that may write go one at a time', () => {
    expect(runsInParallel('none')).toBe(true);
    expect(runsInParallel('read')).toBe(true);
    expect(runsInParallel('full')).toBe(false);
    expect(helperMode('bogus')).toBe('none');
  });

  it('runs its own tool loop and hands back only the final answer', async () => {
    const m = scripted([{ content: '', toolCalls: [call('read_file', { path: 'a.txt' }, 'c1')] }, { content: 'a.txt says hi' }]);
    const ran = [];
    const r = await runSubagent({
      task: 'What does a.txt say?',
      mode: 'read',
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      chat: m.chat,
      runTool: async (c) => (ran.push(c.name), { ok: true, result: 'hi' }),
    });
    expect(r.text).toBe('a.txt says hi');
    expect(ran).toEqual(['read_file']);
    expect(r.steps).toEqual([{ name: 'read_file', label: 'a.txt', status: 'done' }]);
    // the second request carried the tool call and its result
    const msgs = m.seen[1].messages;
    expect(msgs.find((x) => x.role === 'assistant').tool_calls[0].function.name).toBe('read_file');
    expect(msgs.find((x) => x.role === 'tool')).toMatchObject({ tool_call_id: 'c1', content: 'hi' });
  });

  it('refuses a tool its mode does not allow, without running it', async () => {
    const m = scripted([{ toolCalls: [call('write_file', { path: 'x', content: 'y' })] }, { content: 'could not write' }]);
    let ran = false;
    const r = await runSubagent({ task: 't', mode: 'read', tools: [], chat: m.chat, runTool: async () => ((ran = true), { ok: true, result: '' }) });
    expect(ran).toBe(false);
    expect(r.steps[0].status).toBe('error');
    expect(m.seen[1].messages.at(-1).content).toContain('not available to a helper');
  });

  it('stops at its step limit and asks for a final answer without tools', async () => {
    const loop = { toolCalls: [call('list_files', {})] };
    const m = scripted([loop, loop, { content: 'partial answer' }]);
    const r = await runSubagent({ task: 't', mode: 'read', tools: [{ type: 'function', function: { name: 'list_files' } }], maxSteps: 2, chat: m.chat, runTool: async () => ({ ok: true, result: '[]' }) });
    expect(r.steps.length).toBe(2);
    expect(r.stoppedAtLimit).toBe(true);
    expect(r.text).toBe('partial answer');
    expect(m.seen.at(-1).tools).toBeUndefined();
    expect(m.seen.at(-1).messages.at(-1).content).toContain('final answer');
  });

  it('a tool that throws becomes an error result, not a crash', async () => {
    const m = scripted([{ toolCalls: [call('fetch_url', { url: 'https://x' })] }, { content: 'the page failed' }]);
    const r = await runSubagent({ task: 't', mode: 'read', tools: [], chat: m.chat, runTool: async () => { throw new Error('boom'); } });
    expect(r.text).toBe('the page failed');
    expect(m.seen[1].messages.at(-1).content).toContain('boom');
  });

  it('stops when cancelled', async () => {
    const ac = new AbortController();
    const m = scripted([{ toolCalls: [call('list_files', {})] }]);
    const p = runSubagent({ task: 't', mode: 'read', tools: [], chat: m.chat, runTool: async () => (ac.abort(), { ok: true, result: '' }), signal: ac.signal });
    await expect(p).rejects.toThrow('Cancelled');
  });

  it('mode none sends no tools at all', async () => {
    const m = scripted([{ content: 'sum' }]);
    await runSubagent({ task: 't', mode: 'none', tools: [{ type: 'function', function: { name: 'read_file' } }], chat: m.chat });
    expect(m.seen[0].tools).toBeUndefined();
  });
});

describe('delegate tool with a helper mode', () => {
  it('offers tools and max_steps', () => {
    const p = delegateDefs()[0].function.parameters.properties;
    expect(p.tools.enum).toEqual(['none', 'read', 'full']);
    expect(p.max_steps.type).toBe('integer');
  });
  it('passes the mode on and reports the steps the helper took', async () => {
    let got;
    const r = await runDelegate(
      { task: 'Research it', tools: 'read', max_steps: 50 },
      { workspace: { files: {} }, delegate: async (p, s, o) => ((got = o), { text: 'found it', model: 'Flash', steps: [{ name: 'web_search', label: 'q', status: 'done' }, { name: 'fetch_url', label: 'u', status: 'error' }] }) },
    );
    expect(got.mode).toBe('read');
    expect(got.maxSteps).toBe(20);
    expect(r.result).toContain('found it');
    expect(r.result).toContain('2 tool steps: web_search, fetch_url (failed)');
    expect(r.display.steps.length).toBe(2);
    expect(r.display.mode).toBe('read');
  });
  it('says when the helper ran out of steps', async () => {
    const r = await runDelegate({ task: 'x', tools: 'full' }, { delegate: async () => ({ text: 'half', model: 'M', steps: [], stoppedAtLimit: true }) });
    expect(r.result).toContain('limit of 8 steps');
  });
  it('the calls of one turn run one after another: the later ones wait, and a cancel drops them unstarted (decision 189)', async () => {
    const ac = new AbortController();
    const ran = [];
    const snaps = [];
    const chat = async () => ({ content: '', toolCalls: [
      { id: 'a', name: 'shell', arguments: JSON.stringify({ command: "sleep 60; printf 'first\\n' > c_first.txt" }) },
      { id: 'b', name: 'shell', arguments: JSON.stringify({ command: "printf 'second\\n' > c_second.txt" }) },
    ] });
    const runTool = async (c) => {
      ran.push(c.id);
      ac.abort(); // cancelled while the first one runs
      return { ok: false, result: 'KILLED mid-way' };
    };
    const err = await runSubagent({ task: 't', tools: [{ type: 'function', function: { name: 'shell' } }], mode: 'full', chat, runTool, signal: ac.signal, onStep: (st) => snaps.push(st.map((x) => x.status).join(',')) }).catch((e) => e);
    expect(err.message).toBe('Cancelled');
    expect(ran).toEqual(['a']); // the second never started
    expect(snaps[0]).toBe('waiting,waiting'); // both planned, listed as waiting
    expect(snaps).toContain('running,waiting');
    expect(snaps.at(-1)).toBe('error,not run');
  });
});
