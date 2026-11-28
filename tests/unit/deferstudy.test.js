import { describe, it, expect } from 'vitest';
import { ON_DEMAND, splitBuiltins } from '../../src/deferred.js';
import { applySnippet, ensureSnippets, matchCommand } from '../../src/snippets.js';

// Decision 275.
describe('roleplay_presets waits in load_tools', () => {
  const def = (name) => ({ type: 'function', function: { name, description: name } });
  it('is held back until loaded; search_chats, read_chat and repo_map stay', () => {
    expect(ON_DEMAND.has('roleplay_presets')).toBe(true);
    const defs = ['roleplay_presets', 'search_chats', 'read_chat', 'repo_map'].map(def);
    const { active, deferred } = splitBuiltins(defs);
    expect(deferred.map((d) => d.function.name)).toEqual(['roleplay_presets']);
    expect(active.map((d) => d.function.name)).toEqual(['search_chats', 'read_chat', 'repo_map']);
    expect(splitBuiltins(defs, ['roleplay_presets']).deferred).toEqual([]);
  });
});

describe('study snippets', () => {
  it('a new install has /quiz, /flashcards and /explain-error', () => {
    const s = {};
    ensureSnippets(s);
    const quiz = matchCommand('/quiz photosynthesis', s.snippets);
    expect(applySnippet(quiz.snippet, quiz.rest)).toMatch(/ask_user[\s\S]*multiple-choice[\s\S]*score[\s\S]*photosynthesis$/);
    expect(matchCommand('/flashcards x', s.snippets).snippet.text).toContain('/workspace/output/flashcards.csv');
    expect(matchCommand('/explain-error x', s.snippets).snippet.text).toMatch(/beginner[\s\S]*step by step/);
  });
  it('an existing list gets them once, after the older steps, and keeps its own /quiz', () => {
    const old = { snippetsV: 3, snippets: [{ id: 's_continue', cmd: 'continue', text: 'Continue.', bar: 'rp' }, { id: 'mine', cmd: 'quiz', text: 'my quiz' }] };
    expect(ensureSnippets(old)).toBe(true);
    expect(old.snippetsV).toBe(5);
    expect(old.snippets[0].bar).toBeUndefined(); // the v4 step still ran
    expect(old.snippets.filter((x) => x.cmd === 'quiz')).toEqual([{ id: 'mine', cmd: 'quiz', text: 'my quiz' }]);
    expect(old.snippets.map((x) => x.cmd)).toEqual(['continue', 'quiz', 'flashcards', 'explain-error']);
    expect(ensureSnippets(old)).toBe(false);
  });
});
