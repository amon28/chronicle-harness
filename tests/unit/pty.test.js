import { describe, it, expect } from 'vitest';
import { withMods } from '../../src/ptykeys.js';

describe('terminal keys', () => {
  it('Ctrl and Alt from the extra row', () => {
    expect(withMods('c', { ctrl: true })).toBe('\x03');
    expect(withMods('[', { ctrl: true })).toBe('\x1b');
    expect(withMods('x', { alt: true })).toBe('\x1bx');
    expect(withMods('ab', { ctrl: true })).toBe('ab');
    expect(withMods('q', {})).toBe('q');
  });
});
