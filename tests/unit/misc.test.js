import { describe, it, expect } from 'vitest';
import { mergeSameRole, mentionedMembers } from '../../src/group.js';
import { matchCommand, applySnippet } from '../../src/snippets.js';
import { applyMemoryChanges, worthLearning, visibleMemories, GLOBAL } from '../../src/memory.js';

describe('group chats', () => {
  it('merges consecutive plain messages of the same role', () => {
    const out = mergeSameRole([
      { role: 'system', content: 's' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ]);
    expect(out.map((m) => m.content)).toEqual(['s', 'a\n\nb', 'c']);
  });
  it('finds members mentioned by name', () => {
    const members = [{ id: '1', name: 'Coder' }, { id: '2', name: 'Tutor' }];
    expect(mentionedMembers('hey @tutor, help', members).map((m) => m.id)).toEqual(['2']);
  });
});

describe('snippets', () => {
  const snippets = [{ cmd: 'fix', text: 'Fix this code:\n{{text}}' }, { cmd: 'tldr', text: 'Summarize briefly.' }];
  it('matches /commands with arguments', () => {
    expect(matchCommand('/fix let x', snippets)).toEqual({ snippet: snippets[0], rest: 'let x' });
    expect(matchCommand('/nope', snippets)).toBeNull();
    expect(matchCommand('no slash', snippets)).toBeNull();
  });
  it('fills {{text}} or appends the rest', () => {
    expect(applySnippet(snippets[0], ' a+b ')).toBe('Fix this code:\na+b');
    expect(applySnippet(snippets[1], 'article…')).toBe('Summarize briefly.\n\narticle…');
  });
});

describe('memories', () => {
  it('adds, dedupes, updates and removes', () => {
    const mem = [];
    applyMemoryChanges(mem, { add: ['Likes tea', 'likes TEA!'], update: [], remove: [] }, 'learned');
    expect(mem).toHaveLength(1);
    const id = mem[0].id;
    applyMemoryChanges(mem, { add: [], update: [{ id, text: 'Likes green tea' }], remove: [] }, 'learned');
    expect(mem[0].text).toBe('Likes green tea');
    applyMemoryChanges(mem, { add: [], update: [], remove: [id] }, 'learned');
    expect(mem).toHaveLength(0);
  });
  it('keeps persona memories separate from global ones', () => {
    const mem = [];
    applyMemoryChanges(mem, { add: ['Global fact'], update: [], remove: [] }, 'manual', GLOBAL);
    applyMemoryChanges(mem, { add: ['Coder fact'], update: [], remove: [] }, 'learned', 'coder');
    expect(visibleMemories(mem, 'coder').map((m) => m.text).sort()).toEqual(['Coder fact', 'Global fact']);
    expect(visibleMemories(mem, 'tutor').map((m) => m.text)).toEqual(['Global fact']);
  });
  it('skips throwaway messages', () => {
    expect(worthLearning('thanks!')).toBe(false);
    expect(worthLearning('my name is Ana')).toBe(true);
    expect(worthLearning('I prefer TypeScript over JavaScript for big projects')).toBe(true);
  });
});

import { applyEpisode, memoryBlock, isEvent } from '../../src/memory.js';

describe('persona episode notes', () => {
  it('keeps one note per persona and chat, and shows only other chats', () => {
    const mem = [];
    applyEpisode(mem, { personaId: 'vesper', convId: 'c1', title: 'Cathedral', notes: ['I met Rich.'] });
    applyEpisode(mem, { personaId: 'vesper', convId: 'c1', title: 'Cathedral', notes: ['I met Rich.', 'He promised to return.'] });
    applyEpisode(mem, { personaId: 'vesper', convId: 'c2', title: 'Garden', notes: ['We walked in the garden.'] });
    expect(mem.filter(isEvent)).toHaveLength(2);
    const inC2 = memoryBlock(mem, 'vesper', 'c2');
    expect(inC2).toContain('He promised to return.');
    expect(inC2).not.toContain('garden'); // this chat's own history is already in the prompt
    expect(memoryBlock(mem, 'coder', 'c9')).toBe(''); // other personas don't get them
  });
  it("does not treat notes as facts about the user", () => {
    const mem = [];
    applyEpisode(mem, { personaId: 'a', convId: 'c', title: 't', notes: ['x'] });
    expect(visibleMemories(mem, 'a')).toEqual([]);
  });
});

describe('roleplay memory belongs to one chat; assistant memory persists', () => {
  const mem = () => [
    { id: 'g', text: 'Rich likes tea', scope: 'global' },
    { id: 'a', text: 'I know Rich likes short answers', scope: 'ash' }, // persona-wide (assistant)
    { id: 'r1', text: 'I learned his name is Rich', scope: 'ash', conv: 'chat1' }, // roleplay chat 1
    { id: 'r2', text: 'Rich is a knight here', scope: 'ash', conv: 'chat2' },
  ];
  it('roleplay: only global + this chat', () => {
    expect(visibleMemories(mem(), 'ash', 'chat1', true).map((m) => m.id)).toEqual(['g', 'r1']);
    expect(visibleMemories(mem(), 'ash', 'chat3', true).map((m) => m.id)).toEqual(['g']); // a new roleplay starts fresh
  });
  it('assistant chats: global + persona-wide, never another roleplay\'s memory', () => {
    expect(visibleMemories(mem(), 'ash', 'chatX', false).map((m) => m.id)).toEqual(['g', 'a']);
  });
  it('new roleplay memories carry the chat id and are not deduped against other chats', () => {
    const m = [{ id: 'x', text: 'I learned his name is Rich', scope: 'ash', conv: 'chat1' }];
    applyMemoryChanges(m, { add: ['I learned his name is Rich'], update: [], remove: [] }, 'chat2', 'ash', null, { conv: 'chat2' });
    expect(m).toHaveLength(2);
    expect(m[1].conv).toBe('chat2');
  });
  it('episode notes from a roleplay never reach other chats, and only show in their own once trimmed', () => {
    const m = [];
    applyEpisode(m, { personaId: 'ash', convId: 'chat1', title: 'RP 1', notes: ['We met at the gate.'], rp: true });
    applyEpisode(m, { personaId: 'ash', convId: 'chat9', title: 'Chat', notes: ['We talked tea.'], rp: false });
    expect(memoryBlock(m, 'ash', 'chat2', { rp: true, trimmed: true })).toBe(''); // another roleplay
    expect(memoryBlock(m, 'ash', 'chat1', { rp: true, trimmed: false })).toBe(''); // history still in the prompt
    expect(memoryBlock(m, 'ash', 'chat1', { rp: true, trimmed: true })).toContain('We met at the gate.');
    const assistant = memoryBlock(m, 'ash', 'chat5', { rp: false });
    expect(assistant).toContain('We talked tea.');
    expect(assistant).not.toContain('We met at the gate.');
  });
});

import { clip } from '../../src/memory.js';

describe('memories stay short', () => {
  it('clip cuts at a word boundary and adds an ellipsis', () => {
    const t = 'Amon shoved his bare hand down into that barrel, into the warm filth right where the thing coiled between Marta\'s legs and now he means to take the machete';
    const c = clip(t, 60);
    expect(c.length).toBeLessThanOrEqual(61);
    expect(c.endsWith('…')).toBe(true);
    expect(c).not.toMatch(/\s…$/);
    expect(clip('short', 60)).toBe('short');
  });
  it('learned memories and episode notes are capped', () => {
    const long = 'word '.repeat(200);
    const mem = [];
    applyMemoryChanges(mem, { add: [long], update: [], remove: [] }, 'c', 'p');
    expect(mem[0].text.length).toBeLessThanOrEqual(161);
    const ev = [];
    applyEpisode(ev, { personaId: 'p', convId: 'c', title: 't', notes: Array.from({ length: 9 }, () => long) });
    expect(ev[0].text.split('\n').length).toBeLessThanOrEqual(5);
    expect(ev[0].text.length).toBeLessThanOrEqual(650);
  });
});

import { snapshotMemories, diffMemories, revertMemoryLog, applyMemoryLog } from '../../src/memory.js';

describe('undoing what a reply taught', () => {
  it('logs adds, updates and removals, then reverts and re-applies them', () => {
    const mem = [{ id: 'a', text: 'likes tea', scope: 'p' }, { id: 'b', text: 'old fact', scope: 'p' }];
    const snap = snapshotMemories(mem);
    mem.push({ id: 'c', text: 'new fact', scope: 'p' });
    mem[0].text = 'likes green tea';
    mem.splice(1, 1);
    const log = diffMemories(snap, mem);
    expect(log.added.map((m) => m.id)).toEqual(['c']);
    expect(log.updated).toEqual([{ id: 'a', before: 'likes tea', after: 'likes green tea' }]);
    expect(log.removed.map((m) => m.id)).toEqual(['b']);

    expect(revertMemoryLog(mem, log)).toBe(true);
    expect(mem.map((m) => `${m.id}:${m.text}`).sort()).toEqual(['a:likes tea', 'b:old fact']);
    expect(applyMemoryLog(mem, log)).toBe(true);
    expect(mem.map((m) => `${m.id}:${m.text}`).sort()).toEqual(['a:likes green tea', 'c:new fact']);
  });
  it('leaves entries you edited by hand alone, and logs nothing when nothing changed', () => {
    const mem = [{ id: 'c', text: 'new fact', scope: 'p' }];
    const log = { added: [{ id: 'c', text: 'new fact', scope: 'p' }], updated: [], removed: [] };
    mem[0].text = 'my own wording';
    expect(revertMemoryLog(mem, log)).toBe(false);
    expect(mem).toHaveLength(1);
    expect(diffMemories(snapshotMemories(mem), mem)).toBeNull();
  });
});

import { selectMemories, tokenize } from '../../src/memory.js';
describe('memory relevance', () => {
  const mk = (text, extra = {}) => ({ id: text, text, scope: 'p1', source: 'learned', createdAt: 1, updatedAt: 1, ...extra });
  const facts = [mk('Owns a corgi named Biscuit'), mk('Works as a nurse at night'), mk('Prefers short answers'), mk('Is learning Japanese'), mk('Lives in Cebu'), mk('Allergic to peanuts'), mk('Plays the guitar on weekends'), mk('Drives a red motorbike')];
  it('sends everything when the list is short', () => {
    expect(selectMemories(facts, 'anything', 20)).toHaveLength(8);
    expect(selectMemories(facts, 'anything', 0)).toHaveLength(8);
  });
  it('picks the facts that match the conversation', () => {
    const got = selectMemories(facts, 'my corgi is limping, should I walk Biscuit?', 2).map((m) => m.text);
    expect(got).toContain('Owns a corgi named Biscuit');
    expect(got).toHaveLength(2);
  });
  it('always includes pinned facts and keeps the original order', () => {
    const f = facts.map((m) => (m.text.startsWith('Allergic') ? { ...m, pinned: true } : m));
    const got = selectMemories(f, 'corgi Biscuit', 2).map((m) => m.text);
    expect(got).toEqual(['Owns a corgi named Biscuit', 'Allergic to peanuts']);
  });
  it('tokenizes loosely', () => {
    expect(tokenize('Walking the dogs')).toEqual(expect.arrayContaining(['walk', 'dog']));
  });
  it('memoryBlock only lists the selected facts', () => {
    const block = memoryBlock(facts, 'p1', null, { limit: 2, query: 'peanuts allergy' });
    expect(block).toContain('Allergic to peanuts');
    expect(block).not.toContain('motorbike');
  });
});

import { encodeVec, decodeVec, cosine, similarities, ensureVectors } from '../../src/embed.js';
describe('smart memory vectors', () => {
  it('round-trips a vector through the compact encoding', () => {
    const v = Array.from({ length: 256 }, (_, i) => Math.sin(i));
    const back = decodeVec(encodeVec(v));
    const n = Math.hypot(...v);
    expect(cosine(back, v.map((x) => x / n))).toBeGreaterThan(0.999);
  });
  it('ranks by meaning when similarities are supplied', async () => {
    const topic = (t) => (/corgi|dog|puppy/i.test(t) ? [1, 0, 0] : /nurse|job|work/i.test(t) ? [0, 1, 0] : [0, 0, 1]);
    const embed = async (texts) => texts.map(topic);
    const facts = ['Owns a corgi named Biscuit', 'Works as a nurse', 'Likes tea', 'Lives in Cebu', 'Plays guitar'].map((text, i) => ({ id: 'f' + i, text, scope: 'p', createdAt: i, updatedAt: i }));
    await ensureVectors(facts, embed);
    expect(facts.every((f) => f.vec)).toBe(true);
    const sim = await similarities(facts, 'my puppy is sick', embed);
    const got = selectMemories(facts, 'my puppy is sick', 1, sim).map((m) => m.text);
    expect(got).toEqual(['Owns a corgi named Biscuit']); // no shared words, found by meaning
  });
});

import { cleanTidyPlan, applyTidy, undoTidy } from '../../src/memory.js';
describe('tidy memories', () => {
  const mem = () => ['a', 'b', 'c', 'd'].map((id, i) => ({ id, text: 'fact ' + id, scope: 'global', createdAt: i, updatedAt: i, vec: 'xx' }));
  it('ignores unknown ids, reused ids and one-item merges', () => {
    const plan = cleanTidyPlan({ merge: [{ ids: ['a', 'b'], text: 'ab' }, { ids: ['b', 'c'], text: 'bc' }, { ids: ['zzz', 'a'], text: 'x' }, { ids: ['c'], text: 'solo' }], remove: [{ id: 'a' }, { id: 'd', why: 'old' }, { id: 'nope' }] }, ['a', 'b', 'c', 'd']);
    expect(plan.merge).toEqual([{ ids: ['a', 'b'], text: 'ab' }]);
    expect(plan.remove).toEqual([{ id: 'd', why: 'old' }]);
  });
  it('merges into the first memory, removes the rest, and undoes exactly', () => {
    const before = mem();
    const { memories, undo } = applyTidy(before, { merge: [{ ids: ['a', 'b'], text: 'a and b' }], remove: [{ id: 'd' }] });
    expect(memories.map((m) => [m.id, m.text])).toEqual([['a', 'a and b'], ['c', 'fact c']]);
    expect(memories[0].vec).toBeUndefined(); // its meaning changed, so it is re-embedded later
    const restored = undoTidy(memories, undo);
    expect(restored.map((m) => m.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(restored.find((m) => m.id === 'a').text).toBe('fact a');
    expect(restored.find((m) => m.id === 'a').vec).toBe('xx');
  });
});

import { dropReferenceLeaks, pickEpisodeBullets } from '../../src/memory.js';
describe('memory hygiene', () => {
  const skill = 'Folder: C:\\Users\\amon2\\Documents\\Character Cards. The user imports cards into Chub and SillyTavern. Builder: Build cards.bat';
  it('drops memories that only come from a skill the assistant read', () => {
    const out = dropReferenceLeaks({ add: ['I learned Rich keeps cards in C:\\Users\\amon2\\Documents\\Character Cards.', 'Rich likes strong coffee.'], update: [], remove: [] }, 'make me a card for Vega', [skill]);
    expect(out.add).toEqual(['Rich likes strong coffee.']);
  });
  it('keeps what the user said themselves, even if the skill mentions it too', () => {
    const out = dropReferenceLeaks({ add: ['Rich imports cards into SillyTavern.'], update: [] }, 'I import my cards into SillyTavern every week', [skill]);
    expect(out.add).toHaveLength(1);
  });
  it('does nothing without reference material', () => {
    const c = { add: ['x y z'], update: [] };
    expect(dropReferenceLeaks(c, 'hi', [])).toBe(c);
  });
  it('sends only the relevant bullets of past-chat notes, grouped by chat', () => {
    const eps = [
      { id: 'e1', title: 'Cooking', text: '- Rich loves spicy ramen\n- I promised a pasta recipe\n- Rich owns a cast iron pan', updatedAt: 3 },
      { id: 'e2', title: 'Travel', text: '- Rich wants to visit Kyoto\n- Flight to Cebu in June', updatedAt: 2 },
    ];
    const out = pickEpisodeBullets(eps, 'tell me a pasta recipe', 2);
    const all = out.flatMap((g) => g.bullets);
    expect(all).toHaveLength(2);
    expect(all).toContain('I promised a pasta recipe');
    expect(out.every((g) => g.title)).toBe(true);
  });
});
