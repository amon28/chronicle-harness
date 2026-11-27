import { test, expect } from './helpers.js';

// Decision 260: a chat's messages are a record of their own. At start only the chats' records are read; messages are
// read when a chat is opened, and the rest in the background. Saving a chat whose messages are not loaded yet keeps them.
const stored = (app) => app.evaluate(() => new Promise((res) => { const q = globalThis.__ocmChatsReq(); q.onsuccess = () => res(q.result); }));
const raw = (app) =>
  app.evaluate(
    () =>
      new Promise((res) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => {
          const g = q.result.transaction('conversations').objectStore('conversations').getAll();
          g.onsuccess = () => res(g.result.map((c) => ({ id: c.id, split: c.split, hasMessages: Array.isArray(c.messages) })));
        };
      }),
  );

test('chats saved the old way are saved apart; after a restart they open, search and pin with their messages intact', async ({ app }) => {
  await app.evaluate(() => new Promise((res) => {
    const q = indexedDB.open('chronicle');
    q.onsuccess = () => {
      const t = q.result.transaction('conversations', 'readwrite');
      const now = Date.now();
      for (let i = 0; i < 30; i++)
        t.objectStore('conversations').put({ id: 'c' + i, title: `Chat ${i}`, createdAt: now - i * 60e3, updatedAt: now - i * 60e3, messages: [{ role: 'user', content: `question ${i} about marmalade${i}`, at: now }, { role: 'assistant', content: `answer ${i}`, at: now }] });
      t.oncomplete = res;
    };
  }));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  // in the background, each one is saved again: its record without the messages, the messages apart
  await expect.poll(async () => (await raw(app)).filter((c) => c.split && !c.hasMessages).length, { timeout: 20000 }).toBe(30);
  expect((await stored(app)).find((c) => c.id === 'c7').messages).toHaveLength(2);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  // right away – before the background has read them – pin one from the list: its messages stay
  await app.click('#menu-btn');
  await expect(app.locator('#conv-list .conv-item')).toHaveCount(30);
  await app.locator('.conv-item', { hasText: 'Chat 29' }).locator('.conv-more').click();
  await app.click('#cm-pin');
  await expect.poll(async () => (await stored(app)).find((c) => c.id === 'c29')?.pinned).toBe(true);
  expect((await stored(app)).find((c) => c.id === 'c29').messages.map((m) => m.content)).toEqual(['question 29 about marmalade29', 'answer 29']);
  // search finds words in any chat
  await app.fill('#conv-search', 'marmalade17');
  await expect(app.locator('#conv-list')).toContainText('Chat 17');
  await app.fill('#conv-search', '');
  // a chat opens with its messages
  await app.locator('.conv-item', { hasText: 'Chat 12' }).first().locator('.conv-title').click();
  await expect(app.locator('.msg.user').first()).toContainText('question 12');
  await expect(app.locator('.msg.assistant').last()).toContainText('answer 12');
  // and a message sent there is saved with the rest
  await app.fill('#input', 'one more');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await expect.poll(async () => (await stored(app)).find((c) => c.id === 'c12').messages.length, { timeout: 10000 }).toBe(4);
});
