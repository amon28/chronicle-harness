// Decision 154: memories picked by the current question, raw-evidence recall, and work done at write time.
import { describe, it, expect } from 'vitest';
import { pickEpisodeBullets, textKey, selectStory, storyUnits, STORY_FULL, learnBatch, explicitLearn, worthLearning } from '../../src/memory.js';
import { textSims, nameHits, mergeRecall, pastWords, indexChats } from '../../src/chatindex.js';

const mem = () => {
  const m = new Map();
  return { get: async (id) => (m.has(id) ? structuredClone(m.get(id)) : null), put: async (id, v) => m.set(id, structuredClone(v)), m };
};
// a toy embedder: synonyms share a dimension
const TOPICS = [['dog', 'puppy', 'corgi', 'biscuit'], ['flight', 'plane', 'trip', 'kyoto'], ['pasta', 'noodle', 'ramen'], ['sword', 'blade']];
const toy = () => {
  const seen = [];
  const embed = async (texts) => (seen.push(...texts), texts.map((t) => TOPICS.map((ws) => (ws.some((w) => t.toLowerCase().includes(w)) ? 1 : 0)).concat([0.05])));
  return { embed, seen };
};

describe('1. past-chat note bullets by meaning', () => {
  const eps = [
    { id: 'e1', title: 'Pets', text: '- Rich adopted a corgi called Biscuit\n- The vet visit went fine\n- I recommended a harness', updatedAt: 1 },
    { id: 'e2', title: 'Travel', text: '- Rich is going to Kyoto in May\n- He booked a window seat\n- I suggested a rail pass', updatedAt: 4 },
    { id: 'e3', title: 'Food', text: '- Rich makes ramen on Fridays\n- He hates cilantro\n- I shared a broth recipe', updatedAt: 5 },
  ];
  const query = 'my puppy keeps chewing shoes';
  it('without embeddings it is word overlap only, as before', () => {
    expect(pickEpisodeBullets(eps, query, 2)).toEqual(pickEpisodeBullets(eps, query, 2, 1200, null));
    expect(pickEpisodeBullets(eps, query, 2, 1200, new Map()).flatMap((g) => g.bullets)).not.toContain('Rich adopted a corgi called Biscuit'); // no shared word
  });
  it('with similarities a bullet that shares no word but the meaning is picked', async () => {
    const { embed } = toy();
    const items = eps.flatMap((e) => e.text.split('\n').map((l) => l.slice(2))).map((text) => ({ key: textKey(text), text }));
    const sims = await textSims(items, query, { store: mem(), embed });
    const got = pickEpisodeBullets(eps, query, 2, 1200, sims);
    expect(got.flatMap((g) => g.bullets)).toContain('Rich adopted a corgi called Biscuit');
    expect(got.find((g) => g.title === 'Pets')).toBeTruthy();
  });
  it('embeds each bullet once (vectors cached by the text, survives in the store)', async () => {
    const store = mem();
    const { embed, seen } = toy();
    const items = ['Rich is going to Kyoto in May', 'He hates cilantro'].map((text) => ({ key: textKey(text), text }));
    await textSims(items, 'a trip', { store, embed });
    await textSims(items, 'noodles tonight', { store, embed });
    await textSims([...items, { key: textKey('A new bullet'), text: 'A new bullet' }], 'plane', { store, embed });
    const docs = seen.filter((t) => !['a trip', 'noodles tonight', 'plane'].includes(t));
    expect(docs).toEqual(['Rich is going to Kyoto in May', 'He hates cilantro', 'A new bullet']);
    expect(textKey(' He  hates cilantro ')).toBe(textKey('He hates cilantro'));
  });
});

describe('3. roleplay recall by names', () => {
  const m = (role, content) => ({ role, content, at: content.length });
  const msgs = [
    m('assistant', 'Aria smiles and hands you the Moonblade, its edge glowing faintly in the dark.'), // 0
    m('user', 'I thank Aria and we walk down the road towards the village.'), // 1
    m('assistant', 'Aria tells you about the old mill and the miller who vanished years ago.'), // 2
    m('user', 'I ask Aria whether she has ever been to Greywater herself.'), // 3
    m('assistant', 'Aria laughs: Greywater is where she was born, by the lake of reeds.'), // 4
    m('user', 'We rest at the inn and Aria orders two bowls of soup for us.'), // 5
    m('assistant', 'Aria eats quietly and watches the door of the inn all evening.'), // 6
    m('user', 'Later I draw the Moonblade and show it to the innkeeper proudly.'), // 7 (in the window)
  ];
  const names = ['Moonblade', 'Greywater', 'Aria', 'old mill', 'Rich'];
  it('finds older moments that mention what the last messages mention, skipping names found everywhere', () => {
    const hits = nameHits(msgs, { before: 7, names, query: 'Later I draw the Moonblade and think of Greywater' });
    expect(hits.map((h) => h.i).sort()).toEqual([0, 3, 4]);
    expect(hits.every((h) => !h.names.includes('Aria'))).toBe(true); // she is in every message: says nothing
    expect(nameHits(msgs, { before: 7, names, query: 'nothing named here' })).toEqual([]);
    expect(nameHits(msgs, { before: 0, names, query: 'Moonblade' })).toEqual([]);
  });
  it('matches whole names only', () => {
    expect(nameHits(msgs, { before: 7, names: ['Moon'], query: 'the Moon' })).toEqual([]);
  });
  it('merges with meaning hits: no duplicates, at most 3, names from your last message first, story order', () => {
    const byName = [{ i: 0, text: 'a', names: ['Moonblade'] }, { i: 4, text: 'b', names: ['Greywater'] }];
    const meaning = [{ i: 2, text: 'c', score: 0.9 }, { i: 4, text: 'b', score: 0.8 }, { i: 5, text: 'd', score: 0.7 }];
    // the last message names the Moonblade: that hit is kept even though meaning found three
    expect(mergeRecall(meaning, byName, { lastUser: 'I draw the Moonblade', max: 3 }).map((h) => h.i)).toEqual([0, 2, 4]);
    // no name from the last message: meaning hits come first
    expect(mergeRecall(meaning, byName, { lastUser: 'I look around', max: 3 }).map((h) => h.i)).toEqual([2, 4, 5]);
    expect(mergeRecall([], byName, { lastUser: '' }).map((h) => h.i)).toEqual([0, 4]);
  });
});

describe('4. long story memory sent selectively', () => {
  const bullets = Array.from({ length: 40 }, (_, k) => `- Event ${k}: ${k === 17 ? 'Mira hid the silver key under the chapel floor' : 'the party walked on through rain and fog for another long day'} (${'x'.repeat(30)})`);
  const story = `## Key events\n${bullets.slice(0, 30).join('\n')}\n## Current situation\n${bullets.slice(30).join('\n')}`;
  it('a short story memory is sent whole', () => {
    expect(selectStory('## Key events\n- A\n- B\n- C', 'x')).toBeNull();
    expect(selectStory('x'.repeat(STORY_FULL), 'x')).toBeNull();
  });
  it('keeps the first and last points, picks the middle by relevance, within the budget', () => {
    expect(story.length).toBeGreaterThan(STORY_FULL);
    const pick = selectStory(story, 'Where is the silver key?');
    expect(pick.head).toContain('Event 0:');
    expect(pick.head).toContain('Event 39:');
    expect(pick.head.startsWith('## Key events')).toBe(true);
    expect(pick.head).toContain('## Current situation');
    expect(pick.middle).toContain('silver key');
    expect(pick.head.length + pick.middle.length).toBeLessThanOrEqual(STORY_FULL + 60); // + the headings
    expect(pick.left).toBeGreaterThan(0);
    // the head does not depend on the question (it stays cached), the middle does
    expect(selectStory(story, 'something else').head).toBe(pick.head);
  });
  it('uses similarities when there are some', () => {
    const units = storyUnits(story).filter((u) => !u.head);
    const target = units.find((u) => u.text.includes('Event 5:'));
    const sim = new Map(units.map((u) => [textKey(u.text), u === target ? 0.9 : 0.1]));
    const pick = selectStory(story, 'no shared words at all', { sim, budget: 400 });
    expect(pick.middle).toContain('Event 5:');
  });
  it('without bullets the paragraphs are the units', () => {
    const paras = Array.from({ length: 12 }, (_, k) => `Paragraph ${k} ${k === 6 ? 'about the dragon egg' : 'about the long road'} ${'y'.repeat(250)}`).join('\n\n');
    expect(storyUnits(paras)).toHaveLength(12);
    const pick = selectStory(paras, 'the dragon egg');
    expect(pick.head).toContain('Paragraph 0 ');
    expect(pick.head).toContain('Paragraph 11 ');
    expect(pick.middle).toContain('dragon egg');
  });
});

describe('5. batched learning', () => {
  const chat = (n) => Array.from({ length: n * 2 }, (_, k) => (k % 2 ? { role: 'assistant', content: 'ok sure thing' } : { role: 'user', content: `I like hiking in the hills number ${k}` }));
  // what the engine does with the result: run when due, else keep the start as the chat's mark
  const simulate = (m, every) => {
    let upto = null;
    const runs = [];
    for (let i = 1; i < m.length; i += 2) {
      const b = learnBatch(m, i, upto, every);
      if (!b) continue;
      if (b.due) (runs.push(b.users), (upto = b.to));
      else if (upto == null) upto = b.from;
    }
    return runs;
  };
  it('a new chat waits for 3 of your messages, then reads them all at once', () => {
    expect(simulate(chat(7), 3)).toEqual([
      [0, 2, 4],
      [6, 8, 10],
    ]);
    expect(simulate(chat(7), 6)).toEqual([[0, 2, 4, 6, 8, 10]]);
    expect(simulate(chat(3), 1)).toEqual([[0], [2], [4]]);
  });
  it('not due yet says where the count starts', () => {
    expect(learnBatch(chat(2), 1, null, 3)).toEqual({ from: 0, to: 2, users: [0], due: false });
    expect(learnBatch(chat(3), 5, 0, 3)).toEqual({ from: 0, to: 6, users: [0, 2, 4], due: true });
  });
  it('a request to remember is learned at once, with what was pending', () => {
    const m = chat(2);
    m[2].content = 'Please remember that I am vegetarian';
    expect(learnBatch(m, 3, 0, 3)).toEqual({ from: 0, to: 4, users: [0, 2], due: true });
    m[0].content = 'remember this one';
    m[2].content = 'and something else entirely here';
    expect(learnBatch(m, 3, 0, 3).due).toBe(false); // only your latest message counts as the request
    for (const t of ['Remember my birthday is in May', 'forget what I said about cats', 'My name is Rich', 'call me Ricky']) expect(explicitLearn(t)).toBe(true);
    expect(explicitLearn('I am going to the shop')).toBe(false);
    expect(worthLearning('remember')).toBe(true);
  });
  it('never learned (an older chat) or messages deleted since: the count starts at this turn', () => {
    const m = chat(4);
    expect(learnBatch(m, 7, null, 3)).toMatchObject({ from: 6, users: [6], due: false });
    expect(learnBatch(m, 7, 99, 3)).toMatchObject({ from: 6, users: [6], due: false });
    m[6].content = 'remember I take my coffee black';
    expect(learnBatch(m, 7, null, 3)).toMatchObject({ users: [6], due: true });
  });
  it('already read: nothing to do', () => {
    expect(learnBatch(chat(3), 5, 6, 3)).toMatchObject({ users: [4], due: false }); // a mark past the reply = deleted / retried
    expect(learnBatch(chat(3), 5, 5, 3)).toBeNull();
    expect(learnBatch([{ role: 'assistant', content: 'hi' }], 0, null, 3)).toBeNull();
  });
  it('hidden messages are not read', () => {
    const m = chat(3);
    m[2].hidden = true;
    expect(learnBatch(m, 5, 0, 3).due).toBe(false);
    expect(learnBatch(m, 5, 0, 2).users).toEqual([0, 4]);
  });
});

describe('2. your past words from other chats', () => {
  it('finds your own messages only, best first, above the threshold', async () => {
    const store = mem();
    const { embed } = toy();
    const convs = [
      { id: 'a', title: 'Dog training', updatedAt: 2, messages: [{ role: 'user', content: 'My corgi Biscuit pulls hard on the lead every walk', at: 10 }, { role: 'assistant', content: 'Try a front-clip harness for your dog', at: 11 }] },
      { id: 'b', title: 'Trip', updatedAt: 1, messages: [{ role: 'user', content: 'I am flying to Kyoto next month for work', at: 20 }] },
    ];
    await indexChats(convs, { store, embed, budget: 99 });
    const hits = await pastWords(convs, 'my puppy is chewing everything', { store, embed });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'a', title: 'Dog training', i: 0, at: 10 });
    expect(await pastWords(convs, '', { store, embed })).toEqual([]);
  });
});
