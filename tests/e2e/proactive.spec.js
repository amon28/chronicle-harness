import { test, expect, send } from './helpers.js';

test.describe('proactive messages', () => {
  test.use({ appSettings: { prefs: { proactive: true, quietFrom: '00:00', quietTo: '00:00', proactiveCap: 3 } } });
  test('a chat allowed to write first does so after the quiet stretch, and the wake plan goes to Android', async ({ app }) => {
    await app.clock.install();
    await app.addInitScript(() => {
      globalThis.__plans = [];
      globalThis.__ocmScheduler = { plan: async (o) => (globalThis.__plans.push(o.items), { exact: true }), status: async () => ({ exact: true }), addListener: async () => ({ remove() {} }) };
    });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await send(app, 'hello');
    await app.click('#persona-name-btn');
    await app.selectOption('#chat-proactive', '2');
    await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
    // Android is told when to wake the app
    await expect.poll(() => app.evaluate(() => (globalThis.__plans.at(-1) || []).map((x) => x.kind))).toContain('proactive');
    await app.clock.fastForward('02:10:00');
    await expect(app.locator('.proactive-note')).toHaveCount(1, { timeout: 15000 });
    await app.clock.fastForward('04:00:00');
    await app.waitForTimeout(500);
    await expect(app.locator('.proactive-note')).toHaveCount(1); // once per silence: it waits for you now
  });
});
