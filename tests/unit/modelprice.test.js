import { describe, it, expect, beforeEach } from 'vitest';
import { modelAbilities, modelCost } from '../../src/modelcaps.js';
import { hasUsableModel, isFree } from '../../src/models.js';

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = String(v)), removeItem: (k) => delete store[k] };
const { recordUsage, usageSummary, chatSpend, sourceSpend, modelPrice, clearUsage } = await import('../../src/usage.js');

// Decision 275: a custom endpoint's models had no price (OpenRouter's pricing was never read), so usage counted them
// at $0; ":free" ids were not free; Settings opened at every start without an OpenCode Go key.
describe('prices from the provider', () => {
  it("OpenRouter's pricing (USD per token, strings) becomes cost.text per million", () => {
    const a = modelAbilities({ id: 'x/y', pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' } });
    expect(a.cost).toEqual({ text: { input: { price: 3, cache: { read: 0.3 } }, output: { price: 15 } } });
  });
  it('models.dev-style cost per million, and no price when none is listed or it varies (-1)', () => {
    expect(modelCost({ cost: { input: 0.5, output: 2 } })).toEqual({ text: { input: { price: 0.5 }, output: { price: 2 } } });
    expect(modelCost({ id: 'm' })).toBeUndefined();
    expect(modelCost({ pricing: { prompt: '-1', completion: '-1' } })).toBeUndefined();
    expect(modelCost({ cost: { text: { input: { price: 1 } } } })).toBeUndefined(); // already the app's own shape
  });
  it('":free" and "-free" ids are free', () => {
    expect(isFree({ id: 'deepseek/deepseek-r1:free' })).toBe(true);
    expect(isFree({ id: 'glm-free' })).toBe(true);
    expect(isFree({ id: 'freedom-7b' })).toBe(false);
  });
});

describe('usage says "price unknown" instead of $0', () => {
  beforeEach(() => clearUsage());
  const models = [
    { id: 'priced', cost: { text: { input: { price: 2 }, output: { price: 10 } } } },
    { id: 'p:nop', source: 'custom' },
    { id: 'local:qwen', source: 'local' },
  ];
  it('marks the rows of a model without a price', () => {
    recordUsage('priced', { prompt_tokens: 1000, completion_tokens: 100 }, 'chat', 'c1');
    recordUsage('p:nop', { prompt_tokens: 1000, completion_tokens: 100 }, 'chat', 'c2');
    recordUsage('local:qwen', { prompt_tokens: 10, completion_tokens: 10 }, 'chat', 'c3');
    const u = usageSummary(models, 30);
    const by = Object.fromEntries(u.models.map((m) => [m.model, m]));
    expect(by.priced.unpriced).toBe(false);
    expect(by['p:nop'].unpriced).toBe(true);
    expect(by['local:qwen'].unpriced).toBe(false);
    expect(u.totals.today.unpriced).toBe(true);
    expect(u.totals.today.value).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 8);
    const chats = Object.fromEntries(chatSpend(models).map((r) => [r.id, r.unpriced]));
    expect(chats).toEqual({ c1: false, c2: true, c3: false });
    expect(sourceSpend(models)[0].unpriced).toBe(true);
  });
  it('a model no longer in the list has no known price; a free one has', () => {
    expect(modelPrice(models, 'gone').known).toBe(false);
    expect(modelPrice([{ id: 'x:free', source: 'custom' }], 'x:free').known).toBe(true);
    expect(modelPrice([], 'cc:default').known).toBe(true);
  });
});

describe('Settings opens at start only without any model', () => {
  it('a key, a custom endpoint, the on-device model or Claude Code is enough', () => {
    expect(hasUsableModel({}, [], [])).toBe(false);
    expect(hasUsableModel({ apiKey: 'k' }, [], [])).toBe(true);
    expect(hasUsableModel({}, [{ id: 'p:m', source: 'custom' }], [])).toBe(true);
    expect(hasUsableModel({}, [{ id: 'local:qwen', source: 'local' }], [])).toBe(true);
    expect(hasUsableModel({}, [], [['claude-code:default', 'Claude Code · Default']])).toBe(true);
  });
  it("OpenCode Go's models cached from before the key was removed do not count", () => {
    expect(hasUsableModel({}, [{ id: 'glm-5.3' }], [])).toBe(false);
  });
});
