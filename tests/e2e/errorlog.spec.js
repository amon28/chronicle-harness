import { test, expect } from './helpers.js';

// The app's error log (decision 177): a tool error, a crash nothing on screen shows, and a failed reply are all kept,
// newest first, with their chat; Settings › Data › Error log shows them, filters them and clears them.
test.use({ appSettings: { prefs: { tools: true } } });
const finished = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
const openLog = async (app) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="data"]');
  await app.click('#errlog-open');
  await expect(app.locator('#errlog-sheet')).toHaveClass(/open/);
};

test('tool errors and silent crashes are logged with their chat; the log filters, opens the chat and clears', async ({ app }) => {
  await app.fill('#input', 'DOCALLS [["read_file",{"path":"missing.txt"}]]');
  await app.click('#send-btn');
  await finished(app);
  // a crash in the app's code that nothing on screen shows
  await app.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'Cannot read properties of undefined (reading x)', filename: 'http://localhost/assets/engine.js', lineno: 12, colno: 5 })));
  await openLog(app);
  const items = app.locator('#errlog-list .errlog-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('App');
  await expect(items.nth(0)).toContainText('Cannot read properties of undefined (reading x)');
  await expect(items.nth(0)).toContainText('engine.js:12:5');
  await expect(items.nth(1)).toContainText('Tools');
  await expect(items.nth(1)).toContainText('read_file:');
  await expect(items.nth(1)).toContainText('in “DOCALLS');
  await expect(app.locator('#errlog-count')).toHaveText('(2)');
  // filter
  await app.locator('#errlog-filters .filter-chip', { hasText: 'Tools' }).click();
  await expect(items).toHaveCount(1);
  // tapping an entry opens its chat
  await items.first().click();
  await expect(app.locator('#errlog-sheet')).not.toHaveClass(/open/);
  await expect(app.locator('.msg.user').first()).toContainText('DOCALLS');
  // it survives a restart; Clear empties it
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await openLog(app);
  await expect(items).toHaveCount(2);
  await app.click('#errlog-clear');
  await expect(app.locator('#errlog-list')).toContainText('No errors logged');
});

test.describe('a reply that fails', () => {
  test.use({ appSettings: { apiKey: 'bad', prefs: { tools: false } } });
  test('is logged with its model and chat', async ({ app }) => {
    await app.fill('#input', 'hello');
    await app.click('#send-btn');
    await finished(app);
    await openLog(app);
    const first = app.locator('#errlog-list .errlog-item').first();
    await expect(first).toContainText('Replies');
    await expect(first).toContainText('Invalid API key');
    await expect(first).toContainText('GLM-5.3');
  });
});
