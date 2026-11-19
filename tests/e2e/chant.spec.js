import { test, expect, send } from './helpers.js';

test('a reply that keeps writing the same words is stopped, one copy kept, and says why', async ({ app }) => {
  await send(app, 'CHANTME');
  const reply = app.locator('.msg.assistant').last();
  await expect(reply.locator('.msg-cut')).toContainText('kept writing the same words over and over');
  const text = await reply.locator('.md').first().textContent();
  expect((text.match(/I will check the file once more/g) || []).length).toBe(1);
});
