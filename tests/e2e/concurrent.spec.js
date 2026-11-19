import { test, expect, send } from './helpers.js';

test('a chat keeps writing while you use another one; spinner while busy, blue dot when it finishes', async ({ app }) => {
  // chat A: a slow reply
  await app.fill('#input', 'LONGTHINK first chat');
  await app.click('#send-btn');
  await expect(app.locator('body')).toHaveClass(/streaming/);
  // leave it: new chat B, ask something there
  await app.click('#menu-btn');
  await app.click('#drawer-new');
  await expect(app.locator('body')).not.toHaveClass(/streaming/); // this (new) chat is idle: the send button is normal
  await send(app, 'hello from chat B');
  await expect(app.locator('.msg.assistant').last()).not.toBeEmpty();
  // A is still busy: spinner beside its name
  await app.click('#menu-btn');
  const a = app.locator('#conv-list .conv-item', { hasText: 'LONGTHINK first chat' });
  await expect(a.locator('.run-spin')).toBeVisible();
  await app.evaluate(() => document.getElementById('scrim').click());
  // when it finishes while we are in B: blue dot
  await app.waitForTimeout(6000);
  await app.click('#menu-btn');
  await expect(a.locator('.unseen-dot')).toBeVisible();
  await expect(a.locator('.run-spin')).toHaveCount(0);
  // open A: its reply is complete and the dot goes away
  await a.locator('.conv-title').click();
  await expect(app.locator('#messages > .msg.assistant')).toHaveCount(1);
  await expect(app.locator('.msg.assistant').last()).not.toBeEmpty();
  await expect(app.locator('.msg.user').first()).toContainText('LONGTHINK first chat');
  await app.click('#menu-btn');
  await expect(a.locator('.unseen-dot')).toHaveCount(0);
});
