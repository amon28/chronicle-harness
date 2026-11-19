import { describe, it, expect } from 'vitest';
import { chanting, cutChant, cycleOf, repeatGuard } from '../../src/autonomy.js';

describe('loop detection (decision 201)', () => {
  it('two tools going round three times with the same results are stopped before the next one, even with other arguments', () => {
    const g = repeatGuard();
    const A = (i) => ['read_file', `{"path":"a.js","start_line":${i}}`];
    const B = (i) => ['edit_file', `{"path":"a.js","old_text":"x${i}","new_text":"y"}`];
    for (let i = 0; i < 2; i++) {
      expect(g.check(...A(i))).toBeNull();
      g.record(...A(i), 'same file');
      expect(g.check(...B(i))).toBeNull();
      g.record(...B(i), 'Error: old_text was not found');
    }
    expect(g.check(...A(2))).toBeNull();
    g.record(...A(2), 'same file');
    expect(g.check(...B(2))).toMatch(/going round in a circle – the same 2 calls \(read_file → edit_file\) 3 times/);
  });
  it('a cycle whose results change is progress, not a loop', () => {
    const g = repeatGuard();
    let k = 0;
    for (let i = 0; i < 3; i++) {
      for (const n of ['edit_file', 'shell']) {
        expect(g.check(n, '{"x":1}')).toBeNull();
        g.record(n, '{"x":1}', `result ${k++}`);
      }
    }
  });
  it('cycleOf needs at least two different calls', () => {
    expect(cycleOf([{ k: 'a', r: '1' }, { k: 'a', r: '1' }, { k: 'a', r: '1' }, { k: 'a', r: '1' }, { k: 'a', r: '1' }], 'a')).toBeNull();
  });
  it('the reply ending in the same passage ten times back to back is chanting; code, tables and repeated sentences in a long answer are not', () => {
    const line = 'I will now check the file again to make sure it is right. ';
    const text = 'Okay. ' + line.repeat(12);
    expect(chanting(text)).toBe(true);
    expect(cutChant(text).length).toBeLessThan(text.length);
    expect(cutChant(text).length).toBeLessThan(200);
    expect(chanting('```js\n' + 'console.log("again and again and again and again");\n'.repeat(15))).toBe(false);
    expect(chanting(Array.from({ length: 30 }, (_, k) => `| row ${k} | value ${k * 3} | ok |`).join('\n'))).toBe(false); // a real table: rows differ
    expect(chanting('A normal long answer. '.repeat(3) + 'x'.repeat(10) + ' with different words in it '.repeat(2))).toBe(false);
    // a filler sentence that comes back in every paragraph of a long answer is not a loop
    const paras = Array.from({ length: 30 }, (_, i) => `Answer paragraph ${i}. ` + 'Some text that wraps over a few lines on a phone screen. '.repeat(3)).join('\n\n');
    expect(chanting(paras)).toBe(false);
    expect(chanting('-'.repeat(600))).toBe(false);
  });
});
