import { test, expect } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

test('a tool step that errors stays folded with their reason in one line; opening one shows the details', async ({ app }) => {
  await app.fill('#input', 'TWOERRORS please');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  const cards = app.locator('.tool-card.error');
  await expect(cards).toHaveCount(2);
  for (const i of [0, 1]) {
    expect(await cards.nth(i).evaluate((e) => e.open)).toBe(false); // not auto-opened
    await expect(cards.nth(i).locator('.tool-errmsg')).toBeVisible();
  }
  await expect(cards.nth(0).locator('.tool-errmsg')).toContainText('missing-one.txt');
  await cards.nth(0).locator('summary').click();
  expect(await cards.nth(0).evaluate((e) => e.open)).toBe(true);
  expect(await cards.nth(1).evaluate((e) => e.open)).toBe(false);
});
