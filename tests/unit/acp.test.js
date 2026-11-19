import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AcpClient, readUpdate } from '../../src/acp.js';

// a fake bridge + agent in memory
function fakeBridge() {
  const events = [];
  let wake = null;
  const push = (m) => (events.push(m), wake?.());
  const agent = (m) => {
    if (m.method === 'initialize') push({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') push({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi ' } } } });
      push({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { options: [{ optionId: 'ok', name: 'Allow' }] } });
      agent.after = m.id;
    } else if (m.id === 77) push({ jsonrpc: '2.0', id: agent.after, result: { stopReason: 'end_turn', chose: m.result.outcome.optionId } });
    else if (m.method === 'fs/read_text_file') push({});
  };
  const http = async (url, { method, body }) => {
    if (method === 'POST') return agent(JSON.parse(body)), { status: 202, body: '{}' };
    const since = Number(/since=(\d+)/.exec(url)[1]);
    if (events.length <= since) await new Promise((r) => ((wake = r), setTimeout(r, 50)));
    return { status: 200, body: JSON.stringify({ next: events.length, events: events.slice(since) }) };
  };
  return { http };
}

describe('ACP client', () => {
  it('initializes, opens a session, streams updates and answers a permission request', async () => {
    const { http } = fakeBridge();
    const c = new AcpClient({ url: 'http://pc:8765/', secret: 's', http });
    const seen = [];
    c.onUpdate = (u) => seen.push(readUpdate(u).text);
    c.onPermission = async (p) => p.options[0].optionId;
    await c.start();
    const sid = await c.newSession();
    expect(sid).toBe('s1');
    const r = await c.prompt(sid, 'hello');
    expect(r.stopReason).toBe('end_turn');
    expect(seen).toEqual(['Hi ']);
    c.close();
  });
  it('reads tool calls and plans', () => {
    expect(readUpdate({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'Edit a.py', status: 'pending' })).toEqual({ tool: { id: 't', title: 'Edit a.py', status: 'pending', kind: '' } });
    expect(readUpdate({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed' }, { content: 'b' }] }).plan).toBe('☑ a\n☐ b');
  });
});

describe('ACP client when the bridge goes away', () => {
  it('a request waiting for an answer fails once the bridge has not answered for a while (no reply left writing forever)', async () => {
    let up = true;
    const http = async (url, { method, body }) => {
      if (!up) throw new Error('connect ECONNREFUSED 127.0.0.1:39703');
      if (method === 'POST') {
        const m = JSON.parse(body);
        if (m.method === 'session/prompt') up = false; // Claude Code / the bridge died mid-turn
        return { status: 202, body: '{}' };
      }
      await new Promise((r) => setTimeout(r, 10));
      return { status: 200, body: JSON.stringify({ next: 0, events: [] }) };
    };
    const c = new AcpClient({ url: 'http://127.0.0.1:39703', secret: 's', http, deadAfterMs: 200, retryMs: 20 });
    c.loop();
    let closed = null;
    c.onClose = (e) => (closed = e);
    const r = await Promise.race([c.prompt('s1', 'hi').then(() => 'answered', (e) => e.message), new Promise((res) => setTimeout(() => res('still waiting'), 2000))]);
    expect(r).toMatch(/does not answer/);
    expect(closed).toBeTruthy();
    expect(c.closed).toBe(true);
  });
  it('an idle connection keeps trying (a PC that sleeps for a while is not given up on)', async () => {
    let calls = 0;
    const http = async () => {
      calls++;
      throw new Error('offline');
    };
    const c = new AcpClient({ url: 'http://pc:8765', secret: 's', http, deadAfterMs: 30, retryMs: 10 });
    c.loop();
    await new Promise((r) => setTimeout(r, 150));
    expect(c.closed).toBe(false);
    expect(calls).toBeGreaterThan(3);
    c.close();
  });
});

describe('the real acp-bridge when its agent exits', () => {
  it('still serves the bridge/exit event for a moment, so the app can say the agent stopped', async () => {
    const BRIDGE = fileURLToPath(new URL('../../scripts/acp-bridge.py', import.meta.url));
    const port = 39000 + Math.floor(Math.random() * 900);
    // an agent that crashes a moment after it started
    const p = spawn('python3', [BRIDGE, '--host', '127.0.0.1', '--port', String(port), '--secret', 'the-bridge-secret-123', '--', 'python3', '-c', 'import time,sys; time.sleep(0.6); sys.exit(3)'], { stdio: 'ignore' });
    const h = { Authorization: 'Bearer the-bridge-secret-123' };
    try {
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        up = await fetch(`http://127.0.0.1:${port}/health`, { headers: h }).then((r) => r.ok, () => false);
        if (!up) await new Promise((r) => setTimeout(r, 50));
      }
      expect(up).toBe(true);
      await new Promise((r) => setTimeout(r, 1500)); // the app is between two polls when the agent goes
      const r = await fetch(`http://127.0.0.1:${port}/events?since=0`, { headers: h }).then((x) => x.json(), (e) => ({ error: e.message }));
      expect(r.events?.some((m) => m.method === 'bridge/exit' && m.params.code === 3)).toBe(true);
    } finally {
      p.kill();
    }
  }, 15000);
});

describe('the real acp-bridge with a big burst of output (decision 216)', () => {
  it('hands it out about 1 MB per poll, every event once, in order', async () => {
    const BRIDGE = fileURLToPath(new URL('../../scripts/acp-bridge.py', import.meta.url));
    const port = 39000 + Math.floor(Math.random() * 900);
    // an agent that prints 30 events of 100 KB each at once (a command's long output), then stays
    const agent = 'import json,sys,time\nfor i in range(30): sys.stdout.write(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"n":i,"text":"x"*100000}})+"\\n")\nsys.stdout.flush(); time.sleep(30)';
    const p = spawn('python3', [BRIDGE, '--host', '127.0.0.1', '--port', String(port), '--secret', 'the-bridge-secret-123', '--', 'python3', '-c', agent], { stdio: 'ignore' });
    const h = { Authorization: 'Bearer the-bridge-secret-123' };
    try {
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        up = await fetch(`http://127.0.0.1:${port}/health`, { headers: h }).then((r) => r.ok, () => false);
        if (!up) await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 800));
      const seen = [];
      let next = 0;
      let polls = 0;
      while (seen.length < 30 && polls < 60) {
        const r = await fetch(`http://127.0.0.1:${port}/events?since=${next}`, { headers: h }).then((x) => x.json());
        expect(r.events.length).toBeLessThanOrEqual(11); // ~1 MB: at most one event past it
        seen.push(...r.events.map((m) => m.params.n));
        next = r.next;
        polls++;
      }
      expect(seen).toEqual([...Array(30).keys()]);
      expect(polls).toBeGreaterThanOrEqual(3);
    } finally {
      p.kill();
    }
  }, 20000);
});

describe('usage_update', () => {
  it('reads the agent\'s own context, and ignores a report without numbers', () => {
    expect(readUpdate({ sessionUpdate: 'usage_update', used: 31500, size: 1000000 })).toEqual({ ctx: { used: 31500, size: 1000000 } });
    expect(readUpdate({ sessionUpdate: 'usage_update', used: 0, size: 200000 })).toEqual({ ctx: { used: 0, size: 200000 } });
    expect(readUpdate({ sessionUpdate: 'usage_update' })).toEqual({});
  });
});

describe('a tool card without text content', () => {
  it('says why from rawOutput: an MCP result, an error, a string', async () => {
    const { toolOutput } = await import('../../src/acp.js');
    expect(toolOutput({ status: 'failed', rawOutput: { content: [{ type: 'text', text: 'preview_page failed (the page): ReferenceError: x is not defined' }], isError: true } })).toBe('preview_page failed (the page): ReferenceError: x is not defined');
    expect(toolOutput({ status: 'failed', rawOutput: { error: { message: 'MCP error -32001: Chronicle did not answer' } } })).toBe('MCP error -32001: Chronicle did not answer');
    expect(toolOutput({ status: 'failed', rawOutput: 'The operation timed out.' })).toBe('The operation timed out.');
    expect(toolOutput({ content: [{ type: 'content', content: { type: 'text', text: 'ok' } }], rawOutput: 'ignored' })).toBe('ok');
  });
});
