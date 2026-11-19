import { test, expect, send } from './helpers.js';

test('editing a reply: after Save the chat stays on that message', async ({ app }) => {
  for (let i = 0; i < 8; i++) await send(app, `message ${i}`); // enough below it that the chat can scroll freely
  const target = app.locator('.msg.assistant').nth(1);
  await target.scrollIntoViewIfNeeded();
  await app.evaluate(() => {
    const m = document.querySelectorAll('.msg.assistant')[1];
    document.querySelector('#messages').scrollTop += m.getBoundingClientRect().top - 120; // the reply near the top
  });
  const top = await target.evaluate((e) => e.getBoundingClientRect().top);
  await target.locator('button[aria-label="Edit"]').first().click();
  await target.locator('textarea.edit-reply').fill('Changed reply, a few words longer than before.');
  await target.locator('.edit-box .primary-btn').click();
  const edited = app.locator('.msg.assistant').nth(1);
  await expect(edited).toContainText('Changed reply');
  const after = await edited.evaluate((e) => e.getBoundingClientRect().top);
  expect(Math.abs(after - top)).toBeLessThan(4);
});
