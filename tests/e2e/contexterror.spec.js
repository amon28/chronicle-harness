import { test, expect, send, MOCK } from './helpers.js';

const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);

test('a request refused as too long is rebuilt to fit and sent again, and the limit is remembered', async ({ app, request }) => {
  // a long chat: 30 messages of ~2000 characters (about 15K tokens) on a model that takes 5K
  await app.evaluate(async () => {
    const t = Date.now();
    const messages = [];
    for (let i = 0; i < 30; i++) messages.push(i % 2 ? { role: 'assistant', content: `Answer ${i}. ` + 'words '.repeat(330), personaId: 'general', model: 'glm-5.3', at: t } : { role: 'user', content: `Question ${i}. ` + 'words '.repeat(330), at: t });
    const conv = { id: 'long1', title: 'Long chat', createdAt: t, updatedAt: t, personaId: 'general', messages };
    await new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const tx = r.result.transaction('conversations', 'readwrite'); tx.objectStore('conversations').put(conv); tx.oncomplete = res; }; });
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('.conv-title:has-text("Long chat")');
  await send(app, 'TOOLONG what now?');
  await expect(app.locator('.msg.assistant').last()).toContainText('It fits now');
  await expect(app.locator('.msg.assistant').last().locator('.msg-error')).toHaveCount(0);
  const reqs = (await requests(request)).filter((r) => JSON.stringify(r.messages).includes('TOOLONG'));
  expect(reqs.length).toBe(2); // refused once, then the rebuilt one
  expect(JSON.stringify(reqs[1].messages).length).toBeLessThan(20000);
  expect(JSON.stringify(reqs[1].messages)).toContain('TOOLONG what now?'); // the new question is always kept
  // the next message goes out already fitting: no refusal first
  await send(app, 'TOOLONG and again?');
  await expect(app.locator('.msg.assistant').last()).toContainText('It fits now');
  const again = (await requests(request)).filter((r) => JSON.stringify(r.messages).includes('and again?'));
  expect(again.length).toBe(1);
});
