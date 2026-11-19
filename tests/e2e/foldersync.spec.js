import { test, expect } from './helpers.js';

const fake = () => {
  const disk = {};
  globalThis.__disk = disk;
  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  globalThis.__ocmPhoneFolder = {
    pick: async () => ({ uri: 'content://fake', name: 'Sync' }),
    list: async () => ({ entries: Object.keys(disk).map((path) => ({ path, name: path, isDir: false, size: disk[path].length })) }),
    read: async ({ path }) => ({ base64: b64(disk[path]) }),
    write: async ({ path, base64 }) => ((disk[path] = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))), { existed: false }),
    remove: async ({ path }) => (delete disk[path], { ok: true }),
    exists: async ({ path }) => ({ exists: !!disk[path], isDir: false, size: 0 }),
  };
};

test('merge the newest backup from the folder', async ({ app }) => {
  await app.addInitScript(fake);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="data"]');
  await app.click('#ab-pick');
  await expect(app.locator('#ab-sync')).toBeVisible();
  await app.click('#ab-now');
  await expect(app.locator('#ab-status')).toContainText('Last backup');
  let asked = '';
  app.once('dialog', (d) => {
    asked = d.message();
    d.accept();
  });
  await app.click('#ab-sync');
  await expect(app.locator('.toast, #toast').filter({ hasText: 'Merged' }).first()).toBeVisible();
  expect(asked).toContain('Newer copies win');
});
