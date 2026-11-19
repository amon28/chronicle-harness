import { describe, it, expect } from 'vitest';
import { compactSettingFor, compactThreshold } from '../../src/compactat.js';

describe('auto-compact threshold', () => {
  it('a share of the model or a fixed number of tokens', () => {
    expect(compactThreshold(0.8, 200000)).toBe(160000);
    expect(compactThreshold(64000, 200000)).toBe(64000);
    expect(compactThreshold(400000, 200000)).toBe(190000); // never past 95 % of the model
    expect(compactThreshold(64000, 0)).toBe(64000); // works for models without a known limit
    expect(compactThreshold(0.8, 0)).toBe(Infinity);
  });
  it('the model’s own setting wins over the default', () => {
    const s = { prefs: { compactAt: 0.7 }, compactAtModel: { 'kimi-k3': 100000 } };
    expect(compactSettingFor(s, 'kimi-k3')).toBe(100000);
    expect(compactSettingFor(s, 'glm-5.3')).toBe(0.7);
    expect(compactSettingFor({}, 'x')).toBe(0.8);
  });
});
