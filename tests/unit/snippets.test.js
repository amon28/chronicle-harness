import { describe, it, expect } from 'vitest';
import { ensureSnippets, matchCommand } from '../../src/snippets.js';

describe('snippets', () => {
  it('a new install gets every default, including /init', () => {
    const s = {};
    expect(ensureSnippets(s)).toBe(true);
    expect(s.snippets.some((x) => x.cmd === 'init')).toBe(true);
    expect(ensureSnippets(s)).toBe(false);
  });
  it('an existing list gets /init once, and not if the user already has an /init of their own', () => {
    const a = { snippets: [{ id: 'mine', cmd: 'tldr', text: 'x' }] };
    expect(ensureSnippets(a)).toBe(true);
    expect(a.snippets.map((x) => x.cmd)).toEqual(['tldr', 'init', 'quiz', 'flashcards', 'explain-error']);
    a.snippets = a.snippets.filter((x) => x.cmd !== 'init'); // the user deleted it
    expect(ensureSnippets(a)).toBe(false);
    expect(a.snippets.some((x) => x.cmd === 'init')).toBe(false);
    const b = { snippets: [{ id: 'own', cmd: 'init', text: 'mine' }] };
    ensureSnippets(b);
    expect(b.snippets.filter((x) => x.cmd === 'init')).toHaveLength(1);
    expect(matchCommand('/init keep it brief', b.snippets).snippet.id).toBe('own');
  });
});
