import { describe, it, expect } from 'vitest';
import { lineDiff, diffStats, collapseDiff } from '../../src/diff.js';

describe('line diff', () => {
  it('finds added, removed and unchanged lines', () => {
    const ops = lineDiff('a\nb\nc', 'a\nc\nd');
    expect(ops.map((o) => o.t + o.s)).toEqual([' a', '-b', ' c', '+d']);
    expect(diffStats(ops)).toEqual({ added: 1, removed: 1 });
  });
  it('same text → no changes; completely different → all replaced', () => {
    expect(diffStats(lineDiff('x\ny', 'x\ny'))).toEqual({ added: 0, removed: 0 });
    expect(diffStats(lineDiff('x', 'y'))).toEqual({ added: 1, removed: 1 });
  });
  it('collapses long unchanged stretches', () => {
    const a = Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\n');
    const b = a.replace('line 15', 'LINE 15');
    const c = collapseDiff(lineDiff(a, b), 2);
    expect(c.some((o) => o.t === '…')).toBe(true);
    expect(c.filter((o) => o.t === '+')).toHaveLength(1);
    expect(c.length).toBeLessThan(12);
  });
});
