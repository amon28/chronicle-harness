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

// Decision 265: a roleplay persona that is not a full card has a greeting and extra greetings the tool can change too;
// a character's note (depth prompt) is edited as text, its depth and role kept
describe('greetings and the character note', () => {
  const persona = { id: 'p1', name: 'Lia', character: false, description: 'A witch', prompt: 'You are Lia.', greeting: '*waves* Hello there.', alternate_greetings: ['Hi!', 'Oh, you again.'] };
  it('changes a persona\'s greeting by an exact edit, and adds and removes its extra greetings', () => {
    const r = planPersonaEdit(persona, { edits: [{ field: 'greeting', old_text: 'Hello there.', new_text: 'Welcome to my tower.' }], add_greetings: ['*looks up from a book*'], remove_greetings: [1] });
    expect(r.persona.greeting).toBe('*waves* Welcome to my tower.');
    expect(r.persona.alternate_greetings).toEqual(['Oh, you again.', '*looks up from a book*']);
    expect(r.changed).toEqual(['greeting (1 edit)', '+1 greeting', '−1 greeting']);
  });
  it('sets a persona\'s greetings whole, and a number that is not there says how many there are', () => {
    expect(planPersonaEdit(persona, { set: { greeting: 'New start.', alternate_greetings: ['A', 'B'] } }).persona).toMatchObject({ greeting: 'New start.', alternate_greetings: ['A', 'B'] });
    expect(() => planPersonaEdit(persona, { remove_greetings: [5] })).toThrow(/2 extra greetings – no number 5/);
  });
  it('edits a character\'s note as text and keeps its depth and role', () => {
    const ch = { id: 'c1', name: 'Mira', character: true, card: { name: 'Mira', description: 'd', first_mes: 'Hi', depth_prompt: { prompt: 'Mira is wary.', depth: 2, role: 'user' } } };
    const r = planPersonaEdit(ch, { edits: [{ field: 'depth_prompt', old_text: 'wary', new_text: 'curious' }] });
    expect(r.card.depth_prompt).toEqual({ prompt: 'Mira is curious.', depth: 2, role: 'user' });
    expect(r.card.first_mes).toBe('Hi');
    // a character without one gets it at the usual depth
    const r2 = planPersonaEdit({ ...ch, card: { name: 'Mira', description: 'd' } }, { set: { depth_prompt: 'Speaks softly.' } });
    expect(r2.card.depth_prompt).toEqual({ depth: 4, role: 'system', prompt: 'Speaks softly.' });
  });
  it('a picture alone is a change', () => {
    expect(planPersonaEdit(persona, { image: 1 }).changed).toEqual([]);
  });
});
