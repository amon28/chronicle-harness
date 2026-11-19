import { describe, it, expect } from 'vitest';
import { nextSpeakable } from '../../src/speech.js';

describe('nextSpeakable', () => {
  it('gives finished sentences only, and moves on', () => {
    const a = nextSpeakable('Hello there. How are you to', 0);
    expect(a.text).toBe('Hello there. ');
    expect(nextSpeakable('Hello there. How are you today? Fine', a.upto).text).toBe('How are you today? ');
  });
  it('waits while a code block is open', () => {
    const t = 'Run this:\n\n```\nx = 1. y = 2. \n';
    expect(nextSpeakable(t, 0).text).toBe('Run this:\n\n');
    expect(nextSpeakable(t, 11).text).toBe('');
  });
  it('ends a sentence after closing quotes or asterisks', () => expect(nextSpeakable('*She smiles.* "Hi!" Then', 0).text).toBe('*She smiles.* "Hi!" '));
});
