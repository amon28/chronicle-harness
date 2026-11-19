import { describe, it, expect } from 'vitest';
import { cleanRewrite, buildCorrect } from '../../src/rewrite.js';
import { wordDiff } from '../../src/diff.js';

describe('rewrite', () => {
  it('cleans what models wrap around a rewrite', () => {
    expect(cleanRewrite("Here's the revised text:\n\nShe smiled.")).toBe('She smiled.');
    expect(cleanRewrite('```\nShe smiled.\n```')).toBe('She smiled.');
    expect(cleanRewrite('<<<\nShe smiled.\n>>>')).toBe('She smiled.');
    expect(cleanRewrite('"Hi there"', 'hi ther')).toBe('Hi there');
    expect(cleanRewrite('"Hi," she said. "Go."', '"hi," she said')).toBe('"Hi," she said. "Go."');
  });
  it('puts the instruction and the text in the request', () => {
    expect(buildCorrect('abc', ' make it shorter ')).toContain('Instruction: make it shorter');
  });
  it('diffs words, merging neighbours', () => {
    const d = wordDiff('the red fox runs', 'the blue fox runs fast');
    expect(d.filter((x) => x.t === '-').map((x) => x.s.trim())).toEqual(['red']);
    expect(d.filter((x) => x.t === '+').map((x) => x.s.trim())).toEqual(['blue', 'fast']);
    expect(d.map((x) => (x.t === '-' ? '' : x.s)).join('')).toBe('the blue fox runs fast');
  });
});
