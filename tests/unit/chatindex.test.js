import { describe, it, expect } from 'vitest';
import { indexChats, semanticSearch, mergeHits, recall, chunkText, indexProgress } from '../../src/chatindex.js';

// a toy embedder: one dimension per topic word
const TOPICS = ['dragon', 'castle', 'pasta', 'python', 'sword'];
const embed = async (texts) => texts.map((t) => TOPICS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)).concat([0.05]));
const mem = () => {
  const m = new Map();
  return { get: async (id) => (m.has(id) ? structuredClone(m.get(id)) : null), put: async (id, v) => m.set(id, structuredClone(v)), m };
};
const msg = (role, content, at) => ({ role, content, at });

describe('chat index', () => {
  const convs = () => [
    { id: 'a', title: 'Trip', updatedAt: 3, messages: [msg('user', 'We saw an old castle on the hill today', 1), msg('assistant', 'The castle walls looked ancient and grey', 2)] },
    { id: 'b', title: 'Code', updatedAt: 2, messages: [msg('user', 'How do I sort a list in python quickly?', 1), msg('assistant', 'ok', 2)] },
    { id: 'c', title: 'Dinner', updatedAt: 1, messages: [msg('user', 'Give me a pasta recipe with garlic please', 1)] },
  ];
  it('indexes messages in the background, a budget at a time, and skips short ones', async () => {
    const store = mem();
    const cs = convs();
    expect(chunkText(cs[1].messages[1])).toBe('');
    expect(await indexChats(cs, { store, embed, budget: 2 })).toBe(2);
    expect(await indexProgress(cs, store)).toEqual({ indexed: 2, total: 4 });
    expect(await indexChats(cs, { store, embed, budget: 10 })).toBe(2);
    expect(await indexChats(cs, { store, embed, budget: 10 })).toBe(0);
    // an edited message is embedded again, the old vector dropped
    cs[2].messages[0].content = 'Give me a pasta recipe with tomatoes instead';
    expect(await indexChats(cs, { store, embed })).toBe(1);
    expect(Object.keys(store.m.get('c').chunks)).toHaveLength(1);
  });
  it('finds chats by meaning and merges with word hits', async () => {
    const store = mem();
    const cs = convs();
    await indexChats(cs, { store, embed, budget: 99 });
    const hits = await semanticSearch(cs, 'that fortress, the castle', { store, embed });
    expect(hits[0]).toMatchObject({ id: 'a', index: 0 });
    const merged = mergeHits([{ id: 'c', snippet: 'pasta…' }, { id: 'a', snippet: 'castle…' }], hits);
    expect(merged.map((h) => [h.id, h.how])).toEqual([['a', 'both'], ['c', 'words']]);
  });
  it('recalls earlier story messages that fit now, in story order', async () => {
    const store = mem();
    const conv = { id: 'rp', messages: [msg('assistant', 'A dragon circles the tower, smoke trailing', 1), msg('user', 'I draw my sword and wait for it', 2), msg('assistant', 'We cook pasta by the fire tonight', 3), msg('user', 'Now we walk on toward the town', 4), msg('assistant', 'The road is quiet and muddy here', 5)] };
    await indexChats([conv], { store, embed, budget: 99 });
    const r = await recall(conv, { store, embed, before: 3, query: 'the dragon returns! sword ready' });
    expect(r.map((x) => x.i)).toEqual([0, 1]);
    expect(await recall(conv, { store, embed, before: 0, query: 'dragon' })).toEqual([]);
  });
});
