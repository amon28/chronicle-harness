import { test, expect, send } from './helpers.js';

test('HTML-styled replies keep their styling, but cannot run code or restyle the app', async ({ app }) => {
  await send(app, 'RICHHTML please');
  const rich = app.locator('.msg.assistant .rich-html').last();
  await expect(rich.locator('span.t')).toHaveText('Styled');
  expect(await rich.locator('span.t').evaluate((e) => getComputedStyle(e).fontWeight)).toBe('700'); // its own <style>, scoped
  expect(await rich.evaluate((e) => getComputedStyle(e).position)).not.toBe('fixed');
  expect(await app.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(255, 0, 0)'); // "body {…}" did not leak out
  await expect(rich.locator('script')).toHaveCount(0);
  expect(await app.evaluate(() => globalThis.__pwned)).toBeUndefined();
});

test('chats and roleplays have their own background setting', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="look"]');
  await app.selectOption('#pref-bg', 'dots');
  await app.selectOption('#pref-bg-rp', 'gradient');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await send(app, 'hello'); // a chat with an assistant
  await expect(app.locator('#messages')).toHaveClass(/bg-dots/);
  await expect(app.locator('#messages')).not.toHaveClass(/bg-gradient/);
});

test('typing ```md and pressing Enter turns the field into a code box with a free line below', async ({ app }) => {
  await app.fill('#input', '```md');
  await app.press('#input', 'Enter');
  await expect(app.locator('#input')).toHaveValue('```md\n\n```\n');
  await app.keyboard.type('# Title');
  await expect(app.locator('#input')).toHaveValue('```md\n# Title\n```\n');
  await expect(app.locator('#input')).toHaveClass(/in-code/);
  await expect(app.locator('#compose-preview')).toContainText('code · md');
  // the line below the closing fence is free for normal text
  await app.locator('#compose-preview button', { hasText: 'Done' }).click(); // steps out below the box
  await expect(app.locator('#input')).not.toHaveClass(/in-code/);
  await app.keyboard.type('and then I write more');
  await expect(app.locator('#input')).toHaveValue('```md\n# Title\n```\nand then I write more');
});
