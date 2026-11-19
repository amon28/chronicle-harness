import { describe, it, expect } from 'vitest';
import { runSubagent } from '../../src/subagent.js';

const call = (id) => ({ id, name: 'read_file', arguments: '{"path":"a"}' });
const run = async (result, turns) => {
  const seen = [];
  let n = 0;
  const r = await runSubagent({
    task: 'T',
    system: 'S',
    mode: 'read',
    maxSteps: 20,
    tools: [{ type: 'function', function: { name: 'read_file' } }],
    chat: async (req) => {
      seen.push(req.messages.map((m) => ({ ...m })));
      return n++ < turns ? { content: '', toolCalls: [call('c' + n)] } : { content: 'done' };
    },
    runTool: async () => ({ ok: true, result }),
  });
  return { seen, r };
};

describe('helper context hygiene', () => {
  it('keeps head and tail of a long result, including the last line', async () => {
    const body = Array.from({ length: 800 }, (_, i) => `line ${i} xxxxxxxxxxxxxxxx`).join('\n') + '\nEVIDENCE: final';
    expect(body.length).toBeGreaterThan(12000);
    const { seen } = await run(body, 1);
    const t = seen[1].find((m) => m.role === 'tool').content;
    expect(t.length).toBeLessThan(12300);
    expect(t.startsWith('line 0 ')).toBe(true);
    expect(t.endsWith('EVIDENCE: final')).toBe(true);
    expect(t).toContain('truncated');
  });

  it('keeps a .out path from the cut middle', async () => {
    const body = 'a'.repeat(9000) + '\nSaved to .out/x.txt\n' + 'b'.repeat(9000) + '\nend';
    const { seen } = await run(body, 1);
    const t = seen[1].find((m) => m.role === 'tool').content;
    expect(t).toContain('.out/x.txt');
    expect(t.endsWith('end')).toBe(true);
  });

  it('collapses tool results older than the newest 5, never system or user', async () => {
    const { seen } = await run('R'.repeat(1000), 9);
    const msgs = seen[9]; // step 9
    const tools = msgs.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(9);
    const full = tools.filter((m) => m.content.length === 1000);
    expect(full).toHaveLength(5);
    expect(tools.slice(0, 4).every((m) => m.content.endsWith('[older helper step trimmed]') && m.content.length < 450)).toBe(true);
    expect(tools.slice(4).every((m) => m.content.length === 1000)).toBe(true);
    expect(msgs[0]).toEqual({ role: 'system', content: 'S' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'T' });
  });

  it('collapses in groups of 4, so the sent prefix changes only at those steps (cache-stable)', async () => {
    const { seen } = await run('R'.repeat(1000), 13);
    const collapsed = (k) => seen[k].filter((m) => m.role === 'tool' && m.content.endsWith('[older helper step trimmed]')).length;
    expect([6, 7, 8, 9, 10, 12, 13].map(collapsed)).toEqual([0, 0, 0, 4, 4, 4, 8]);
  });
});
