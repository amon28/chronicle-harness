import { test, expect, send } from './helpers.js';
import { fileURLToPath } from 'node:url';

const card = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url));

test('suggest lore entries from the chat, keep some, and they join the character’s lorebook', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await send(app, 'I woke up in a glade under an old oak.');
  await app.click('#persona-name-btn');
  await app.click('#lore-suggest');
  await expect(app.locator('#loresug-list .review-item')).toHaveCount(2);
  await app.locator('#loresug-list .review-item', { hasText: 'Old Oak' }).locator('input').uncheck();
  await app.click('#loresug-add');
  const books = await app.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('chronicle');
      r.onsuccess = () => res(r.result);
    });
    return new Promise((res) => {
      const q = db.transaction('kv').objectStore('kv').getAll();
      q.onsuccess = () => res(JSON.stringify(q.result));
    });
  });
  expect(books).toContain('A moonlit clearing where Rich woke up.');
  expect(books).not.toContain('A huge oak at the centre');
});
