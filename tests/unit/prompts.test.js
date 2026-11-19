import { describe, it, expect } from 'vitest';
import { P, PROMPT_DEFS, setPromptSource } from '../../src/prompts.js';

describe('editable prompts', () => {
  it('fills only declared placeholders and leaves {{char}} macros and JSON alone', () => {
    setPromptSource(() => ({}));
    const g = P('guest_block', { name: 'Coder', host: 'Assistant', kind: 'conversation', other: 'x' });
    expect(g).toContain('brought you (Coder) into their conversation with Assistant');
    expect(P('group_nudge')).toBe('[Write the next reply only as {{char}}.]');
    expect(P('group_moderator', { roster: '- A', rules: 'R', username: 'Rich' })).toContain('{"speakers": ["Name", ...]}');
  });
  it('uses your edit, and falls back to the default when emptied', () => {
    setPromptSource(() => ({ title: 'Name it like a pirate.', story: '   ' }));
    expect(P('title')).toBe('Name it like a pirate.');
    expect(P('story')).toBe(PROMPT_DEFS.find((d) => d.key === 'story').default);
    setPromptSource(() => ({}));
  });
  it('every prompt has a title, help and group', () => {
    for (const d of PROMPT_DEFS) expect(d.title && d.help && d.group && typeof d.default === 'string').toBeTruthy();
  });
});

describe('memory prompt', () => {
  it('is written for the persona and the user by name, in first person', () => {
    setPromptSource(() => ({}));
    const t = P('memory_extract', { name: 'Lia', username: 'Rich', character: 'A sharp-tongued witch.' });
    expect(t.startsWith('You are Lia.')).toBe(true);
    expect(t).toContain('memory of Rich');
    expect(t).toContain('{"add": ["..."], "update": [{"id": "m_x", "text": "..."}], "remove": ["m_y"]}');
    expect(t).not.toMatch(/\{(name|username|character)\}/);
    expect(t).toContain('private diary');
    expect(t.endsWith('A sharp-tongued witch.')).toBe(true);
    expect(P('memory_episode', { name: 'Lia', character: 'A sharp-tongued witch.' })).toContain('A sharp-tongued witch.');
  });
});
