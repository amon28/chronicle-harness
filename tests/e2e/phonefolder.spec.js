import { test, expect } from './helpers.js';

const fake = () => {
  const disk = { 'a.txt': new TextEncoder().encode('hello'), 'sub/b.txt': new TextEncoder().encode('there') };
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  globalThis.__disk = disk;
  globalThis.__ocmPhoneFolder = {
    pick: async () => ({ uri: 'content://fake', name: 'Projects' }),
    list: async () => ({ entries: Object.entries(disk).map(([path, d]) => ({ path, isDir: false, size: d.length })) }),
    read: async ({ path }) => ({ base64: b64(disk[path]) }),
    write: async ({ path, base64 }) => ((disk[path] = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))), { existed: false }),
    remove: async () => ({}),
    exists: async ({ path }) => ({ exists: !!disk[path], isDir: false, size: 0 }),
  };
};

test.use({ appSettings: { prefs: { tools: true } } });

test('link a phone folder, bring its files in, and save workspace files back', async ({ app }) => {
  await app.addInitScript(fake);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await expect(app.locator('#files-btn')).toBeVisible();
  await app.click('#files-btn');
  await app.click('#phone-link');
  await expect(app.locator('#phone-name')).toHaveText(/Projects · linked/);
  await expect(app.locator('#phone-in')).toBeHidden(); // one compact row: the actions are in its ⋯ menu
  await app.click('#phone-more');
  await app.click('#phone-in');
  await expect(app.locator('#ws-list')).toContainText('b.txt'); // shown as a tree: sub › b.txt
  app.on('dialog', (d) => d.accept());
  await app.click('#phone-more');
  await app.click('#phone-out');
  await expect.poll(() => app.evaluate(() => Object.keys(globalThis.__disk).sort().join(','))).toBe('a.txt,sub/b.txt');
  await app.click('#phone-more');
  await app.click('#phone-unlink');
  await expect(app.locator('#phone-name')).toHaveText(/No phone folder/);
});

test('Files › the phone folder: copy a whole folder into the chat, without git data and packages', async ({ app }) => {
  await app.addInitScript(fake);
  await app.addInitScript(() => {
    const t = (s) => new TextEncoder().encode(s);
    Object.assign(globalThis.__disk, { 'sub/c.js': t('const c = 1;'), 'sub/.git/HEAD': t('ref'), 'sub/node_modules/x/i.js': t('x') });
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#files-btn');
  await app.click('#phone-link');
  await expect(app.locator('#phone-name')).toHaveText(/Projects · linked/);
  await app.click('#files-sheet [data-close]');
  await app.click('#menu-btn');
  await app.click('#open-wsm');
  await app.click('#wsm-loc-phone');
  await app.click('#wsm-select');
  await app.locator('#wsm-list .wsm-row', { hasText: 'sub' }).locator('input').check();
  await app.click('#wsm-tochat');
  await expect(app.locator('#text-hint')).toContainText('Left out: sub/.git, sub/node_modules');
  await app.click('#text-ok');
  await expect(app.locator('#toast')).toContainText('Copied 2 files into this chat');
});
