import { describe, it, expect } from 'vitest';
import { expandMacros } from '../../src/rp.js';

describe('{{if}} macros', () => {
  const ctx = { char: 'Mira', user: 'Rich', scenario: '', vars: { mood: 'angry', hp: '7' } };
  it('picks a branch by whether a macro has a value', () => {
    expect(expandMacros('{{if scenario}}Scene: {{scenario}}{{else}}No scene{{/if}}', ctx)).toBe('No scene');
    expect(expandMacros('{{if char}}I am {{char}}{{/if}}', ctx)).toBe('I am Mira');
    expect(expandMacros('{{if !scenario}}free{{/if}}', ctx)).toBe('free');
  });
  it('compares variables, as text or numbers', () => {
    expect(expandMacros('{{if var::mood == Angry}}grr{{else}}ok{{/if}}', ctx)).toBe('grr');
    expect(expandMacros('{{if var::hp < 10}}low{{else}}fine{{/if}}', ctx)).toBe('low');
    expect(expandMacros('{{if var::hp >= 10}}fine{{else}}low{{/if}}', ctx)).toBe('low');
    expect(expandMacros('{{if user != Rich}}stranger{{else}}friend{{/if}}', ctx)).toBe('friend');
  });
  it('nests, and the branch not taken does not run', () => {
    const vars = { a: '1' };
    expect(expandMacros('{{if var::a == 1}}A{{if var::b}}B{{else}}notB{{/if}}{{else}}{{setvar::x::1}}{{/if}}', { ...ctx, vars })).toBe('AnotB');
    expect(vars.x).toBeUndefined();
  });
});
