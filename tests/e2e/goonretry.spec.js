import { test, expect, send } from './helpers.js';
import { fileURLToPath } from 'node:url';

const card = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url));

async function twoReplies(app) {
  await send(app, 'first question');
  await app.click('#send-btn'); // carry on with nothing typed → a second assistant message
  await app.waitForFunction(() => document.querySelectorAll('#messages > .msg.assistant').length === 3 && !document.body.classList.contains('streaming'));
}

test('retrying an earlier reply after "carry on" retries THAT reply (roleplay)', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await twoReplies(app);
  const texts = await app.locator('#messages > .msg.assistant').allInnerTexts();
  expect(texts).toHaveLength(3);
  // the middle reply (first real answer) is retried through its ⋯ menu
  await app.locator('#messages > .msg.assistant').nth(1).locator('.act-more').click();
  await app.click('#mm-retry');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'));
  const after = await app.locator('#messages > .msg.assistant').count();
  expect(after).toBe(2); // greeting + the retried reply; the carried-on one went away with the old tail
  await expect(app.locator('#messages > .msg.assistant').nth(1).locator('.pager-num')).toHaveText('2/2');
});
