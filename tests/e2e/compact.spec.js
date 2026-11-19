import { test, expect, send, MOCK } from './helpers.js';

test('/compact with a focus summarizes now and tells the summary what to keep', async ({ app, request }) => {
  for (const t of ['one', 'two', 'three', 'four']) await send(app, t);
  await app.fill('#input', '/compact the cat names');
  await app.click('#send-btn');
  await expect
    .poll(async () => (await (await request.get(MOCK + '/__requests')).json()).some((r) => r.messages && String(r.messages[0].content).includes('keep, in particular: the cat names')))
    .toBe(true);
  await expect(app.locator('#input')).toHaveValue('');
});

test.describe('auto-compact threshold', () => {
  test.use({ appSettings: { prefs: { compactAt: 0.8 }, compactAtModel: { 'glm-5.3': 2000 } } });
  test('a per-model token threshold compacts a chat long before the model is full', async ({ app, request }) => {
    const long = 'word '.repeat(700);
    for (let i = 0; i < 5; i++) await send(app, `${i} ${long}`);
    await expect
      .poll(async () => (await (await request.get(MOCK + '/__requests')).json()).some((r) => r.messages && /summar/i.test(String(r.messages[0].content)) && !String(r.messages[0].content).includes('keep, in particular')), { timeout: 15000 })
      .toBe(true);
  });
});
