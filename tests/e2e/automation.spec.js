import { test, expect } from './helpers.js';

test.describe('automation links', () => {
  test.use({ appSettings: { automation: [{ name: 'Tasker', token: 'tok123', package: 'net.dinglisch.android.taskerm' }] } });
  test('a caller with its token runs a prompt in a new chat and gets the reply back; without it nothing runs', async ({ app }) => {
    await app.addInitScript(() => {
      globalThis.__replies = [];
      globalThis.__ocmAutomation = { reply: async (o) => globalThis.__replies.push(o) };
    });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.evaluate(() => globalThis.__ocmDeepLink('chronicle://run?token=wrong&prompt=hello'));
    await expect(app.locator('#toast')).toContainText('without a valid token');
    await expect(app.locator('.msg.user')).toHaveCount(0);
    await app.evaluate(() => globalThis.__ocmDeepLink('chronicle://run?token=tok123&prompt=what%20is%202%2B2&id=r1'));
    await expect.poll(() => app.evaluate(() => globalThis.__replies.length), { timeout: 20000 }).toBe(1);
    const r = await app.evaluate(() => globalThis.__replies[0]);
    expect(r).toMatchObject({ id: 'r1', ok: true, package: 'net.dinglisch.android.taskerm' });
    expect(r.text).toContain('Reply');
    await expect(app.locator('.msg.user')).toContainText('what is 2+2');
  });
});
