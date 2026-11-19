import { test, expect } from './helpers.js';

// "Run without battery limits" (Settings › Notifications) and "Let it see all phone storage" (Linux terminal) are
// buttons inside a hint sentence. They had no style at all there: same grey, no underline – nobody would tap them.
test('a link inside a hint looks like a link', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__ocmDevice = { status: async () => ({ batteryFree: false, allFiles: false }) };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="notify"]');
  const link = app.locator('#battery-allow');
  await expect(link).toBeVisible();
  const look = await link.evaluate((el) => ({ line: getComputedStyle(el).textDecorationLine, same: getComputedStyle(el).color === getComputedStyle(el.parentElement).color }));
  expect(look).toEqual({ line: 'underline', same: false });
  // the one in the terminal sheet uses the same class
  const term = await app.locator('#term-allfiles').evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(term).toBe('underline');
});
