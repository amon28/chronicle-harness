import { test, expect, send, MOCK } from './helpers.js';

const lastReq = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages).at(-1);

test('hide a message from the AI: it stays on screen but is not sent', async ({ app, request }) => {
  await send(app, 'SECRETWORD first message');
  await send(app, 'second message');
  await app.locator('.msg.user').first().hover();
  await app.locator('.msg.user').first().locator('.act-more').click();
  await app.click('#mm-hide');
  await expect(app.locator('.msg.ai-hidden')).toHaveCount(1);
  await send(app, 'third message');
  const r = await lastReq(request);
  expect(JSON.stringify(r.messages)).not.toContain('SECRETWORD');
  expect(JSON.stringify(r.messages)).toContain('second message');
  await expect(app.locator('.msg.user').first()).toContainText('SECRETWORD');
});

test.describe('context editor', () => {
  const facts = [{ id: 'm1', text: 'Owns a corgi named Biscuit', scope: 'global', source: 'manual', createdAt: 1000, updatedAt: 1000 }];
  test.use({ appSettings: { memories: facts, prefs: { useMemory: true, learn: false } } });
  test('drop memories from the prompt without deleting them, then include them again', async ({ app, request }) => {
    await send(app, 'hello there');
    const first = await lastReq(request);
    expect(JSON.stringify(first.messages)).toContain('Biscuit');
    // after the history, not in the system prompt: a new pick of memories does not change the cached start (decision 199)
    expect(JSON.stringify(first.messages[0])).not.toContain('Biscuit');
    expect(first.messages.findIndex((m) => JSON.stringify(m).includes('Biscuit'))).toBeGreaterThan(first.messages.map((m) => m.role).lastIndexOf('user'));
    await app.click('#ctx-btn');
    await app.locator('#ctx-rows .ctx-row', { hasText: 'Memories' }).locator('.ctx-toggle').click();
    await expect(app.locator('#ctx-rows .ctx-row.off', { hasText: 'Memories' })).toBeVisible();
    await app.evaluate(() => document.querySelectorAll('.sheet.open').forEach((x) => x.querySelector('[data-close]')?.click()));
    await send(app, 'again');
    expect(JSON.stringify((await lastReq(request)).messages)).not.toContain('Biscuit');
    await app.click('#ctx-btn');
    await app.locator('#ctx-rows .ctx-row', { hasText: 'Memories' }).locator('.ctx-toggle').click();
    await app.evaluate(() => document.querySelectorAll('.sheet.open').forEach((x) => x.querySelector('[data-close]')?.click()));
    await send(app, 'once more');
    expect(JSON.stringify((await lastReq(request)).messages)).toContain('Biscuit');
  });
});
