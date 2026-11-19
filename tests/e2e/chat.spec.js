import { test, expect, send, lastRequest, closeSheets } from './helpers.js';

test('sends a message and streams a rendered reply', async ({ app, request }) => {
  await send(app, 'hello there');
  const reply = app.locator('.msg.assistant').last();
  await expect(reply.locator('.md strong')).toHaveText('bold');
  await expect(reply.locator('.code-wrap')).toHaveCount(1);
  await expect(reply.locator('.msg-time')).toBeVisible();
  const req = await lastRequest(request);
  expect(req.model).toBe('glm-5.3');
  expect(req.messages.at(-1)).toEqual({ role: 'user', content: 'hello there' });
});

test('retry keeps alternatives that can be swiped', async ({ app }) => {
  await send(app, 'question');
  await app.click('.msg.assistant:last-child .act:has-text("Retry")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'));
  await expect(app.locator('.msg.assistant:last-child .pager-num')).toHaveText('2/2');
  await app.click('.msg.assistant:last-child .pager-btn >> nth=0');
  await expect(app.locator('.msg.assistant:last-child .pager-num')).toHaveText('1/2');
  await expect(app.locator('.msg.assistant:last-child .md')).toContainText('Reply #1');
});

test('settings survive a reload', async ({ app }) => {
  await app.evaluate(() => {
    const s = document.querySelector('#pref-textsize');
    s.value = 'xl';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // wait until the change is really written to storage (not a fixed delay), then reload
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          new Promise((resolve) => {
            const q = indexedDB.open('chronicle');
            q.onsuccess = () => {
              const g = q.result.transaction('kv').objectStore('kv').get('settings');
              g.onsuccess = () => {
                resolve(g.result?.prefs?.textSize);
                q.result.close();
              };
            };
          }),
      ),
    )
    .toBe('xl');
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await expect.poll(() => app.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fs').trim())).toBe('20px');
});

test('per-chat sampler settings are sent', async ({ app, request }) => {
  await app.click('#persona-name-btn');
  await app.click('#chat-samplers summary');
  await app.fill('#cs-temperature', '0.6');
  await app.fill('#cs-stop', '{{user}}:');
  await app.dispatchEvent('#cs-stop', 'change');
  await closeSheets(app);
  await send(app, 'samplers');
  const req = await lastRequest(request);
  expect(req.temperature).toBe(0.6);
  expect(req.stop).toEqual(['Alex:']);
});

test('prompt inspector shows the last request', async ({ app }) => {
  await send(app, 'inspect me');
  await app.click('#chat-more-btn');
  await app.click('#cm-more');
  await app.click('#cm-inspect');
  await expect(app.locator('#insp-meta')).toContainText('2 messages');
  await expect(app.locator('.insp-msg').last()).toContainText('inspect me');
});

test('the prompt inspector says whether a request starts like the one before (the provider can reuse its cache)', async ({ app }) => {
  await send(app, 'first');
  await send(app, 'second');
  await app.click('#chat-more-btn');
  await app.click('#cm-more');
  await app.click('#cm-inspect');
  await expect(app.locator('#insp-meta')).toContainText('Cache: this request starts like the one before');
});

test('the stylesheet is linked in the page head (no flash of an unstyled page while the app loads)', async ({ request }) => {
  const html = await (await request.get('/')).text();
  expect(html).toMatch(/<link rel="stylesheet"[^>]*href="[^"]+\.css"/);
});

test.describe('timings', () => {
  test.use({ appSettings: { prefs: { perfTrace: true } } });
  test('🩺 shows what happened after pressing send', async ({ app }) => {
    await send(app, 'hello');
    const r = app.locator('.perf-report');
    await expect(r).toBeVisible({ timeout: 10000 });
    await expect(r).toContainText('your message drawn');
    await expect(r).toContainText('prompt built');
    await expect(r).toContainText('first words arrived');
  });
});

test('switching between the Chats and Roleplay tabs does not open the keyboard', async ({ app }) => {
  await send(app, 'hello');
  await app.click('#menu-btn');
  await app.click('.mode-tab[data-mode="rp"]');
  expect(await app.evaluate(() => document.activeElement?.id)).not.toBe('input');
  await app.click('.mode-tab[data-mode="chat"]');
  expect(await app.evaluate(() => document.activeElement?.id)).not.toBe('input');
});
