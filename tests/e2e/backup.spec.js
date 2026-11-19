import { test, expect, send } from './helpers.js';

test('a backup is written as a stream, and restores back into a readable zip with the files in it', async ({ app }) => {
  await send(app, 'hello backup');
  // put a big-ish workspace file in the chat so the backup has to stream more than one piece
  const result = await app.evaluate(async () => {
    const open = () => new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => res(r.result); });
    const db = await open();
    const convs = await new Promise((res) => { const q = db.transaction('conversations').objectStore('conversations').getAll(); q.onsuccess = () => res(q.result); });
    const id = convs[0].id;
    const big = new Uint8Array(3 * 1024 * 1024);
    let x = 123456789;
    for (let i = 0; i < big.length; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5; // xorshift: random bytes don't compress
      big[i] = x & 255;
    }
    await new Promise((res) => {
      const t = db.transaction('workspaces', 'readwrite');
      t.objectStore('workspaces').put({ id, files: { 'data.bin': { data: big, mtime: 1 }, 'a.txt': { data: new TextEncoder().encode('hello'), mtime: 1 } } }); // an odd modification time (1970) must not break the zip
      t.oncomplete = res;
    });
    return id;
  });
  expect(result).toBeTruthy();
  // the in-app button path: Settings › Data › Export backup (web build downloads the file)
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="data"]');
  const [download] = await Promise.all([app.waitForEvent('download'), app.click('#backup-export')]);
  const path = await download.path();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(path);
  expect(bytes.length).toBeGreaterThan(3 * 1024 * 1024); // the big file is in there
  expect(bytes.subarray(0, 2).toString()).toBe('PK'); // a zip
  // the zip is a real, complete zip: unpack it and compare
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(bytes));
  const keys = Object.keys(files);
  expect(keys.some((k) => k === 'backup.json')).toBe(true);
  const big = keys.find((k) => k.endsWith('/data.bin'));
  const small = keys.find((k) => k.endsWith('/a.txt'));
  expect(files[big].length).toBe(3 * 1024 * 1024);
  expect(strFromU8(files[small])).toBe('hello');
  await expect(app.locator('#backup-status')).toContainText('Backed up');
  await expect(app.locator('#backup-status')).toContainText('2 files');
});
