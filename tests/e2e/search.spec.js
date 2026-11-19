import { test, expect } from './helpers.js';

async function seed(page, convs) {
  await page.evaluate(
    (convs) =>
      new Promise((resolve) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => {
          const t = q.result.transaction('conversations', 'readwrite');
          convs.forEach((c) => t.objectStore('conversations').put(c));
          t.oncomplete = resolve;
        };
      }),
    convs,
  );
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
}
const conv = (id, title, texts, extra = {}) => ({
  id,
  title,
  createdAt: 1,
  updatedAt: Date.now(),
  personaId: 'assistant',
  messages: texts.map((t, i) => (i % 2 ? { role: 'assistant', content: t, personaId: 'assistant' } : { role: 'user', content: t })),
  ...extra,
});

test('search across chats, pin a chat, and find inside it', async ({ app }) => {
  await seed(app, [conv('a', 'Trip planning', ['Plan Kyoto in spring', 'Cherry blossoms peak in April.']), conv('b', 'Recipes', ['tofu?', 'Mapo tofu is great.'])]);
  await app.click('#menu-btn');
  await app.fill('#conv-search', 'kyoto');
  await expect(app.locator('.search-hit-item')).toHaveCount(1);
  await expect(app.locator('.search-snip mark')).toHaveText('Kyoto');
  await app.click('.search-hit-item');
  await expect(app.locator('#find-bar')).toBeVisible();
  await expect(app.locator('#find-count')).toHaveText('1/1');

  await app.click('#find-close');
  await app.click('#menu-btn');
  await app.fill('#conv-search', '');
  await app.click('.conv-item:has-text("Recipes") .conv-more');
  await app.click('#cm-pin');
  await expect(app.locator('#conv-list > *').nth(1)).toContainText('Recipes');
});

test('long chats render lazily and load older messages on scroll', async ({ app }) => {
  const texts = Array.from({ length: 120 }, (_, i) => `message ${i} ` + 'lorem ipsum '.repeat(10));
  await seed(app, [conv('long', 'Long chat', texts)]);
  await app.click('#menu-btn');
  await app.click('.conv-title:has-text("Long chat")');
  await expect(app.locator('#messages > .msg')).toHaveCount(24);
  await app.evaluate(() => (document.getElementById('messages').scrollTop = 0));
  await expect.poll(() => app.locator('#messages > .msg').count()).toBeGreaterThan(24);
});
