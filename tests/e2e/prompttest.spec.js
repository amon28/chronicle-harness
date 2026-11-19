import { test, expect, send } from './helpers.js';

test('prompt test: the same message goes to two variants side by side, without touching the chat', async ({ app }) => {
  await send(app, 'hello there');
  const before = await app.locator('#messages > .msg').count();
  await app.click('#chat-more-btn');
  await app.click('#cm-more');
  await app.click('#cm-ptest');
  await expect(app.locator('#pt-msg')).toHaveValue('hello there');
  await expect(app.locator('#pt-variants .pt-variant')).toHaveCount(2);
  await app.locator('#pt-variants .pt-variant').nth(1).locator('select').nth(1).selectOption('none');
  await app.click('#pt-run');
  await expect(app.locator('#pt-out-0')).not.toBeEmpty();
  await expect(app.locator('#pt-out-1')).not.toBeEmpty();
  await expect(app.locator('#pt-run')).toBeEnabled();
  await expect(app.locator('#pt-variants .pt-variant').first()).toContainText('s ·');
  await app.click('#pt-sheet [data-close]');
  expect(await app.locator('#messages > .msg').count()).toBe(before);
});

test('usage screen lists the busiest chats and keeps a daily budget', async ({ app }) => {
  await send(app, 'count me');
  await app.evaluate(() => document.getElementById('open-usage')?.click());
  await expect(app.locator('#usage-sheet')).toHaveClass(/open/);
  await expect(app.locator('#uh-chats .uh-row, #uh-chats .hint').first()).toBeVisible();
  await app.fill('#uh-budget', '2');
  await app.locator('#uh-budget').dispatchEvent('change');
  await expect(app.locator('#uh-budget-note')).toContainText('2M');
});
