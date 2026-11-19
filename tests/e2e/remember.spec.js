import { test, expect, send, lastRequest } from './helpers.js';

test.describe('with tools on', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('"# rule" goes into AGENTS.md, which the next request carries', async ({ app, request }) => {
    await send(app, 'hello');
    await app.fill('#input', '# always answer in French');
    await app.click('#send-btn');
    await expect(app.locator('#input')).toHaveValue('');
    await expect(app.locator('.msg.user')).toHaveCount(1); // nothing was sent
    await send(app, 'next');
    const req = await lastRequest(request);
    expect(String(req.messages[0].content)).toContain('always answer in French');
  });
});

test('without tools "# fact" becomes a memory', async ({ app, request }) => {
  await send(app, 'hello');
  await app.fill('#input', '# my cat is called Mochi');
  await app.click('#send-btn');
  await expect(app.locator('.msg.user')).toHaveCount(1);
  await send(app, 'next');
  const req = await lastRequest(request);
  // memories go after the history with the per-turn context (decision 199)
  expect(req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')).toContain('my cat is called Mochi');
});
