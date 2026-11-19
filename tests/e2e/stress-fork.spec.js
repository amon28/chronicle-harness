import { test, expect } from './helpers.js';

const putConv = (app, conv) =>
  app.evaluate(async (conv) => {
    await new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => { const tx = r.result.transaction('conversations', 'readwrite'); tx.objectStore('conversations').put(conv); tx.oncomplete = res; }; });
  }, conv);

test('a fork does not take the scheduled tasks (or the per-chat tool OKs) with it', async ({ app }) => {
  const t = Date.now();
  await putConv(app, { id: 'fk1', title: 'Watcher', createdAt: t, updatedAt: t, personaId: 'general', allowedTools: ['shell'], resumeAt: t + 3600000, messages: [{ role: 'user', content: 'watch it', at: t }, { role: 'assistant', content: 'ok', personaId: 'general', model: 'glm-5.3', at: t }], schedules: [{ id: 'st_f1', prompt: 'check the thing', next: t + 3600000, every: 60, created: t }], schedDone: [{ id: 'st_old', prompt: 'old', at: t, result: 'sent to the chat' }] });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.locator('.conv-item', { hasText: 'Watcher' }).locator('.conv-more').click();
  await app.click('#cm-fork');
  await expect(app.locator('#toast')).toContainText('Forked');
  const all = await app.evaluate(() => new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => { const g = r.result.transaction('conversations').objectStore('conversations').getAll(); g.onsuccess = () => res(g.result); }; }));
  const fork = all.find((c) => c.forkOf);
  const orig = all.find((c) => c.id === 'fk1');
  expect(orig.schedules).toHaveLength(1);
  expect(fork.schedules || []).toEqual([]);
  expect(fork.schedDone || []).toEqual([]);
  expect(fork.allowedTools || []).toEqual([]);
  expect(fork.resumeAt).toBeUndefined();
});
