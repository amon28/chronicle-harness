import { test, expect } from './helpers.js';

test('a usage-limit error tries again by itself once the allowance resets', async ({ app }) => {
  await app.clock.install();
  await app.addInitScript(() => (globalThis.__ocmUsageUrl = `${globalThis.__MOCK}/usage`));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'LIMITME hello');
  await app.click('#send-btn');
  const last = app.locator('.msg.assistant').last();
  await expect(last.locator('.msg-error')).toContainText('usage limit');
  await expect(last.locator('.msg-resume')).toContainText('Tries again at');
  await app.clock.fastForward(90_000); // past the reset
  await expect(app.locator('.msg.assistant').last().locator('.msg-error')).toHaveCount(0, { timeout: 15000 });
  await expect(app.locator('.msg-resume')).toHaveCount(0);
});

test('the planned retry can be cancelled', async ({ app }) => {
  await app.addInitScript(() => (globalThis.__ocmUsageUrl = `${globalThis.__MOCK}/usage`));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'LIMITME again');
  await app.click('#send-btn');
  const row = app.locator('.msg-resume');
  await expect(row).toBeVisible();
  await row.locator('button').click();
  await expect(row).toHaveCount(0);
});
