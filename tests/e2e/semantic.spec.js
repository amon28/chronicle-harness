import { test, expect } from './helpers.js';

const conv = (id, title, texts) => ({ id, title, createdAt: 1, updatedAt: Date.now(), personaId: 'assistant', messages: texts.map((t, i) => (i % 2 ? { role: 'assistant', content: t, personaId: 'assistant', at: 1000 + i } : { role: 'user', content: t, at: 1000 + i })) });

test.describe('search by meaning', () => {
  test.use({ appSettings: { prefs: { smartMemory: true } } });
  test('the drawer finds a chat that is about the words, not only one that says them', async ({ app }) => {
    await app.addInitScript(() => {
      // a toy embedder: synonyms share a dimension
      const TOPICS = [['castle', 'fortress', 'citadel', 'stronghold'], ['pasta', 'noodle', 'spaghetti'], ['python', 'code']];
      globalThis.__ocmEmbedder = async (texts) => texts.map((t) => TOPICS.map((ws) => (ws.some((w) => t.toLowerCase().includes(w)) ? 1 : 0)).concat([0.05]));
      globalThis.__ocmIndexEveryMs = 300;
    });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.evaluate(
      (convs) =>
        new Promise((resolve) => {
          const q = indexedDB.open('chronicle');
          q.onsuccess = () => {
            const t = q.result.transaction('conversations', 'readwrite');
            convs.forEach((c) => t.objectStore('conversations').put(c));
            t.oncomplete = resolve;
          };
        }),
      [conv('a', 'Weekend trip', ['We walked up to the old fortress on the hill', 'The walls were built in the 1200s and are still standing.']), conv('b', 'Dinner', ['What can I cook with spaghetti tonight?', 'A quick aglio e olio works well.'])],
    );
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.waitForTimeout(1500); // the index fills in the background
    await app.click('#menu-btn');
    await app.fill('#conv-search', 'that citadel');
    await expect(app.locator('.no-hits')).toBeVisible(); // no chat says "citadel"…
    await expect(app.locator('.meaning-hits .search-hit-item')).toHaveCount(1); // …but one is about it
    await expect(app.locator('.meaning-hits')).toContainText('Weekend trip');
  });
});

test.describe('roleplay recall', () => {
  test.use({ appSettings: { prefs: { smartMemory: true } } });
  test('an earlier moment that left the prompt comes back when the scene needs it', async ({ app, request }) => {
    await app.addInitScript(() => {
      const TOPICS = [['dragon', 'wyrm'], ['pasta', 'stew'], ['road', 'town']];
      globalThis.__ocmEmbedder = async (texts) => texts.map((t) => TOPICS.map((ws) => (ws.some((w) => t.toLowerCase().includes(w)) ? 1 : 0)).concat([0.05]));
    });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    const c = conv('rp1', 'The tower', ['I climb the tower stairs slowly', 'A red dragon sleeps on a pile of gold coins.', 'We cook a stew by the fire', 'The stew smells of thyme and smoke tonight.', 'We take the road to the town', 'The road is muddy and quiet now.']);
    c.personaId = 'roleplay';
    c.messages.forEach((m) => m.role === 'assistant' && (m.personaId = 'roleplay'));
    c.summary = { text: 'They climbed a tower and later camped.', upto: 4 };
    await app.evaluate(
      (cv) =>
        new Promise((resolve) => {
          const q = indexedDB.open('chronicle');
          q.onsuccess = () => {
            const t = q.result.transaction('conversations', 'readwrite');
            t.objectStore('conversations').put(cv);
            t.oncomplete = resolve;
          };
        }),
      c,
    );
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.evaluate(() => document.querySelector('.mode-tab[data-mode="rp"]')?.click());
    await app.click('#menu-btn');
    await app.click('.conv-item:has-text("The tower")');
    const sendIt = async (t) => {
      await app.fill('#input', t);
      await app.click('#send-btn');
      await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });
    };
    await sendIt('Is the dragon still up there?');
    await app.waitForTimeout(800); // recall is worked out after the reply, for the next one
    await sendIt('I go back to the dragon');
    const reqs = (await (await request.get(`${globalThis.__MOCK}/__requests`)).json()).filter((r) => r.messages);
    const sys = reqs.at(-1).messages.filter((m) => m.role === 'system').slice(1).map((m) => m.content).join('\n'); // after the history, not in the cached start
    expect(sys).toContain('Recalled from earlier in this story');
    expect(sys).toContain('red dragon sleeps');
    expect(sys).not.toContain('smells of thyme');
  });
});
