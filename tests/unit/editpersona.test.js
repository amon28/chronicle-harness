import { describe, it, expect } from 'vitest';
import { planPersonaEdit, planLoreEdit } from '../../src/editpersona.js';
import { newEntry } from '../../src/lore.js';

const char = { id: 'p1', name: 'Mira', character: true, card: { name: 'Mira', description: 'A tall archivist. She is 25.', first_mes: 'Hello.', alternate_greetings: ['Hi.', 'Yo.'], personality: 'calm' } };
const pers = { id: 'p2', name: 'Coach', character: false, description: 'fitness', prompt: 'You are a coach. Be strict.' };

describe('edit_persona', () => {
  it('changes only the named fields of a character, keeps the rest', () => {
    const r = planPersonaEdit(char, { edits: [{ field: 'description', old_text: 'She is 25.', new_text: 'She is 40.' }], set: { personality: 'warm' }, add_greetings: ['Welcome back.'], remove_greetings: [2] });
    expect(r.card).toMatchObject({ name: 'Mira', description: 'A tall archivist. She is 40.', first_mes: 'Hello.', personality: 'warm', alternate_greetings: ['Hi.', 'Welcome back.'] });
    expect(r.changed).toEqual(['personality', 'description (1 edit)', '+1 greeting', '−1 greeting']);
  });
  it('a chat persona: edits default to the prompt; unknown fields are refused', () => {
    expect(planPersonaEdit(pers, { edits: [{ old_text: 'Be strict.', new_text: 'Be kind.' }] }).persona.prompt).toBe('You are a coach. Be kind.');
    expect(() => planPersonaEdit(pers, { set: { first_mes: 'x' } })).toThrow(/Unknown field first_mes/);
    expect(() => planPersonaEdit(pers, { edits: [{ old_text: 'nope', new_text: 'x' }] })).toThrow();
    expect(() => planPersonaEdit(pers, {})).toThrow(/Nothing to change/);
  });
});

describe('edit_lorebook', () => {
  const entries = [{ ...newEntry(), name: 'Library', keys: ['library', 'archive'], content: 'The library is old.' }, { ...newEntry(), name: '', keys: ['river'], content: 'A river.' }];
  it('add, update (by name or key, with edits) and remove', () => {
    const r = planLoreEdit(entries, { update: [{ entry: 'archive', edits: [{ old_text: 'old', new_text: 'ancient' }], sticky: 2 }], remove: ['river'], add: [{ keys: 'tower, spire', content: 'A tall tower.' }] }, newEntry);
    expect(r.entries.map((e) => e.content)).toEqual(['The library is ancient.', 'A tall tower.']);
    expect(r.entries[0].sticky).toBe(2);
    expect(r.entries[1].keys).toEqual(['tower', 'spire']);
    expect(r.changed).toEqual(['removed “river”', 'updated “library”', 'added “tower”']);
    expect(entries[0].content).toBe('The library is old.'); // the original is untouched
  });
});
