import { test, expect, send, lastRequest } from './helpers.js';

test('/guide steers the next reply without adding a message of mine', async ({ app, request }) => {
  await send(app, 'hello');
  await app.fill('#input', '/guide talk only about cats');
  await app.click('#send-btn');
  await app.waitForFunction(() => document.querySelectorAll('.msg.assistant').length === 2 && !document.body.classList.contains('streaming'), null, { timeout: 15000 });
  await expect(app.locator('.msg.user')).toHaveCount(1);
  const req = await lastRequest(request);
  expect(JSON.stringify(req.messages)).toContain('talk only about cats');
  await expect(app.locator('#input')).toHaveValue('');
});
