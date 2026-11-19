import { test, expect } from './helpers.js';

test('a quiet scheduled check leaves no trace when nothing is new, and speaks up when something is', async ({ app }) => {
  await app.evaluate(async () => {
    const t = Date.now();
    const conv = { id: 'sch1', title: 'Price watch', createdAt: t, updatedAt: t, personaId: 'general', messages: [{ role: 'user', content: 'watch the price', at: t }, { role: 'assistant', content: 'Will do.', personaId: 'general', model: 'glm-5.3', at: t }], schedules: [{ id: 'st_q1', prompt: 'QUIETCHECK the price of the lamp', next: t + 3600000, every: 60, quiet: true, created: t }] };
    await new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => { const tx = r.result.transaction('conversations', 'readwrite'); tx.objectStore('conversations').put(conv); tx.oncomplete = res; }; });
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('.conv-title:has-text("Price watch")');
  await expect(app.locator('#messages > .msg')).toHaveCount(2);
  // the Scheduled screen, from the chat's ⏰ chip
  await app.click('#sched-btn');
  await expect(app.locator('#sched-list .sched-row')).toContainText('QUIETCHECK the price of the lamp');
  await expect(app.locator('#sched-list .sched-row')).toContainText('every 1 h');
  await expect(app.locator('#sched-list .sched-row')).toContainText('quiet');
  // run 1: nothing new – the chat is as it was, the history says so
  await app.click('#sched-list button:has-text("Run now")');
  await expect(app.locator('#sched-list .sched-history')).toContainText('nothing new', { timeout: 15000 });
  await expect(app.locator('#messages > .msg')).toHaveCount(2);
  // run 2: news – it stays in the chat
  await app.click('#sched-list button:has-text("Run now")');
  await expect(app.locator('#sched-list .sched-history').first()).toContainText('The price dropped to 10.', { timeout: 15000 });
  await app.click('#sched-sheet [data-close]');
  await expect(app.locator('.msg.assistant').last()).toContainText('The price dropped to 10.');
  // still scheduled for the next hour
  const left = await app.evaluate(() => new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => { const g = r.result.transaction('conversations').objectStore('conversations').get('sch1'); g.onsuccess = () => res(g.result.schedules); }; }));
  expect(left).toHaveLength(1);
  expect(left[0].history.map((h) => h.result)).toEqual(['nothing new', 'The price dropped to 10.']);
});
