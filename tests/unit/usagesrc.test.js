import { describe, it, expect, beforeEach } from 'vitest';
import { recordUsage, sourceSpend, sourceOf, sourceOfCalls, sourceName } from '../../src/usage.js';

const mem = {};
globalThis.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => (mem[k] = String(v)), removeItem: (k) => delete mem[k] };

describe('usage by source', () => {
  beforeEach(() => Object.keys(mem).forEach((k) => delete mem[k]));
  it('names where a request came from', () => {
    expect(sourceOf('', 'abc-title')).toBe('title');
    expect(sourceOf('', 'abc')).toBe('reply');
    expect(sourceOf('tool:web_search', 'abc')).toBe('tool:web_search');
    expect(sourceOf('', 'card-edit')).toBe('card-edit');
    expect(sourceOfCalls([{ name: 'mcp_github_search_code' }], ['github'])).toBe('mcp:github');
    expect(sourceOfCalls([{ name: 'web_search' }, { name: 'read_file' }])).toBe('tool:web_search');
    expect(sourceOfCalls([])).toBe('reply');
    expect(sourceName('mcp:github')).toBe('MCP: github');
  });
  it('adds up tokens per source', () => {
    recordUsage('m', { prompt_tokens: 100, completion_tokens: 10 }, 'chat', 'c', 'reply');
    recordUsage('m', { prompt_tokens: 500, completion_tokens: 5 }, 'agent', 'c', 'tool:web_search');
    recordUsage('m', { prompt_tokens: 300, completion_tokens: 5 }, 'agent', 'c', 'tool:web_search');
    const rows = sourceSpend([{ id: 'm', cost: { text: { input: { price: 1 }, output: { price: 2 } } } }]);
    expect(rows.map((r) => r.src)).toEqual(['tool:web_search', 'reply']);
    expect(rows[0]).toMatchObject({ in: 800, out: 10, reqs: 2, name: 'Tool: web_search' });
    expect(rows[0].value).toBeCloseTo((800 + 20) / 1e6);
  });
});
