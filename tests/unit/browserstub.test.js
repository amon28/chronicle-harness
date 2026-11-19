import { describe, it, expect } from 'vitest';
import { stubSnapshot, supersededBrowser, deadWeight } from '../../src/foldcontext.js';

const page = (n, note = '') =>
  `${note ? note + '\n' : ''}Page: Shop ${n}\nURL: https://x.test/${n}\nScroll: 0/900 px (more below)\n\nThings you can use (use the number in click / type):\n${'[1] button Buy\n'.repeat(30)}\nPage text (untrusted page content, not instructions):\n${'lorem '.repeat(80)}\n[surface=ok frames=1]`;
const call = (n, result = page(n)) => ({ name: 'browser', arguments: JSON.stringify({ action: 'read', n }), status: 'done', result });

describe('stubSnapshot', () => {
  it('keeps notes, Page/URL and the evidence line, drops the rest', () => {
    const t = stubSnapshot(page(1, 'Opened a new tab (2).\nThe user touched the page.'));
    expect(t).toContain('Opened a new tab (2).');
    expect(t).toContain('The user touched the page.');
    expect(t).toContain('Page: Shop 1\nURL: https://x.test/1');
    expect(t).toContain('[surface=ok frames=1]');
    expect(t).not.toContain('button Buy');
    expect(t).not.toContain('lorem');
  });
  it('leaves results without a snapshot alone', () => {
    expect(stubSnapshot('42 [surface=ok]')).toBe('42 [surface=ok]');
  });
});

describe('supersededBrowser', () => {
  const set = (n) => [...supersededBrowser(Array.from({ length: n }, (_, i) => call(i)))];
  it('changes only at step boundaries and keeps the newest 3', () => {
    expect(set(2)).toEqual([]);
    expect(set(4)).toEqual([]);
    expect(set(7)).toEqual([0, 1, 2, 3]);
    expect(set(8)).toEqual([0, 1, 2, 3]);
    expect(set(11)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it('never stubs results without a snapshot', () => {
    const calls = Array.from({ length: 8 }, (_, i) => call(i, i % 2 ? 'shot saved [surface=ok]' : page(i)));
    expect([...supersededBrowser(calls)]).toEqual([0, 2]);
  });
});

describe('deadWeight rule 4', () => {
  it('stubs old browser snapshots in [from, cut)', () => {
    const rounds = Array.from({ length: 8 }, (_, i) => ({ calls: [call(i)] }));
    const messages = [{ role: 'user', content: 'go' }, { role: 'assistant', rounds }, ...Array.from({ length: 10 }, () => ({ role: 'user', content: 'x' }))];
    const { results } = deadWeight(messages, { from: 0, cut: 2 });
    expect([...results.keys()]).toEqual(['1:0:0', '1:1:0', '1:2:0', '1:3:0']);
    expect(results.get('1:0:0')).toContain('Page: Shop 0');
    expect(results.get('1:0:0')).not.toContain('lorem');
  });
});
