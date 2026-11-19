import { describe, it, expect } from 'vitest';
import { applyRegexScripts, compileFind } from '../../src/regexscripts.js';

describe('regex scripts', () => {
  const rules = [
    { find: '/\\*/g', replace: '', on: ['ai'], stage: 'save' },
    { find: '/\\(OOC:[^)]*\\)/gi', replace: '', on: ['ai', 'user'], stage: 'display' },
    { find: 'Bob', replace: '{{match}}!', on: ['user'], stage: 'prompt' },
    { find: 'x', replace: 'y', on: ['ai'], stage: 'save', enabled: false },
    { find: 'hi', replace: 'HI', on: ['ai'], stage: 'save', personaId: 'p2' },
  ];
  it('runs only the rules for that author, stage and character', () => {
    expect(applyRegexScripts('*smiles* hi x', rules, { who: 'ai', stage: 'save', personaId: 'p1' })).toBe('smiles hi x');
    expect(applyRegexScripts('hi', rules, { who: 'ai', stage: 'save', personaId: 'p2' })).toBe('HI');
    expect(applyRegexScripts('Yes (OOC: brb) ok', rules, { who: 'user', stage: 'display' })).toBe('Yes  ok');
    expect(applyRegexScripts('Bob and Bob', rules, { who: 'user', stage: 'prompt' })).toBe('Bob! and Bob!');
  });
  it('plain text is matched literally; a broken regex is ignored', () => {
    expect(compileFind('a.b').test('axb')).toBe(false);
    expect(compileFind('/(/')).toBeNull();
    expect(applyRegexScripts('a(b', [{ find: '/(/', replace: '', stage: 'save', on: ['ai'] }], { who: 'ai', stage: 'save' })).toBe('a(b');
  });
});
