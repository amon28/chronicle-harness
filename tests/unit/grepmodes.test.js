import { describe, it, expect } from 'vitest';
import { grepFiles, formatGrep } from '../../src/codeedit.js';

const body = { 'a.js': 'x\nTODO 1\nTODO 2\n', 'b.js': 'TODO 3\n', 'c.js': 'nothing\n' };
const files = Object.keys(body).map((path) => ({ path, size: body[path].length }));
const run = (o) => grepFiles(files, (p) => body[p], { pattern: 'TODO', ...o });

describe('grep output modes', () => {
  it('files mode lists sorted paths', () => {
    const r = run({ mode: 'files' });
    expect(formatGrep(r, 'TODO')).toBe('a.js\nb.js\n\n3 matches in 2 files.');
  });
  it('count mode lists per-file counts and a total', () => {
    expect(formatGrep(run({ mode: 'count' }), 'TODO')).toBe('a.js: 2\nb.js: 1\n\n3 matches in 2 files.');
  });
  it('count mode is not capped by max', () => {
    const r = run({ mode: 'count', max: 1 });
    expect(r.counts.map((c) => c.n)).toEqual([2, 1]);
    expect(r.truncated).toBe(false);
  });
  it('a zero-match result is the same in every mode', () => {
    const out = ['lines', 'files', 'count'].map((mode) => formatGrep(grepFiles(files, (p) => body[p], { pattern: 'zzz', mode }), 'zzz'));
    expect(new Set(out).size).toBe(1);
    expect(out[0]).toMatch(/^No match/);
  });
  it('an invalid mode falls back to lines', () => {
    const r = run({ mode: 'bogus' });
    expect(r.mode).toBe('lines');
    expect(r.hits).toHaveLength(3);
  });
  it('lists at most 500 paths with a +N more line', () => {
    const many = Array.from({ length: 502 }, (_, i) => ({ path: `f${String(i).padStart(3, '0')}.txt`, size: 3 }));
    const out = formatGrep(grepFiles(many, () => 'hit', { pattern: 'hit', mode: 'files' }), 'hit');
    expect(out).toMatch(/\+2 more/);
    expect(out.split('\n').filter((l) => l.endsWith('.txt'))).toHaveLength(500);
  });
});
