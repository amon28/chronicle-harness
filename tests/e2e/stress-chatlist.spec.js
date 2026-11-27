import { test, expect } from './helpers.js';

const idle = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
const putConv = (app, conv) =>
  app.evaluate(async (conv) => {
    await new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const tx = r.result.transaction('conversations', 'readwrite'); tx.objectStore('conversations').put(conv); tx.oncomplete = res; }; });
  }, conv);
const openChat = async (app, title, mode = '') => {
  await app.click('#menu-btn');
  if (mode) await app.click(`.mode-tab[data-mode="${mode}"]`);
  await app.click(`.conv-title:has-text("${title}")`);
};

test('deleting another chat does not make the open chat forget what was said afterwards', async ({ app }) => {
  const t = Date.now();
  const A = (c) => ({ role: 'assistant', content: c, personaId: 'general', model: 'glm-5.3', at: t });
  await putConv(app, { id: 'keep1', title: 'Keeper', createdAt: t, updatedAt: t, personaId: 'general', messages: [{ role: 'user', content: 'one', at: t }, A('reply one')] });
  await putConv(app, { id: 'other1', title: 'Bystander', createdAt: t - 5, updatedAt: t - 5, personaId: 'general', messages: [{ role: 'user', content: 'x', at: t }, A('y')] });
  await putConv(app, { id: 'del1', title: 'Throwaway', createdAt: t - 9, updatedAt: t - 9, personaId: 'general', messages: [{ role: 'user', content: 'x', at: t }, A('y')] });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await openChat(app, 'Keeper');
  await expect(app.locator('#messages > .msg')).toHaveCount(2);
  // delete another chat from the side menu
  await app.click('#menu-btn');
  app.once('dialog', (d) => d.accept());
  await app.locator('.conv-item', { hasText: 'Throwaway' }).locator('.conv-more').click();
  await app.click('#cm-delete');
  await expect(app.locator('.conv-title', { hasText: 'Throwaway' })).toHaveCount(0);
  await app.evaluate(() => document.querySelector('#scrim').click());
  // carry on in the open chat
  await app.fill('#input', 'two');
  await app.click('#send-btn');
  await expect(app.locator('.msg.assistant')).toHaveCount(2, { timeout: 15000 });
  await idle(app);
  // look at another chat and come back
  await openChat(app, 'Bystander');
  await expect(app.locator('#messages > .msg')).toHaveCount(2);
  await openChat(app, 'Keeper');
  await expect(app.locator('#messages > .msg')).toHaveCount(4);
});

test('a chat deleted while its reply is still being written stays deleted', async ({ app }) => {
  await app.fill('#input', 'LONGTHINK tell me everything');
  await app.click('#send-btn');
  await expect(app.locator('body')).toHaveClass(/streaming/);
  await app.click('#menu-btn');
  app.once('dialog', (d) => d.accept());
  await app.click('.conv-item.active .conv-more');
  await app.click('#cm-delete');
  await expect(app.locator('.conv-title', { hasText: 'LONGTHINK' })).toHaveCount(0);
  await app.waitForTimeout(8000); // the reply would have finished (and saved the chat) by now
  await expect(app.locator('.conv-title', { hasText: 'LONGTHINK' })).toHaveCount(0);
  const all = await app.evaluate(() => new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const g = globalThis.__ocmChatsReq(); g.onsuccess = () => res(g.result); }; }));
  expect(all.map((c) => c.title)).toEqual([]);
});

test('"Delete all chats" while a reply is still being written: that chat stays deleted too', async ({ app }) => {
  await app.fill('#input', 'LONGTHINK tell me everything');
  await app.click('#send-btn');
  await expect(app.locator('body')).toHaveClass(/streaming/);
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="data"]');
  app.once('dialog', (d) => d.accept());
  await app.click('#clear-all');
  await app.waitForTimeout(8000); // the reply would have finished (and saved the chat) by now
  const all = await app.evaluate(() => new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const g = globalThis.__ocmChatsReq(); g.onsuccess = () => res(g.result); }; }));
  expect(all.map((c) => c.title)).toEqual([]);
  await app.click('#menu-btn');
  await expect(app.locator('.conv-title', { hasText: 'LONGTHINK' })).toHaveCount(0);
});
