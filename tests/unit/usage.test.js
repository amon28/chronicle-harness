import { describe, it, expect, beforeEach } from 'vitest';

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = String(v)), removeItem: (k) => delete store[k] };
const { recordUsage, chatSpend, chatIdOf, todayTokens, clearUsage } = await import('../../src/usage.js');

beforeEach(() => clearUsage());
describe('usage per chat', () => {
  it('strips the side-request suffix from session ids', () => {
    expect(chatIdOf('abc-123')).toBe('abc-123');
    expect(chatIdOf('abc-123-story')).toBe('abc-123');
    expect(chatIdOf('abc-123-helper')).toBe('abc-123');
  });
  it('adds up tokens per chat, biggest first, priced from the model list', () => {
    recordUsage('m1', { prompt_tokens: 1000, completion_tokens: 100 }, 'chat', 'c1');
    recordUsage('m1', { prompt_tokens: 500, completion_tokens: 50 }, 'chat', 'c1');
    recordUsage('m1', { prompt_tokens: 100, completion_tokens: 10 }, 'chat', 'c2');
    const rows = chatSpend([{ id: 'm1', cost: { text: { input: { price: 2 }, output: { price: 10 } } } }]);
    expect(rows.map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(rows[0]).toMatchObject({ in: 1500, out: 150, reqs: 2 });
    expect(rows[0].value).toBeCloseTo((1500 * 2 + 150 * 10) / 1e6, 8);
    expect(todayTokens()).toBe(1500 + 150 + 110);
  });
});

describe('memory merge for folder sync', () => {
  it('keeps both sides and lets the newer edit win', async () => {
    const { mergeMemories } = await import('../../src/backup.js');
    const mine = [{ id: 'a', text: 'old', updatedAt: 1 }, { id: 'b', text: 'only mine', updatedAt: 5 }];
    const theirs = [{ id: 'a', text: 'edited on the PC', updatedAt: 9 }, { id: 'b', text: 'stale', updatedAt: 2 }, { id: 'c', text: 'new', updatedAt: 3 }];
    const out = mergeMemories(mine, theirs);
    expect(out.map((m) => `${m.id}:${m.text}`).sort()).toEqual(['a:edited on the PC', 'b:only mine', 'c:new']);
  });
});
