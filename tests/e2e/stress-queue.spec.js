import { test, expect } from './helpers.js';

const idle = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
const putConv = (app, conv) =>
  app.evaluate(async (conv) => {
    await new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const tx = r.result.transaction('conversations', 'readwrite'); tx.objectStore('conversations').put(conv); tx.oncomplete = res; }; });
  }, conv);
const getConv = (app, id) => app.evaluate((id) => new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const g = globalThis.__ocmChatReq(id); g.onsuccess = () => res(g.result); }; }), id);
const openChat = async (app, title, mode = '') => {
  await app.click('#menu-btn');
  if (mode) await app.click(`.mode-tab[data-mode="${mode}"]`);
  await app.click(`.conv-title:has-text("${title}")`);
};

test('a scheduled task that comes due while you are editing an earlier message does not replace that message', async ({ app }) => {
  const t = Date.now();
  const A = (c) => ({ role: 'assistant', content: c, personaId: 'general', model: 'glm-5.3', at: t });
  await putConv(app, { id: 'ed1', title: 'Edit me', createdAt: t, updatedAt: t, personaId: 'general', messages: [{ role: 'user', content: 'first question', at: t }, A('first answer'), { role: 'user', content: 'second question', at: t }, A('second answer')], schedules: [{ id: 'st_e1', prompt: 'say hello again', next: t - 1000, created: t }] });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await openChat(app, 'Edit me');
  await expect(app.locator('#messages > .msg')).toHaveCount(4);
  await app.locator('.msg.user').first().locator('button[aria-label="Edit"]').click();
  await expect(app.locator('#edit-bar')).toBeVisible();
  await app.fill('#input', 'first question, reworded');
  // the task comes due (the first check runs 8 s after the app started)
  await expect(app.locator('.msg.user', { hasText: 'Scheduled task' })).toHaveCount(1, { timeout: 20000 });
  await idle(app);
  const saved = await getConv(app, 'ed1');
  expect(saved.messages.map((m) => m.content.slice(0, 15))).toEqual(['first question', 'first answer', 'second question', 'second answer', '⏰ Scheduled tas', expect.any(String)]);
  // and the edit is still there to send
  await expect(app.locator('#edit-bar')).toBeVisible();
  await expect(app.locator('#input')).toHaveValue('first question, reworded');
});

test.describe('queue', () => {
  test.use({ appSettings: { model: 'kimi-k3' } });
  test('a queued message that could not be sent stays in the queue', async ({ app }) => {
    await app.fill('#input', 'LONGTHINK first');
    await app.click('#send-btn');
    await expect(app.locator('body')).toHaveClass(/streaming/);
    // queue a message with a picture, then switch to a model that cannot see pictures
    await app.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      return globalThis.__ocmCommit('image/png', c.toDataURL('image/png').split(',')[1]);
    });
    await expect(app.locator('#attachments img, #attachments .thumb, .attach-thumb').first()).toBeVisible();
    await app.fill('#input', 'what is in this picture');
    await app.click('#send-btn');
    await expect(app.locator('#queue-bar .queue-item')).toHaveCount(1);
    await app.click('#model-btn');
    await app.locator('#model-list .model-item', { hasText: 'GLM-5.3' }).first().click();
    await idle(app);
    await app.waitForTimeout(1500);
    await expect(app.locator('.msg.user')).toHaveCount(1); // it could not go out…
    await expect(app.locator('#queue-bar .queue-item')).toHaveCount(1); // …so it is still waiting
    await expect(app.locator('#queue-bar')).toContainText('what is in this picture');
  });
});

test('a message queued in a chat you left waits after its reply failed, as it does on screen', async ({ app, request }) => {
  const t = Date.now();
  await putConv(app, { id: 'by1', title: 'Bystander', createdAt: t, updatedAt: t, personaId: 'general', messages: [{ role: 'user', content: 'x', at: t }, { role: 'assistant', content: 'y', personaId: 'general', model: 'glm-5.3', at: t }] });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'OVERLOAD429 ALWAYS first');
  await app.click('#send-btn');
  await expect(app.locator('body')).toHaveClass(/streaming/);
  await app.fill('#input', 'QUEUEDAFTERFAIL second');
  await app.click('#send-btn'); // = queue
  await expect(app.locator('#queue-bar .queue-item')).toHaveCount(1);
  await openChat(app, 'Bystander'); // the reply carries on (and fails) while you are elsewhere
  // wait until the reply has failed (it is retried a few times first), then a moment for a drain
  await expect.poll(async () => {
    const all = await app.evaluate(() => new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => { const g = globalThis.__ocmChatsReq(); g.onsuccess = () => res(g.result); }; }));
    return all.some((c) => c.messages.some((m) => m.error));
  }, { timeout: 60000 }).toBe(true);
  await app.waitForTimeout(3000);
  const reqs = (await (await request.get(`${globalThis.__MOCK}/__requests`)).json()).filter((r) => r.messages);
  expect(reqs.some((r) => JSON.stringify(r.messages).includes('QUEUEDAFTERFAIL'))).toBe(false);
  // back in the chat: the failed reply is there and the message waits in the queue
  await openChat(app, 'OVERLOAD429');
  await expect(app.locator('.msg-error')).toHaveCount(1);
  await expect(app.locator('#queue-bar .queue-item')).toHaveCount(1);
});

test.describe('stop during the compaction before a scheduled task', () => {
  test.use({ appSettings: { model: 'glm-5.3', compactAtModel: { 'glm-5.3': 2000 } } });
  test('a scheduled task in a chat not on screen: Stop while it compacts stops the reply too', async ({ app, request }) => {
    const t = Date.now();
    const long = 'word '.repeat(700);
    const A = (c) => ({ role: 'assistant', content: c, personaId: 'general', model: 'glm-5.3', at: t });
    const msgs = [];
    for (let i = 0; i < 6; i++) msgs.push({ role: 'user', content: `${i === 0 ? 'LONGTHINK ' : ''}${i} ${long}`, at: t }, A(`answer ${i}`));
    await putConv(app, { id: 'cs1', title: 'Compact me', createdAt: t - 9, updatedAt: t - 9, personaId: 'general', model: 'glm-5.3', messages: msgs, schedules: [{ id: 'st_c1', prompt: 'SCHEDULEDHELLO say hello', next: t + 2000, created: t }] });
    await putConv(app, { id: 'oth1', title: 'Elsewhere', createdAt: t, updatedAt: t, personaId: 'general', messages: [{ role: 'user', content: 'x', at: t }, A('y')] });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await openChat(app, 'Elsewhere');
    const reqs = async () => (await (await request.get(`${globalThis.__MOCK}/__requests`)).json()).filter((r) => r.messages);
    // the task comes due and its chat starts compacting (slowly: the transcript holds LONGTHINK)
    await expect.poll(async () => (await reqs()).some((r) => /summar/i.test(String(r.messages[0].content))), { timeout: 30000 }).toBe(true);
    await openChat(app, 'Compact me');
    await expect(app.locator('body')).toHaveClass(/streaming/);
    await app.fill('#input', '');
    await app.click('#send-btn'); // Stop
    await app.waitForTimeout(4000);
    expect((await reqs()).some((r) => !/summar/i.test(String(r.messages[0].content)) && JSON.stringify(r.messages.at(-1)).includes('SCHEDULEDHELLO'))).toBe(false);
  });
});

test('a quiet check the app was closed during is gone on the next start', async ({ app }) => {
  const t = Date.now();
  const A = (c, x = {}) => ({ role: 'assistant', content: c, personaId: 'general', model: 'glm-5.3', at: t, ...x });
  const check = { role: 'user', content: '⏰ Scheduled check (st_q1): look at the price', at: t, scheduled: true, quiet: true };
  await putConv(app, { id: 'qk1', title: 'Quiet one', createdAt: t, updatedAt: t, personaId: 'general', messages: [{ role: 'user', content: 'hi', at: t }, A('hello'), check, A('The pri', { streaming: true })] });
  await putConv(app, { id: 'qk2', title: 'Quiet two', createdAt: t - 5, updatedAt: t - 5, personaId: 'general', messages: [{ role: 'user', content: 'hi', at: t }, A('hello'), check, A('The price dropped to 40')] });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await openChat(app, 'Quiet one');
  await expect(app.locator('#messages > .msg')).toHaveCount(2);
  expect((await getConv(app, 'qk1')).messages).toHaveLength(2);
  await openChat(app, 'Quiet two'); // it finished and found something: it stays
  await expect(app.locator('#messages > .msg')).toHaveCount(4);
});
