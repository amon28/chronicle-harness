import { describe, it, expect } from 'vitest';
import { CHECK_EVERY_MS, LATEST_URL, isNewer, latestVersion, parseVersion } from '../../src/ccupdate.js';

describe('Claude Code update notice (decision 248)', () => {
  it('reads versions the way Claude Code prints them', () => {
    expect(parseVersion('2.1.325 (Claude Code)')).toEqual([2, 1, 325]);
    expect(parseVersion('v2.10.3')).toEqual([2, 10, 3]);
    expect(parseVersion('')).toBeNull();
  });
  it('compares part by part, not as text', () => {
    expect(isNewer('2.1.330', '2.1.325 (Claude Code)')).toBe(true);
    expect(isNewer('2.10.0', '2.9.99')).toBe(true);
    expect(isNewer('2.1.325', '2.1.325 (Claude Code)')).toBe(false);
    expect(isNewer('2.1.300', '2.1.325')).toBe(false);
    expect(isNewer('', '2.1.325')).toBe(false);
  });
  it('asks the registry at most about once a day, and keeps the last answer when it does not answer', async () => {
    const asked = [];
    const http = async (url) => (asked.push(url), { status: 200, body: JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.330' }) });
    const now = 1_000_000_000;
    const a = await latestVersion({ http, now });
    expect(a).toEqual({ version: '2.1.330', at: now });
    expect(asked).toEqual([LATEST_URL]);
    expect(await latestVersion({ http, known: a, now: now + 3600_000 })).toBe(a); // an hour later: not asked again
    expect(asked.length).toBe(1);
    const b = await latestVersion({ http, known: a, now: now + CHECK_EVERY_MS + 1 });
    expect(asked.length).toBe(2);
    expect(b.at).toBe(now + CHECK_EVERY_MS + 1);
    const down = async () => { throw new Error('offline'); };
    expect(await latestVersion({ http: down, known: a, now: now + 2 * CHECK_EVERY_MS })).toBe(a);
    expect(await latestVersion({ http: async () => ({ status: 503, body: '' }), now })).toBeNull();
  });
});
