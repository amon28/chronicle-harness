import { describe, it, expect } from 'vitest';
import { cardSource, cardChanges, applyReimport, undoReimport } from '../../src/reimport.js';

describe('re-import a character', () => {
  it('knows where a character came from', () => {
    expect(cardSource({ cardMode: true, card: { chub_path: 'ana/mira' } })).toBe('https://chub.ai/characters/ana/mira');
    expect(cardSource({ cardMode: true, sourceUrl: 'https://botbooru.com/post/42', card: {} })).toBe('https://botbooru.com/post/42');
    expect(cardSource({ cardMode: true, card: {} })).toBe('');
    expect(cardSource({ card: { chub_path: 'a/b' } })).toBe('');
  });
  it('says what changed', () => {
    expect(cardChanges({ name: 'Mira', description: 'a', alternate_greetings: ['x'] }, { name: 'Mira', description: 'b', alternate_greetings: ['x', 'y', 'z'] }, [{ keys: ['k'], content: 'c' }], [{ keys: ['k'], content: 'c' }, { keys: ['l'], content: 'd' }])).toEqual(['description', '+2 greetings', 'lorebook (1 → 2 entries)']);
    expect(cardChanges({ name: 'A', description: 'same' }, { name: 'A', description: 'same' })).toEqual([]);
  });
  it('updates in place, keeps the lorebook, and can be undone', async () => {
    const lb = { id: 'lb1', name: 'Mira lore', scanDepth: 4, entries: [{ keys: ['k'], content: 'old' }] };
    const p = { id: 'p1', cardMode: true, name: 'Mira', prompt: 'old prompt', card: { name: 'Mira', description: 'old' }, lorebookId: 'lb1', avatar: { image: 'mine' }, voice: { name: 'v' } };
    const deps = { lorebookById: (id) => (id === 'lb1' ? lb : null), newLorebook: () => ({ id: 'new' }), cardPrompt: (c) => 'P:' + c.description, picture: null, putArt: async () => {} };
    const r = await applyReimport(p, { name: 'Mira', description: 'new' }, { entries: [{ keys: ['k'], content: 'new' }] }, deps);
    expect(r.changes).toEqual(['description', 'lorebook (1 → 1 entries)']);
    expect(p).toMatchObject({ id: 'p1', prompt: 'P:new', lorebookId: 'lb1', avatar: { image: 'mine' }, voice: { name: 'v' } });
    expect(lb).toMatchObject({ name: 'Mira lore', scanDepth: 4, entries: [{ keys: ['k'], content: 'new' }] });
    expect(undoReimport(p, deps.lorebookById)).toBe(true);
    expect(p.card.description).toBe('old');
    expect(lb.entries[0].content).toBe('old');
  });
});
