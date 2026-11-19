import { describe, expect, it } from 'vitest';
import { alternatives, searchSettings } from '../../src/settingsearch.js';

const E = [
  { kind: 'page', page: 'notify', label: 'Notifications & background', hint: 'Reply notifications, retries', order: 0 },
  { kind: 'page', page: 'look', label: 'Appearance', hint: 'Theme, colours, backgrounds, text size', order: 1 },
  { kind: 'setting', page: 'tools', label: 'Phone data', hint: 'Read your calendar and add events, look up contacts', where: 'Tools & agent › Phone', order: 2 },
  { kind: 'setting', page: 'tools', label: 'Phone status & controls', hint: 'Battery, storage and network', where: 'Tools & agent › Phone', order: 3 },
  { kind: 'setting', page: 'notify', label: 'Run without battery limits', where: 'Notifications & background', order: 4 },
  { kind: 'setting', page: 'account', label: 'OpenCode Go API key', where: 'Account & models', order: 5 },
  { kind: 'setting', page: 'data', label: 'GitHub token', where: 'Data › App updates', order: 6 },
  { kind: 'setting', page: 'look', label: 'Text size', where: 'Appearance', order: 7 },
  { kind: 'setting', page: 'look', label: 'Text size', where: 'Appearance', order: 8 },
];
const labels = (q) => searchSettings(E, q).map((e) => e.label);

describe('settings search', () => {
  it('finds a setting by the words of its label, best match first', () => {
    expect(labels('phone data')[0]).toBe('Phone data');
    expect(labels('api key')).toEqual(['OpenCode Go API key']);
  });
  it('finds what the labels do not say, through the synonym table', () => {
    expect(labels('calendar')).toContain('Phone data');
    expect(labels('location')).toContain('Phone data');
    expect(labels('wifi')).toContain('Phone status & controls');
    expect(labels('git')).toContain('GitHub token');
    expect(labels('font')).toContain('Text size');
  });
  it('"battery" leads to the setting that says it, the phone status and the background page – not to wallpapers', () => {
    const r = labels('battery');
    expect(r[0]).toBe('Run without battery limits');
    expect(r).toContain('Phone status & controls');
    expect(r).toContain('Notifications & background');
    expect(r).not.toContain('Appearance');
  });
  it('a word typed only in part still reaches its synonyms; every word must match', () => {
    expect(alternatives('calen')).toContain('phone data');
    expect(labels('batt')).toContain('Phone status & controls');
    expect(labels('phone nothinglikethis')).toEqual([]);
    expect(labels('   ')).toEqual([]);
  });
  it('the same label on one page is listed once', () => {
    expect(labels('text size').filter((x) => x === 'Text size')).toHaveLength(1);
  });
});
