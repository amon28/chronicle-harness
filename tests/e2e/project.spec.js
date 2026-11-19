import { test, expect, MOCK } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true, toolDelegate: true } } });

test('project commands and named agents come from the workspace', async ({ app, request }) => {
  await app.fill('#input', 'MKPROJ set it up');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  // /hello is offered in the slash menu and expands with what you type
  await app.locator('#input').click();
  await app.keyboard.type('/hel');
  await expect(app.locator('#slash-menu .slash-item', { hasText: 'Greet someone' })).toBeVisible();
  await app.fill('#input', '/hello Bob');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await expect(app.locator('.msg.user').last()).toContainText('Say hello to Bob.');
  // the delegate tool lists the project's agent, and using it gives the helper the agent's own prompt
  await app.fill('#input', 'USEAGENT please');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  const reqs = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
  const withDelegate = reqs.find((r) => (r.tools || []).some((t) => t.function.name === 'delegate' && t.function.parameters.properties.agent));
  expect(withDelegate.tools.find((t) => t.function.name === 'delegate').function.parameters.properties.agent.enum).toEqual(['tester']);
  expect(reqs.some((r) => String(r.messages[0].content).includes('YOU ARE THE TESTER AGENT'))).toBe(true);
  await expect(app.locator('.msg.assistant').last()).toContainText('tester agent here: all green');
});

test('reply style per chat goes into the system prompt', async ({ app, request }) => {
  const { send, lastRequest } = await import('./helpers.js');
  await send(app, 'hi');
  await app.click('#persona-name-btn');
  await app.locator('#chat-style').selectOption('explanatory');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await send(app, 'again');
  const req = await lastRequest(request);
  expect(String(req.messages[0].content)).toContain('Output style – explanatory');
});
