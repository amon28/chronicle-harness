import { test, expect } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

test('android_intent asks first, then hands the timer to the clock app', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__started = [];
    globalThis.__ocmIntents = { start: async (i) => globalThis.__started.push(i) };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'INTENTME set a pasta timer');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toContainText('Start a 10 min timer (“Pasta”)?');
  await app.click('#ask-options .menu-item:has-text("Open it")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });
  await expect(app.locator('.msg.assistant').last()).toContainText('Intent: Opened (timer)');
  expect(await app.evaluate(() => globalThis.__started)).toEqual([{ action: 'android.intent.action.SET_TIMER', extras: { 'android.intent.extra.alarm.LENGTH': 600, 'android.intent.extra.alarm.MESSAGE': 'Pasta' }, title: 'Start a 10 min timer (“Pasta”)?' }]);
});
