import { describe, it, expect, beforeEach } from 'vitest';
import { runMcpManageTool, masked } from '../../src/mcpmanage.js';
import { isWriteCall } from '../../src/planmode.js';

// Decision 213: the assistant manages the user's MCP servers – every change after the user's OK, never a secret.
let settings, asked, answer, tools, reg, reloaded, shell;
const ctx = () => ({
  ask: async (q, opts) => (asked.push(q), answer ?? opts[0]),
  reloadTools: async () => reloaded++,
  mcpManage: {
    settings: () => settings,
    commit: () => {},
    listTools: async (sv) => {
      if (sv.url?.includes('needs-auth')) throw Object.assign(new Error('401'), { needsAuth: true });
      return tools;
    },
    search: async () => reg,
    canShell: () => shell,
    uid: () => 'abcdef1234567890',
  },
});
const call = (a) => runMcpManageTool('manage_mcp', a, ctx());
beforeEach(() => {
  settings = { mcpServers: [{ id: 'mcp_1', name: 'notes', url: 'https://notes.example/mcp?api_key=SECRET', token: 'tk_9f8e7d', enabled: true, toolCount: 3, disabledTools: ['wipe'] }] };
  asked = [];
  answer = null;
  reloaded = 0;
  shell = true;
  tools = [{ name: 'read', annotations: { readOnlyHint: true } }, { name: 'write' }, { name: 'wipe', annotations: { destructiveHint: true } }];
  reg = [
    { name: 'io.github.acme/weather', title: 'Weather', publisher: 'io.github.acme', description: 'Forecasts', options: [{ kind: 'remote', url: 'https://weather.example/mcp', headers: [{ name: 'X-Units', required: false, secret: false }] }, { kind: 'npm', command: 'npx -y acme-weather', env: [] }] },
    { name: 'io.github.acme/mail', title: 'Mail', description: 'Email', options: [{ kind: 'remote', url: 'https://mail.example/mcp', headers: [{ name: 'Authorization', required: true, secret: true }] }] },
  ];
});

describe('manage_mcp', () => {
  it('list shows each server without its secrets', async () => {
    const r = await call({ action: 'list' });
    expect(r.result).toMatch(/notes – on – 🌐 https:\/\/notes\.example\/mcp\?api_key=… · 2\/3 tools on · has a token\/headers/);
    expect(r.result).not.toContain('SECRET');
    expect(r.result).not.toContain('tk_9f8e7d');
    expect(masked("GITHUB_TOKEN='ghp_x' npx -y srv")).toBe('GITHUB_TOKEN=… npx -y srv');
    expect(masked('https://u:p@h.example/x')).toBe('https://…@h.example/x');
  });
  it('add by url: asked first, switched on, connected, tools reloaded', async () => {
    const r = await call({ action: 'add', url: 'https://tools.example/mcp', name: 'tools' });
    expect(asked[0]).toMatch(/Add the MCP server “tools” – a remote server at https:\/\/tools\.example\/mcp\?[\s\S]*Add only servers you trust/);
    expect(settings.mcpServers.at(-1)).toMatchObject({ name: 'tools', url: 'https://tools.example/mcp', enabled: true, toolCount: 3 });
    expect(r.result).toMatch(/Connected: 3 tools[\s\S]*mcp_tools_<tool>/);
    expect(reloaded).toBe(1);
  });
  it('a command server says what it runs; without Linux it is refused', async () => {
    await call({ action: 'add', command: 'npx -y @modelcontextprotocol/server-memory' });
    expect(asked[0]).toMatch(/⚠ It runs this program in the built-in Linux[\s\S]*server-memory/);
    expect(settings.mcpServers.at(-1)).toMatchObject({ name: 'memory', transport: 'stdio' });
    shell = false;
    await expect(call({ action: 'add', command: 'npx -y other' })).rejects.toThrow(/built-in Linux, which is not set up/);
  });
  it('no: nothing is added', async () => {
    answer = 'Not now';
    const r = await call({ action: 'add', url: 'https://x.example/mcp' });
    expect(r.ok).toBe(false);
    expect(settings.mcpServers).toHaveLength(1);
  });
  it('from the registry: a non-secret value is taken, a server needing a secret is left to the user', async () => {
    await call({ action: 'add', registry: 'io.github.acme/weather', values: { 'X-Units': 'metric' } });
    expect(settings.mcpServers.at(-1)).toMatchObject({ name: 'Weather', url: 'https://weather.example/mcp', headers: 'X-Units: metric', registry: 'io.github.acme/weather' });
    const r = await call({ action: 'add', registry: 'io.github.acme/mail' });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/needs Authorization, which is a secret – those are the user's to enter. Ask them to add it in Settings › MCP servers › Find servers/);
    expect(settings.mcpServers.some((x) => x.name === 'Mail')).toBe(false);
    const s = await call({ action: 'search', query: 'mail' });
    expect(s.result).toMatch(/Authorization \(secret – the user enters it\)/);
  });
  it('the same name twice is refused', async () => {
    await expect(call({ action: 'add', url: 'https://n.example/mcp', name: 'Notes' })).rejects.toThrow(/already a server called Notes/);
  });
  it('test lists the tools with their labels; a server that needs a sign-in says where', async () => {
    const r = await call({ action: 'test', name: 'notes' });
    expect(r.result).toMatch(/✓ read · read-only/);
    expect(r.result).toMatch(/✗ wipe ⚠ can delete/);
    settings.mcpServers[0].url = 'https://needs-auth.example/mcp';
    const a = await call({ action: 'test', name: 'notes' });
    expect(a.ok).toBe(false);
    expect(a.result).toMatch(/needs a sign-in: ask the user to open Settings › MCP servers and tap Sign in/);
  });
  it('set_tools, disable, trust and remove, each after an OK', async () => {
    await call({ action: 'set_tools', name: 'notes', disable_tools: ['write'], enable_tools: ['wipe'] });
    expect(settings.mcpServers[0].disabledTools).toEqual(['write']);
    await expect(call({ action: 'set_tools', name: 'notes', disable_tools: ['nope'] })).rejects.toThrow(/has no tool nope/);
    await call({ action: 'disable', name: 'notes' });
    expect(settings.mcpServers[0].enabled).toBe(false);
    await call({ action: 'trust', name: 'notes', trusted: true });
    expect(settings.mcpServers[0].trusted).toBe(true);
    await call({ action: 'remove', name: 'notes' });
    expect(settings.mcpServers).toEqual([]);
    expect(asked).toHaveLength(4);
  });
  it('plan mode: reading is allowed, changing is not', () => {
    expect(isWriteCall('manage_mcp', { action: 'search', query: 'x' })).toBe(false);
    expect(isWriteCall('manage_mcp', { action: 'add', url: 'https://x' })).toBe(true);
  });
});
