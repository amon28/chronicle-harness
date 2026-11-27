// Chronicle's tools for Claude Code (decision 166): which tools, how they look in MCP, the user's servers, and the
// real acp-bridge's MCP endpoint (token, initialize, tools/list and tools/call through the app, claims, timeouts).
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toolDefs } from '../../src/tools.js';
import { CC_TOOLS, ccEnabled, chronicleServer, mcpResult, mcpToolList, toolsLine, userServers } from '../../src/cctools.js';
import { AcpClient } from '../../src/acp.js';

const BRIDGE = fileURLToPath(new URL('../../scripts/acp-bridge.py', import.meta.url));
const AGENT = fileURLToPath(new URL('../e2e/fixtures/fake_acp_agent.py', import.meta.url));
const ALL = { web: true, python: true, files: true, phone: true, intents: true, device: true, phonectl: true, private: { notifications: true, messages: true }, skills: [{ name: 'x-y', description: 'd' }], delegate: true, creator: true, browser: true, shell: true, preview: true, modAuthor: true, autonomy: true, advisor: true };
const names = (en, on = true) => {
  const e = ccEnabled(en, on);
  return e ? mcpToolList(toolDefs(e)).map((t) => t.name) : [];
};

describe('which Chronicle tools Claude Code gets', () => {
  it('the phone and app tools, not the ones Claude Code has itself', () => {
    const n = names(ALL);
    for (const t of ['calendar', 'contacts', 'location', 'places', 'phone_read', 'phone_write', 'phone_status', 'phone_control', 'take_photo', 'notifications', 'messages', 'browser', 'preview_page', 'memory', 'web_search', 'view_images', 'android_intent', 'search_chats']) expect(n).toContain(t);
    for (const t of ['shell', 'shell_job', 'run_python', 'read_file', 'write_file', 'edit_file', 'grep_files', 'fetch_url', 'delegate', 'ask_user', 'schedule_task', 'run_script', 'goal', 'use_skill', 'save_mod', 'manage_mcp', 'todo_write', 'doctor']) expect(n).not.toContain(t);
    expect(n.every((x) => CC_TOOLS.has(x))).toBe(true);
  });
  it('the creator tools (decision 250): personas, characters, lorebooks, shortcuts – with the chat\'s creator switch', () => {
    const n = names(ALL);
    for (const t of ['list_personas', 'read_persona', 'save_persona', 'save_character', 'edit_persona', 'save_lorebook', 'edit_lorebook', 'read_lorebook', 'shortcuts']) expect(n).toContain(t);
    expect(n).not.toContain('manage_mcp'); // its server list is part of Claude Code's session
    const off = names({ ...ALL, creator: false });
    for (const t of ['save_persona', 'save_character', 'save_lorebook', 'shortcuts']) expect(off).not.toContain(t);
  });
  it("follows the chat's switches: tools off → none; a group off → its tools gone", () => {
    expect(names(ALL, false)).toEqual([]);
    const n = names({ ...ALL, device: false, browser: false, private: false });
    expect(n).not.toContain('calendar');
    expect(n).not.toContain('browser');
    expect(n).not.toContain('messages');
    expect(n).toContain('phone_read');
  });
  it('MCP tool shape: name, description, an object inputSchema', () => {
    const t = mcpToolList(toolDefs(ccEnabled(ALL, true))).find((x) => x.name === 'location');
    expect(t).toMatchObject({ name: 'location', inputSchema: { type: 'object' } });
    expect(t.description.length).toBeGreaterThan(10);
  });
  it('results: text, isError, images as MCP image content (the browser per step too)', () => {
    expect(mcpResult({ ok: true, result: 'here' })).toEqual({ content: [{ type: 'text', text: 'here' }] });
    expect(mcpResult({ ok: false, result: 'nope' })).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
    const r = mcpResult({ ok: true, result: 'pic', images: [{ path: 'a.png', url: 'data:image/png;base64,AAAA' }, { step: 1, pics: ['data:image/jpeg;base64,BBBB'] }, { url: 'https://x/y.png' }] });
    expect(r.content).toEqual([{ type: 'text', text: 'pic' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }]);
  });
  it("the user's MCP servers: http with its own headers and sign-in, stdio as its command, switched-off tools denied", () => {
    const { list, deny } = userServers([
      { id: '1', name: 'Notion API', url: 'https://mcp.notion.com/mcp', headers: 'X-Key: k1', token: 't1', disabledTools: ['delete_page'] },
      { id: '2', name: 'files', transport: 'stdio', command: 'npx -y @mcp/server-files /root', cwd: "/root/it's" },
      { id: '3', name: 'off', url: 'https://x/mcp', enabled: false },
      { id: '4', name: 'chronicle', url: 'https://y/mcp' },
      { id: '5', name: 'Notion api', url: 'https://z/mcp', oauth: { access: 'oa' } },
      { id: '6', name: 'broken', url: 'ftp://nope' },
    ]);
    expect(list).toEqual([
      { type: 'http', name: 'notion_api', url: 'https://mcp.notion.com/mcp', headers: [{ name: 'X-Key', value: 'k1' }, { name: 'Authorization', value: 'Bearer t1' }] },
      { name: 'files', command: 'sh', args: ['-c', "cd '/root/it'\\''s' && npx -y @mcp/server-files /root"], env: [] },
      { type: 'http', name: 'chronicle2', url: 'https://y/mcp', headers: [] },
      { type: 'http', name: 'notion_api2', url: 'https://z/mcp', headers: [{ name: 'Authorization', value: 'Bearer oa' }] },
    ]);
    expect(deny).toEqual(['mcp__notion_api__delete_page']);
    expect(userServers([{ name: 'a', url: 'https://a' }], { on: false }).list).toEqual([]);
    expect(chronicleServer('http://127.0.0.1:4000/', 'cabc', 'tok')).toEqual({ type: 'http', name: 'chronicle', url: 'http://127.0.0.1:4000/mcp/cabc', headers: [{ name: 'Authorization', value: 'Bearer tok' }] });
    expect(toolsLine(['location'], '/chats/c1')).toMatch(/"chronicle" MCP tools .*location.*\/chats\/c1/);
    expect(toolsLine([])).toBe('');
    expect(toolsLine(['read_chat'])).toContain('ToolSearch "select:mcp__chronicle__<name>"');
  });
});

// ---------- the bridge's MCP endpoint, for real ----------
const http = async (url, o = {}) => {
  const r = await fetch(url, { method: o.method || 'GET', headers: o.headers, body: o.body });
  return { status: r.status, body: await r.text(), headers: Object.fromEntries(r.headers) };
};
async function bridge(env = {}) {
  const port = 39000 + Math.floor(Math.random() * 900);
  const p = spawn('python3', [BRIDGE, '--host', '127.0.0.1', '--port', String(port), '--secret', 'the-bridge-secret-123', '--', 'python3', AGENT], { stdio: 'ignore', env: { ...process.env, ...env } });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await http(url + '/health', { headers: { Authorization: 'Bearer the-bridge-secret-123' } });
      if (r.status === 200) return { url, p, token: JSON.parse(r.body).mcpToken };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill();
  throw new Error('bridge did not start');
}
/** An MCP answer, plain JSON or a stream (a tool call: "still working" lines and progress notes, then the answer). */
const answer = (r) => {
  if (!/text\/event-stream/.test(r.headers['content-type'] || '')) return JSON.parse(r.body);
  const msgs = r.body.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  return msgs.filter((m) => 'id' in m).at(-1);
};
const mcp = (b, msg, token = b.token, chat = 'cchat1') => http(`${b.url}/mcp/${chat}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify(msg) });

describe('the MCP endpoint of acp-bridge', () => {
  it('its own token, initialize and notifications in the bridge, tools/list and tools/call answered by the app', async () => {
    const b = await bridge();
    try {
      expect(b.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(b.token).not.toBe('the-bridge-secret-123');
      // the token is checked; the bridge secret is not the MCP token and the other way round
      expect((await mcp(b, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'the-bridge-secret-123')).status).toBe(401);
      expect((await http(b.url + '/health', { headers: { Authorization: `Bearer ${b.token}` } })).status).toBe(401);
      expect((await http(b.url + '/mcp/cchat1', { headers: { Authorization: `Bearer ${b.token}` } })).status).toBe(405); // no SSE stream
      for (const bad of ['bad!chat', 'x', '']) expect([401, 404]).toContain((await mcp(b, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, b.token, bad)).status); // only /mcp/<handle>
      const init = JSON.parse((await mcp(b, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).body);
      expect(init).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'chronicle' } } });
      expect(JSON.parse((await mcp(b, { jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).body).result.protocolVersion).toBe('2025-06-18');
      expect((await mcp(b, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

      // the app: the same ACP client, its onMcp answers; two clients on the bridge run a request only once
      const seen = [];
      const mk = () => {
        const c = new AcpClient({ url: b.url, secret: 'the-bridge-secret-123', http });
        c.onMcp = async ({ chat, method, params }) => {
          seen.push([chat, method, params?.name]);
          if (method === 'tools/list') return { tools: [{ name: 'location', description: 'where', inputSchema: { type: 'object', properties: {} } }] };
          if (params.name === 'slow') await new Promise((r) => setTimeout(r, 300));
          if (params.name === 'boom') throw new Error('it broke');
          return { content: [{ type: 'text', text: `at ${params.arguments.where}` }] };
        };
        c.loop();
        return c;
      };
      const c1 = mk();
      const c2 = mk();
      try {
        const list = JSON.parse((await mcp(b, { jsonrpc: '2.0', id: 'L1', method: 'tools/list', params: {} })).body);
        expect(list).toEqual({ jsonrpc: '2.0', id: 'L1', result: { tools: [{ name: 'location', description: 'where', inputSchema: { type: 'object', properties: {} } }] } });
        // two calls at once: each answer goes to its own request (by the bridge's rid, with the caller's id)
        const [a, z] = await Promise.all([mcp(b, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow', arguments: { where: 'A' } } }), mcp(b, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'location', arguments: { where: 'B' } } })]);
        expect(answer(a)).toEqual({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'at A' }] } });
        expect(answer(z)).toEqual({ jsonrpc: '2.0', id: 8, result: { content: [{ type: 'text', text: 'at B' }] } });
        const err = answer(await mcp(b, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'boom', arguments: {} } }));
        expect(err).toMatchObject({ id: 10, error: { message: 'it broke' } });
        expect(seen.filter((x) => x[1] === 'tools/call').length).toBe(3); // never twice, though two clients read every event
        expect(seen.every((x) => x[0] === 'cchat1')).toBe(true);
        // unknown methods are refused by the bridge itself
        expect(JSON.parse((await mcp(b, { jsonrpc: '2.0', id: 11, method: 'resources/list' })).body).error.code).toBe(-32601);
        // a late or second answer for a request that is done: refused
        expect((await http(b.url + '/mcp-reply', { method: 'POST', headers: { Authorization: 'Bearer the-bridge-secret-123' }, body: JSON.stringify({ rid: 1, message: { result: {} } }) })).status).toBe(404);
        expect((await http(b.url + '/mcp-reply', { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ rid: 1, claim: true }) })).status).toBe(401);
      } finally {
        c1.close();
        c2.close();
      }
    } finally {
      b.p.kill();
    }
  }, 20000);

  it('a slow tool call is a stream that says it is still working, so the agent keeps waiting (decision 178)', async () => {
    const b = await bridge({ ACP_BRIDGE_KEEPALIVE: '0.15' });
    const c = new AcpClient({ url: b.url, secret: 'the-bridge-secret-123', http });
    c.onMcp = async ({ params }) => {
      await new Promise((r) => setTimeout(r, 700)); // a helper model working
      return { content: [{ type: 'text', text: `done ${params.name}` }] };
    };
    c.loop();
    try {
      // with a progress token: progress notes, then the answer, on the open connection
      const r = await mcp(b, { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'ask_model', arguments: {}, _meta: { progressToken: 'p1' } } });
      expect(r.headers['content-type']).toContain('text/event-stream');
      const notes = r.body.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).filter((m) => m.method === 'notifications/progress');
      expect(notes.length).toBeGreaterThanOrEqual(2);
      expect(notes[0].params).toMatchObject({ progressToken: 'p1', progress: 1 });
      expect(notes[0].params.message).toMatch(/Chronicle is still working on ask_model/);
      expect(answer(r)).toEqual({ jsonrpc: '2.0', id: 21, result: { content: [{ type: 'text', text: 'done ask_model' }] } });
      // without one: SSE comments keep the connection busy
      const r2 = await mcp(b, { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'location', arguments: {} } });
      expect(r2.body).toContain(': still working');
      expect(answer(r2)).toMatchObject({ id: 22, result: { content: [{ text: 'done location' }] } });
      // a client that only takes JSON still gets JSON
      const r3 = await http(`${b.url}/mcp/cchat1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'x', arguments: {} } }) });
      expect(JSON.parse(r3.body)).toMatchObject({ id: 23, result: { content: [{ text: 'done x' }] } });
    } finally {
      c.close();
      b.p.kill();
    }
  }, 20000);

  it('an answer that finds the agent no longer waiting is reported to the app (decision 178)', async () => {
    const b = await bridge({ ACP_BRIDGE_MCP_WAIT: '0.3' });
    const late = [];
    const c = new AcpClient({ url: b.url, secret: 'the-bridge-secret-123', http });
    c.onMcp = async () => {
      await new Promise((r) => setTimeout(r, 900));
      return { content: [] };
    };
    c.onMcpLate = (x) => late.push(x);
    c.loop();
    try {
      await mcp(b, { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'ask_model', arguments: {} } });
      for (let i = 0; i < 30 && !late.length; i++) await new Promise((r) => setTimeout(r, 100));
      expect(late).toHaveLength(1);
      expect(late[0]).toMatchObject({ method: 'tools/call', tool: 'ask_model' });
      expect(late[0].error).toMatch(/404/);
    } finally {
      c.close();
      b.p.kill();
    }
  }, 15000);

  it('no app answering: the call ends with an error after the wait, instead of hanging', async () => {
    const b = await bridge({ ACP_BRIDGE_MCP_WAIT: '0.5' });
    try {
      const t = Date.now();
      const r = answer(await mcp(b, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'location', arguments: {} } }));
      expect(r).toMatchObject({ id: 5, error: { code: -32001 } });
      expect(r.error.message).toContain('did not answer');
      expect(Date.now() - t).toBeLessThan(5000);
    } finally {
      b.p.kill();
    }
  }, 15000);
});

describe("a Claude Code chat's folder", () => {
  it("the chats' workspaces are bound at /chats; every command in the Claude Code shell carries the same bind", async () => {
    const { setChatsMount, chatsMount, chatCwd, ccExec, CHATS } = await import('../../src/claudecode.js');
    setChatsMount(() => '/data/user/0/app/files/shell/work');
    expect(await chatsMount()).toBe(`/data/user/0/app/files/shell/work:${CHATS}`);
    expect(await chatCwd('c_123')).toBe('/chats/c_123');
    expect(await chatCwd('../etc')).toBe('');
    const calls = [];
    await ccExec('# x', { exec: async (cmd, o) => (calls.push(o), { output: '' }) });
    await ccExec('# y', { exec: async (cmd, o) => (calls.push(o), { output: '' }) });
    expect(calls).toEqual([{ id: 'claude-code', timeoutMs: 120000, mounts: '/data/user/0/app/files/shell/work:/chats' }, { id: 'claude-code', timeoutMs: 120000, mounts: '/data/user/0/app/files/shell/work:/chats' }]);
    // no host folder (the web build) or a resolver that fails: no bind, and the chat keeps the card's folder
    setChatsMount(() => Promise.reject(new Error('no storage')));
    expect(await chatCwd('c_123')).toBe('');
    setChatsMount(() => 'DATA/shell/work');
    expect(await chatsMount()).toBe('');
    const calls2 = [];
    await ccExec('# z', { exec: async (cmd, o) => (calls2.push(o), { output: '' }) });
    expect(calls2[0].mounts).toBeUndefined();
  });
});

describe('checking a call before it runs (harness report G1, G4)', () => {
  const readChat = { type: 'object', properties: { id: { type: 'string' }, from: { type: 'number' } }, required: ['id'] };
  const askModel = { type: 'object', properties: { task: { type: 'string' }, model: { type: 'string' } }, required: ['task'] };
  it('reads an obvious near-miss as the real name and says so', async () => {
    const { checkArgs } = await import('../../src/cctools.js');
    expect(checkArgs('read_chat', readChat, { chat_id: 'c1' })).toEqual({ args: { id: 'c1' }, note: '("chat_id" was read as "id".)' });
    expect(checkArgs('ask_model', askModel, { prompt: 'hi' })).toEqual({ args: { task: 'hi' }, note: '("prompt" was read as "task".)' });
    expect(checkArgs('read_chat', readChat, { id: 'c1' })).toEqual({ args: { id: 'c1' }, note: '' });
  });
  it('refuses an unknown name or a missing required one, naming what the tool takes', async () => {
    const { checkArgs } = await import('../../src/cctools.js');
    expect(checkArgs('read_chat', readChat, { foo: 1 }).error).toBe('read_chat: unknown parameter "foo". It takes: id (required), from.');
    expect(checkArgs('read_chat', readChat, {}).error).toBe('read_chat: missing "id". It takes: id (required), from.');
    expect(checkArgs('x', { type: 'object', properties: {} }, { anything: 1 })).toEqual({ args: { anything: 1 }, note: '' });
  });
  it('points Claude Code at a spilled file it can actually read', async () => {
    const { ccSpillHint } = await import('../../src/cctools.js');
    const t = 'head … [100 chars not shown. The full output (40000 chars) is saved in .out/m.txt – read parts of it with read_file (start_line / offset) or search it with grep_files (path ".out") instead of running this again.] … tail';
    expect(ccSpillHint(t, true)).toContain('your working directory');
    expect(ccSpillHint(t, true)).toContain('Read tool (offset / limit)');
    expect(ccSpillHint(t, false)).toContain('asking for less');
    expect(ccSpillHint(t, false)).not.toContain('read_file');
  });
});
