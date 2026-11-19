import { describe, it, expect, vi, beforeEach } from 'vitest';
const calls = [];
let fail = false;
vi.mock('../../src/api.js', () => ({
  httpRequest: async (_url, o) => {
    const m = JSON.parse(o.body);
    calls.push(m.method);
    if (fail) throw new Error('timeout');
    const result = m.method === 'tools/list' ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } : {};
    return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) };
  },
}));
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = String(v)) };
const { mcpToolDefs, needsConnect, listTools } = await import('../../src/mcp.js');

describe('MCP tool list is remembered', () => {
  beforeEach(() => (calls.length = 0));
  it('first message waits for the server, later ones use the remembered list without any request', async () => {
    const s = { id: 'a', name: 'Notes', url: 'https://x.test/mcp' };
    expect(needsConnect([s])).toBe(true);
    const r1 = await mcpToolDefs([s]);
    expect(r1.defs).toHaveLength(1);
    expect(calls).toContain('tools/list');
    calls.length = 0;
    expect(needsConnect([s])).toBe(false);
    const r2 = await mcpToolDefs([s]);
    expect(r2.defs).toHaveLength(1);
    expect(calls).toEqual([]);
  });
  it('a server that failed is not retried on every message', async () => {
    fail = true;
    const s = { id: 'b', name: 'Down', url: 'https://down.test/mcp' };
    await expect(listTools(s)).rejects.toThrow('timeout');
    calls.length = 0;
    await expect(listTools(s)).rejects.toThrow('timeout'); // answered from the failure memory
    expect(calls).toEqual([]);
    fail = false;
  });
});
