import { test, expect, send } from './helpers.js';

// Decision 239: the app stays responsive while a reply streams – fewer redraws, tool cards kept, no colouring of a code
// box still being written, the chat list left alone while the drawer is shut, the composer's code check quiet.

test.describe('while a reply streams', () => {
  test.use({ appSettings: { prefs: { tools: true } } });

  test('tool cards stay the same elements and the reply is redrawn at most ~10 times a second', async ({ app }) => {
    await app.fill('#input', 'STEPSTHENTEXT please');
    await app.click('#send-btn');
    const last = app.locator('.msg.assistant').last();
    await expect(last).toContainText('Answer paragraph 2', { timeout: 20000 });
    // mark the steps box, and count how often the reply text changes for one second
    await app.evaluate(() => {
      const m = [...document.querySelectorAll('.msg.assistant')].pop();
      m.querySelector('.tool-group').__mark = 1;
      globalThis.__paints = 0;
      const mo = new MutationObserver(() => globalThis.__paints++);
      mo.observe(m.querySelector('.md'), { childList: true, subtree: true, characterData: true });
      setTimeout(() => mo.disconnect(), 1000);
    });
    await app.waitForTimeout(1000);
    const r = await app.evaluate(() => {
      const m = [...document.querySelectorAll('.msg.assistant')].pop();
      return { streaming: document.body.classList.contains('streaming'), kept: m.querySelector('.tool-group')?.__mark === 1, paints: globalThis.__paints };
    });
    expect(r.streaming).toBe(true); // still writing: the check above was mid-reply
    expect(r.kept).toBe(true);
    expect(r.paints).toBeGreaterThan(2);
    expect(r.paints).toBeLessThanOrEqual(14);
  });

  test('a code box still being written is not coloured; once closed it is', async ({ app }) => {
    await app.fill('#input', 'SLOWCODE please');
    await app.click('#send-btn');
    const last = app.locator('.msg.assistant').last();
    await expect(last).toContainText('step 5', { timeout: 20000 });
    expect(await last.locator('pre .hljs, pre code.hljs').count()).toBe(0);
    await expect(last).toContainText('CODEDONE', { timeout: 20000 });
    await expect(last.locator('code.hljs')).toHaveCount(1);
    await expect(last.locator('code.hljs .hljs-keyword').first()).toHaveText('const');
  });
});

test('a save with the drawer shut leaves the chat list alone; opening it shows the change', async ({ app }) => {
  await send(app, 'first chat');
  await app.evaluate(() => (document.querySelector('#conv-list').firstElementChild.__mark = 1));
  await send(app, 'again');
  expect(await app.evaluate(() => document.querySelector('#conv-list').firstElementChild?.__mark === 1)).toBe(true);
  await app.click('#menu-btn');
  await expect(app.locator('body.drawer-open')).toHaveCount(1);
  expect(await app.evaluate(() => document.querySelector('#conv-list').firstElementChild?.__mark === 1)).toBe(false); // redrawn on opening
  await expect(app.locator('#conv-list')).toContainText('first chat');
});

test('typing outside a code box does not touch the keyboard settings; entering one does, once', async ({ app }) => {
  await app.evaluate(() => {
    globalThis.__attr = [];
    new MutationObserver((l) => l.forEach((m) => globalThis.__attr.push(m.attributeName))).observe(document.querySelector('#input'), { attributes: true, attributeFilter: ['spellcheck', 'autocapitalize', 'class'] });
  });
  await app.locator('#input').pressSequentially('hello there');
  await app.waitForTimeout(100);
  expect(await app.evaluate(() => globalThis.__attr.length)).toBe(0);
  await app.locator('#input').pressSequentially('\n```py\nx = 1');
  await expect(app.locator('#input.in-code')).toHaveCount(1);
  const n = await app.evaluate(() => globalThis.__attr.length);
  expect(n).toBeGreaterThan(0);
  await app.locator('#input').pressSequentially('\ny = 2');
  await app.waitForTimeout(100);
  expect(await app.evaluate(() => globalThis.__attr.length)).toBe(n); // still in the same box: nothing touched
});
