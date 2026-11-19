import { describe, it, expect } from 'vitest';
import { stripChoices, parseChoices } from '../../src/choices.js';

describe('choice chips', () => {
  const reply = '*The door creaks open.*\n\n<choices>\n1. Step inside\n2. *Call out* "Hello?"\n- Run\n</choices>';
  it('reads the options', () => expect(parseChoices(reply)).toEqual(['Step inside', '*Call out* "Hello?"', 'Run']));
  it('hides the block, also while it is still being written', () => {
    expect(stripChoices(reply)).toBe('*The door creaks open.*');
    expect(stripChoices('*The door creaks open.*\n\n<choices>\n1. Step')).toBe('*The door creaks open.*');
    expect(stripChoices('*The door creaks open.*\n\n<cho')).toBe('*The door creaks open.*');
    expect(stripChoices('a < b')).toBe('a < b');
  });
  it('has no options without a block', () => expect(parseChoices('just text')).toEqual([]));
});
