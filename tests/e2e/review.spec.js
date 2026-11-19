import { test, expect } from './helpers.js';

const fake = () => {
  const disk = { 'a.txt': new TextEncoder().encode('hello') };
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  globalThis.__disk = disk;
  globalThis.__ocmPhoneFolder = {
    pick: async () => ({ uri: 'content://fake', name: 'Projects' }),
    list: async () => ({ entries: Object.entries(disk).map(([path, d]) => ({ path, isDir: false, size: d.length })) }),
    read: async ({ path }) => ({ base64: b64(disk[path]) }),
    write: async ({ path, base64 }) => ((disk[path] = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))), { existed: path in disk }),
    remove: async ({ path }) => (delete disk[path], {}),
    exists: async ({ path }) => ({ exists: !!disk[path], isDir: false, size: 0 }),
  };
};
const diskText = (app) => app.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(globalThis.__disk).map(([k, v]) => [k, new TextDecoder().decode(v)]))));

test.use({ appSettings: { prefs: { tools: true } } });

async function link(app) {
  await app.addInitScript(fake);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#files-btn');
  await app.click('#phone-link');
  await expect(app.locator('#phone-name')).toHaveText(/Projects/);
  await app.click('#files-sheet [data-close]');
}

test('review mode: nothing is saved until you accept, and you can pick per file', async ({ app }) => {
  await link(app);
  await expect(app.locator('#mode-btn')).toContainText('Review');
  await app.fill('#input', 'PHONEW do it');
  await app.click('#send-btn');
  await expect(app.locator('#review-sheet')).toHaveClass(/open/);
  expect(JSON.parse(await diskText(app))).toEqual({ 'a.txt': 'hello' });
  await expect(app.locator('#review-list .review-item')).toHaveCount(2);
  await app.locator('#review-list .review-item', { hasText: 'a.txt' }).locator('input[type=checkbox]').uncheck();
  await app.click('#review-apply');
  await expect.poll(() => diskText(app)).toBe(JSON.stringify({ 'a.txt': 'hello', 'new/c.txt': 'brand new' }));
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  await expect(app.locator('.msg.assistant').last().locator('.act', { hasText: 'Undo 1 file change' })).toBeVisible();
});

test('review mode: reject all leaves the phone untouched', async ({ app }) => {
  await link(app);
  await app.fill('#input', 'PHONEW do it');
  await app.click('#send-btn');
  await expect(app.locator('#review-sheet')).toHaveClass(/open/);
  await app.click('#review-reject');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  expect(JSON.parse(await diskText(app))).toEqual({ 'a.txt': 'hello' });
});

test('auto mode skips the sheet and undo restores the phone', async ({ app }) => {
  await link(app);
  await app.click('#mode-btn');
  await app.click('#mode-options [data-mode="auto"]');
  await expect(app.locator('#mode-btn')).toContainText('Auto');
  await app.fill('#input', 'PHONEW do it');
  await app.click('#send-btn');
  await expect.poll(() => diskText(app)).toBe(JSON.stringify({ 'a.txt': 'hello v2', 'new/c.txt': 'brand new' }));
  await expect(app.locator('#review-sheet')).not.toHaveClass(/open/);
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  app.once('dialog', (d) => d.accept());
  await app.locator('.msg.assistant').last().locator('.act', { hasText: 'Undo 2 file changes' }).click();
  await expect.poll(() => diskText(app)).toBe(JSON.stringify({ 'a.txt': 'hello' }));
});
