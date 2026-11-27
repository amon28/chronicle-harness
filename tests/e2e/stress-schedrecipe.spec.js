import { test, expect } from './helpers.js';

const putConv = (app, conv) =>
  app.evaluate(async (conv) => {
    await new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const tx = r.result.transaction('conversations', 'readwrite'); tx.objectStore('conversations').put(conv); tx.oncomplete = res; }; });
  }, conv);
const getConv = (app, id) => app.evaluate((id) => new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const g = globalThis.__ocmChatReq(id); g.onsuccess = () => res(g.result); }; }), id);

test('a plain task that is due together with a scheduled recipe is not dropped', async ({ app }) => {
  const t = Date.now();
  await putConv(app, { id: 'rc1', title: 'Two due', createdAt: t, updatedAt: t, personaId: 'general', messages: [{ role: 'user', content: 'hi', at: t }, { role: 'assistant', content: 'hello', personaId: 'general', model: 'glm-5.3', at: t }], schedules: [{ id: 'st_rec', prompt: 'Recipe gone-recipe', next: t - 2000, recipe: { name: 'gone-recipe', args: {} }, created: t }, { id: 'st_plain', prompt: 'remind me about the dentist', next: t - 1000, created: t }] });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  // the first check runs 8 s after the start: the recipe is taken off the schedule…
  await expect.poll(async () => ((await getConv(app, 'rc1')).schedules || []).some((x) => x.id === 'st_rec'), { timeout: 15000 }).toBe(false);
  // …and the plain task was either sent to the chat or is still waiting for the next check – not gone
  const c = await getConv(app, 'rc1');
  expect(c.messages.some((m) => /remind me about the dentist/.test(m.content)) || (c.schedules || []).some((x) => x.id === 'st_plain')).toBe(true);
});
