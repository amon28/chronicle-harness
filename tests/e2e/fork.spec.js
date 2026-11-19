import { test, expect, send } from './helpers.js';

test('fork a chat: full copy with a link back and a link forward, original untouched', async ({ app }) => {
  await send(app, 'first question');
  await send(app, 'second question');
  const originalCount = await app.locator('#messages > .msg').count();
  await app.click('#menu-btn');
  await app.click('.conv-item.active .conv-more');
  await app.click('#cm-fork');
  await expect(app.locator('#messages > .msg')).toHaveCount(originalCount);
  await app.click('#menu-btn');
  await expect(app.locator('#conv-list .conv-item')).toHaveCount(2);
  await expect(app.locator('#conv-list .conv-item.active .fork-mark')).toBeVisible();
  await expect(app.locator('#conv-list .conv-item.active')).toContainText('(fork)');
  await app.evaluate(() => document.getElementById('scrim').click());
  // the This chat page links back to the original, and the original lists its fork
  await app.click('#persona-name-btn');
  await expect(app.locator('#chat-fork-box')).toContainText('Forked from');
  await app.click('#chat-fork-box button:has-text("Open the original")');
  await expect(app.locator('.msg.user').first()).toContainText('first question');
  await app.click('#persona-name-btn');
  await expect(app.locator('#chat-fork-box')).toContainText('1 fork of this chat');
});

test('forking copies the chat’s workspace files', async ({ app }) => {
  await send(app, 'hello');
  await app.evaluate(async () => {
    // put a file in this chat's workspace the same way the app stores them
    const open = () => new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => res(r.result); });
    const db = await open();
    const convs = await new Promise((res) => { const q = db.transaction('conversations').objectStore('conversations').getAll(); q.onsuccess = () => res(q.result); });
    await new Promise((res) => { const t = db.transaction('workspaces', 'readwrite'); t.objectStore('workspaces').put({ id: convs[0].id, files: { 'notes.txt': { data: new TextEncoder().encode('keep me'), mtime: Date.now() } } }); t.oncomplete = res; });
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('.conv-item >> nth=0 >> .conv-more');
  await app.click('#cm-fork');
  await expect.poll(() => app.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => res(r.result); });
    const all = await new Promise((res) => { const q = db.transaction('workspaces').objectStore('workspaces').getAll(); q.onsuccess = () => res(q.result); });
    return all.length;
  })).toBe(2);
});
