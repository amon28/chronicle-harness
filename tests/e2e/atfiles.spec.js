import { test, expect, lastRequest } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

test('@ offers workspace files; @path attaches the file as it is now', async ({ app, request }) => {
  await app.fill('#input', 'PATCHME please'); // the assistant writes app.py and notes.md
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await app.locator('#input').click();
  await app.keyboard.type('what does @app');
  await expect(app.locator('#slash-menu .mention-item', { hasText: '@app.py' })).toBeVisible();
  await app.locator('#slash-menu .mention-item', { hasText: '@app.py' }).click();
  await expect(app.locator('#input')).toHaveValue('what does @app.py ');
  await app.keyboard.type('do?');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  const req = await lastRequest(request);
  const mine = req.messages.filter((m) => m.role === 'user').pop();
  expect(JSON.stringify(mine.content)).toContain('[@app.py');
  expect(JSON.stringify(mine.content)).toContain('return 10');
});
