import { test, expect } from './helpers.js';

const fake = () => {
  const disk = {};
  globalThis.__disk = disk;
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  void b64;
  globalThis.__ocmPhoneFolder = {
    pick: async () => ({ uri: 'content://fake', name: 'Backups' }),
    list: async () => ({ entries: Object.keys(disk).map((path) => ({ path, name: path, isDir: false, size: disk[path].length })) }),
    read: async () => ({ base64: '' }),
    write: async ({ path, base64 }) => ((disk[path] = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))), { existed: false }),
    remove: async ({ path }) => (delete disk[path], { ok: true }),
    exists: async ({ path }) => ({ exists: !!disk[path], isDir: false, size: 0 }),
  };
};

test('automatic backup writes a zip into the chosen phone folder and keeps only the newest few', async ({ app }) => {
  await app.addInitScript(fake);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  // old backups (ours) and an unrelated file in the folder
  await app.evaluate(() => {
    for (const d of ['2024-01-01-0900', '2024-01-02-0900', '2024-01-03-0900', '2024-01-04-0900']) globalThis.__disk[`chronicle-backup-${d}.zip`] = new Uint8Array(3);
    globalThis.__disk['my-notes.txt'] = new Uint8Array(3);
  });
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="data"]');
  await expect(app.locator('#autobackup-box')).toBeVisible();
  await app.click('#ab-pick');
  await expect(app.locator('#ab-folder')).toContainText('Backups');
  await app.selectOption('#ab-keep', '3');
  await app.click('#ab-now');
  await expect(app.locator('#ab-status')).toContainText('Last backup');
  const names = await app.evaluate(() => Object.keys(globalThis.__disk).sort());
  expect(names).toContain('my-notes.txt'); // never touched
  const mine = names.filter((n) => n.startsWith('chronicle-backup-'));
  expect(mine).toHaveLength(3);
  expect(mine).not.toContain('chronicle-backup-2024-01-01-0900.zip');
  expect(mine).not.toContain('chronicle-backup-2024-01-02-0900.zip');
  const newest = mine.at(-1);
  expect(await app.evaluate((n) => globalThis.__disk[n].length, newest)).toBeGreaterThan(100); // a real zip
});
