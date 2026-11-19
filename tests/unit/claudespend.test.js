import { describe, it, expect } from 'vitest';
import { sumSpend, hasSpend } from '../../src/api.js';
import { withoutSecrets } from '../../src/backup.js';

describe('Claude spend from the cost analytics rows (decision 208)', () => {
  it('cents strings → dollars for today, the last 7 days and all rows, by model', () => {
    const now = Date.parse('2026-11-18T15:00:00Z');
    const r = (day, model, cents) => ({ starting_at: `2026-11-${day}T00:00:00Z`, group: { model }, cost: { amount: cents.toFixed(6) } });
    const s = sumSpend([r('18', 'claude-opus-5-5', 125), r('17', 'claude-opus-5-5', 300), r('12', 'claude-haiku-5-5', 50), r('01', 'claude-sonnet-5-5', 1000)], now);
    expect(s).toMatchObject({ today: 1.25, week: 4.75, month: 14.75 });
    expect(s.models).toEqual([['claude-sonnet-5-5', 10], ['claude-opus-5-5', 4.25], ['claude-haiku-5-5', 0.5]]);
  });
  it('a backup without keys leaves the Admin key out too', () => {
    const s = withoutSecrets({ providers: [{ id: 'a', kind: 'anthropic', apiKey: 'sk-ant-api', adminKey: 'sk-ant-admin' }] });
    expect(s.providers[0]).toMatchObject({ apiKey: '', adminKey: '' });
  });
  it('only a Claude endpoint with an Admin key asks', () => {
    expect(hasSpend({ kind: 'anthropic', adminKey: 'sk-ant-admin-x' })).toBe(true);
    expect(hasSpend({ kind: 'anthropic', adminKey: ' ' })).toBe(false);
    expect(hasSpend({ kind: 'openai', adminKey: 'x' })).toBe(false);
  });
});
