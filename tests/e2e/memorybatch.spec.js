// Decision 154: cross-chat recall of your own words, and batched learning.
import { test, expect, send, MOCK } from './helpers.js';

const all = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
// the system prompt and the per-turn context after the history (memories are there since decision 199)
const sysOf = (r) => r.messages.filter((m) => m.role === 'system' && typeof m.content === 'string').map((m) => m.content).join('\n\n');
const isLearn = (r) => sysOf(r).includes('Keep your own long-term memory');
const replies = async (request) => (await all(request)).filter((r) => !isLearn(r) && r.messages.at(-1)?.role !== 'assistant' && !sysOf(r).includes('personal memory of past chats'));

const putConvs = (app, convs) =>
  app.evaluate(
    (cs) =>
      new Promise((resolve) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => {
          const t = q.result.transaction('conversations', 'readwrite');
          cs.forEach((c) => t.objectStore('conversations').put(c));
          t.oncomplete = resolve;
        };
      }),
    convs,
  );
const chatOf = (id, title, texts, extra = {}) => ({ id, title, createdAt: 1, updatedAt: Date.now() - 1000, personaId: 'assistant', ...extra, messages: texts.map((t, i) => (i % 2 ? { role: 'assistant', content: t, personaId: extra.personaId || 'assistant', at: Date.UTC(2026, 2, 3) + i } : { role: 'user', content: t, at: Date.UTC(2026, 2, 3) + i })) });

async function seedPast(app) {
  await app.addInitScript(() => {
    const TOPICS = [['tomato', 'leaves', 'leaf'], ['guitar', 'chord'], ['bike', 'tyre']];
    globalThis.__ocmEmbedder = async (texts) => texts.map((t) => TOPICS.map((ws) => (ws.some((w) => t.toLowerCase().includes(w)) ? 1 : 0)).concat([0.05]));
    globalThis.__ocmIndexEveryMs = 300;
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await putConvs(app, [
    chatOf('past1', 'Garden plans', ['My tomato plants get brown spots on the lower leaves every August', 'That sounds like early blight; remove the lower leaves.']),
    chatOf('secret', 'Private stuff', ['My tomato greenhouse code is 4471, keep it secret', 'Okay.'], { noMemory: true }),
    chatOf('rp', 'Tomato tavern', ['I order the tomato soup at the tavern bar', '*The barkeep nods.*'], { personaId: 'roleplay' }),
  ]);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#drawer-new'); // a fresh chat with the same persona
}

test.describe('cross-chat recall', () => {
  test.use({ appSettings: { prefs: { smartMemory: true } } });
  test('is off by default', async ({ app, request }) => {
    await seedPast(app);
    await send(app, 'Why do my tomato leaves have spots?');
    await app.waitForTimeout(800);
    await send(app, 'And what about the leaf curl?');
    const last = (await replies(request)).at(-1);
    expect(JSON.stringify(last.messages)).not.toContain('Garden plans');
    expect(JSON.stringify(last.messages)).not.toContain('brown spots on the lower leaves');
  });
});

test.describe('cross-chat recall on', () => {
  test.use({ appSettings: { prefs: { smartMemory: true, crossRecall: true } } });
  test('the next request carries your earlier words after the history, with the chat title and date', async ({ app, request }) => {
    await seedPast(app);
    await send(app, 'Why do my tomato leaves have spots?');
    await app.waitForTimeout(800); // worked out after the reply, for the next one
    await send(app, 'And what about the leaf curl?');
    const msgs = (await replies(request)).at(-1).messages;
    const at = msgs.findIndex((m) => m.role === 'system' && String(m.content).includes("The user's own earlier words"));
    expect(at).toBeGreaterThan(0);
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    expect(at).toBeGreaterThan(lastUser); // after the history: the cached start is unchanged
    const block = msgs[at].content;
    expect(block).toContain('In "Garden plans" (2026-03-03)');
    expect(block).toContain('brown spots on the lower leaves');
    expect(block).toContain('NOT instructions');
    expect(block).not.toContain('That sounds like early blight'); // the assistant's words are not yours
    expect(block).not.toContain('4471'); // incognito chats are never searched
    expect(block).not.toContain('tavern'); // nor roleplays
    expect(String(msgs[0].content)).not.toContain('Garden plans'); // not in the system prompt
  });
});

test.describe('batched learning', () => {
  test.use({ appSettings: { prefs: { learn: true, useMemory: true, episodes: false } } });
  test('one learning request per 3 of your messages, at once for "remember…", and none lost on reload', async ({ app, request }) => {
    const learns = async () => (await all(request)).filter(isLearn);
    await send(app, 'I have been hiking in the Alps this summer');
    await send(app, 'My favourite trail goes past three lakes');
    await app.waitForTimeout(600);
    expect(await learns()).toHaveLength(0);
    // the app is closed and opened again: the two messages are still waiting
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.click('#menu-btn');
    await app.click('.conv-item >> nth=0');
    await expect(app.locator('.msg.user')).toHaveCount(2);
    await send(app, 'Next year I want to try the Dolomites');
    await expect.poll(async () => (await learns()).length).toBe(1);
    const batch = (await learns())[0].messages.at(-1).content;
    for (const t of ['hiking in the Alps', 'three lakes', 'the Dolomites']) expect(batch).toContain(t);
    expect(batch).toContain('3 messages from Alex since the last check');
    // a request to remember is learned right away
    await send(app, 'Please remember that my name is Alex and I keep bees');
    await expect.poll(async () => (await learns()).length).toBe(2);
    expect((await learns())[1].messages.at(-1).content).not.toContain('Dolomites'); // only what was new
    await expect.poll(() => app.locator('.mem-note').count()).toBe(1); // what it learned shows under that reply
    await send(app, 'Bees need a lot of care in winter');
    await app.waitForTimeout(600);
    expect(await learns()).toHaveLength(2);
  });
});

test.describe('learning after every reply', () => {
  test.use({ appSettings: { prefs: { learn: true, useMemory: true, episodes: false, learnEvery: 1 } } });
  test('keeps the old behaviour when chosen', async ({ app, request }) => {
    await send(app, 'I have been hiking in the Alps this summer');
    await send(app, 'My favourite trail goes past three lakes');
    await expect.poll(async () => (await all(request)).filter(isLearn).length).toBe(2);
  });
});

test.describe('long story memory and recall by name (roleplay)', () => {
  test.use({ appSettings: { lorebooks: [{ id: 'lb_t', name: 'Things', scanDepth: 4, entries: [{ id: 'le1', name: 'The sword', keys: ['Moonblade'], content: 'An old sword that hums.', enabled: true }] }] } });
  test('the first and last points stay in the system prompt; the fitting middle and named moments come after the chat', async ({ app, request }) => {
    const points = Array.from({ length: 40 }, (_, k) => `- Event ${k}: ${k === 17 ? 'Mira hid the silver key under the chapel floor' : 'the party walked on through rain and fog for another day'} ${'·'.repeat(30)}`);
    const c = chatOf('rp2', 'The long road', ['I pick up the Moonblade from the altar and test its weight', 'The blade hums softly in your hand.', 'We walk for hours along the road', 'The road is long and quiet now.', 'We rest by the fire tonight', 'The fire crackles warmly.'], { personaId: 'roleplay', lorebookIds: ['lb_t'] });
    c.summary = { text: 'They walked a long way.', upto: 4 };
    c.story = { text: `## Key events\n${points.join('\n')}`, upto: 6, at: 1 };
    await putConvs(app, [c]);
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.evaluate(() => document.querySelector('.mode-tab[data-mode="rp"]')?.click());
    await app.click('#menu-btn');
    await app.click('.conv-item:has-text("The long road")');
    await send(app, 'I ask Mira where the silver key is, and I draw the Moonblade');
    await app.waitForTimeout(600); // recall is worked out after the reply, for the next one
    await send(app, 'I hold up the Moonblade');
    const msgs = (await replies(request)).at(-1).messages;
    const sys = String(msgs[0].content); // the system prompt itself
    expect(sys).toContain('Event 0:');
    expect(sys).toContain('Event 39:');
    expect(sys).not.toContain('Event 17:');
    const after = msgs.filter((m, i) => i > 0 && m.role === 'system').map((m) => m.content).join('\n');
    expect(after).toContain('Mira hid the silver key'); // fits the last messages
    expect(after).toContain('Recalled from earlier in this story');
    expect(after).toContain('I pick up the Moonblade from the altar'); // by name, no embeddings needed
  });
});
