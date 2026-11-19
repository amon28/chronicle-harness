import { describe, it, expect } from 'vitest';
import { expandMacros, parseExamples, injectAtDepth } from '../../src/rp.js';

describe('expandMacros', () => {
  const ctx = { char: 'Seraphina', user: 'Alex', personality: 'kind', scenario: 'a forest', seed: 'chat1' };
  it('replaces character and user names, including <BOT>/<USER>', () => {
    expect(expandMacros('{{char}} greets {{user}}. <BOT> and <USER>', ctx)).toBe('Seraphina greets Alex. Seraphina and Alex');
  });
  it('is case-insensitive and leaves unknown macros alone', () => {
    expect(expandMacros('{{CHAR}} {{unknownThing}}', ctx)).toBe('Seraphina {{unknownThing}}');
  });
  it('removes comments and handles {{trim}}', () => {
    expect(expandMacros('a {{// hidden note}}b', ctx)).toBe('a b');
    expect(expandMacros('left   {{trim}}   right', ctx)).toBe('leftright');
  });
  it('random picks one of the options; pick is stable for a chat', () => {
    expect(['x', 'y', 'z']).toContain(expandMacros('{{random:x,y,z}}', ctx));
    const a = expandMacros('{{pick::red::green::blue}}', ctx);
    expect(expandMacros('{{pick::red::green::blue}}', ctx)).toBe(a);
  });
  it('rolls dice within range', () => {
    for (let i = 0; i < 20; i++) {
      const n = Number(expandMacros('{{roll:2d6}}', ctx));
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(12);
    }
  });
  it('fills empty for known-but-missing values', () => {
    expect(expandMacros('[{{description}}]', ctx)).toBe('[]');
  });
});

describe('parseExamples', () => {
  it('splits <START> blocks into user/assistant turns', () => {
    const mes = '<START>\n{{user}}: Hi!\n{{char}}: *waves* Hello.\nMore text\n<START>\nRich: Bye\nSeraphina: Farewell';
    const blocks = parseExamples(mes, 'Seraphina', 'Alex');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual([
      { role: 'user', content: 'Hi!' },
      { role: 'assistant', content: '*waves* Hello.\nMore text' },
    ]);
    expect(blocks[1][1]).toEqual({ role: 'assistant', content: 'Farewell' });
  });
  it('returns nothing for empty input', () => {
    expect(parseExamples('', 'a', 'b')).toEqual([]);
  });
});

describe('injectAtDepth', () => {
  const hist = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
  ];
  it('depth 0 goes after the last message, depth 2 before the last two', () => {
    const out = injectAtDepth(hist, [{ depth: 0, content: 'D0' }, { depth: 2, content: 'D2', role: 'user' }]);
    expect(out.map((m) => m.content)).toEqual(['u1', 'D2', 'a1', 'u2', 'D0']);
    expect(out[1].role).toBe('user');
    expect(out[4].role).toBe('system');
  });
  it('never splits a tool call from its results', () => {
    const h = [{ role: 'assistant', content: '', tool_calls: [{ id: 'c' }] }, { role: 'tool', content: 'r' }];
    const out = injectAtDepth(h, [{ depth: 1, content: 'N' }]);
    expect(out.map((m) => m.role)).toEqual(['system', 'assistant', 'tool']);
  });
  it('skips empty injections', () => {
    expect(injectAtDepth(hist, [{ depth: 0, content: '  ' }])).toHaveLength(3);
  });
});

describe('chat variables', () => {
  it('set, get, add, inc, dec, global', async () => {
    const { expandMacros } = await import('../../src/rp.js');
    const ctx = { vars: {}, globalVars: {} };
    expect(expandMacros('{{setvar::hp::10}}HP {{getvar::hp}}', ctx)).toBe('HP 10');
    expandMacros('{{addvar::hp::-3}}{{incvar::hp}}{{decvar::gold}}', ctx);
    expect(ctx.vars).toEqual({ hp: 8, gold: -1 });
    expandMacros('{{setglobalvar::day::Monday}}', ctx);
    expect(expandMacros('{{getglobalvar::day}} / {{getvar::missing}}.', ctx)).toBe('Monday / .');
    expandMacros('{{addvar::log::a}}{{addvar::log::b}}', ctx);
    expect(ctx.vars.log).toBe('ab');
  });
});
