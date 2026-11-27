import { test, expect } from './helpers.js';

// Decision 259: a chat's files are kept one record each, and a save writes only what changed – the workspace was one
// record with every file's bytes, written whole after each change. One saved the old way is read as it is.
test.use({ appSettings: { prefs: { tools: true } } });

const idb = (app, fn, arg) =>
  app.evaluate(
    ([src, a]) =>
      new Promise((res) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => new Function('db', 'a', 'res', src)(q.result, a, res);
      }),
    [fn, arg],
  );

test('an older workspace is read; then each file is its own record, and only changed ones are written again', async ({ app }) => {
  // a chat with files saved the old way: one record with every file in it
  await idb(
    app,
    `const t = db.transaction(['conversations', 'workspaces'], 'readwrite');
     t.objectStore('conversations').put({ id: 'w1', title: 'Files chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [{ role: 'user', content: 'hi', at: Date.now() }, { role: 'assistant', content: 'hello', at: Date.now() }] });
     const big = new Uint8Array(300000).fill(7);
     t.objectStore('workspaces').put({ id: 'w1', files: { 'big.bin': { data: big, mtime: 1 }, 'notes.md': { data: new TextEncoder().encode('# notes'), mtime: 2 } } });
     t.oncomplete = () => res();`,
  );
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.locator('.conv-item', { hasText: 'Files chat' }).locator('.conv-title').click();
  await expect(app.locator('#files-btn')).toContainText('2');
  // the agent writes a file: the workspace is saved – apart, from then on
  await app.fill('#input', 'MKPROJ please');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  const look = () =>
    idb(
      app,
      `const t = db.transaction(['workspaces', 'wsfiles']);
       const rec = t.objectStore('workspaces').get('w1');
       const keys = t.objectStore('wsfiles').getAllKeys(IDBKeyRange.bound(['w1'], ['w1', []]));
       t.oncomplete = () => res({ files: !!rec.result?.files, split: rec.result?.split, paths: keys.result.map((k) => k[1]).sort() });`,
    );
  await expect.poll(async () => (await look()).split, { timeout: 10000 }).toBe(1);
  const after = await look();
  expect(after.files).toBe(false); // the record has no file bytes in it
  expect(after.paths).toEqual(expect.arrayContaining(['big.bin', 'notes.md']));
  // the next save writes only the file that changed: count the file records written
  await app.evaluate(() => {
    globalThis.__puts = [];
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, k) {
      if (this.name === 'wsfiles') globalThis.__puts.push(k?.[1]);
      return put.call(this, v, k);
    };
  });
  await app.fill('#input', 'MKPROJ again');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await expect.poll(() => app.evaluate(() => globalThis.__puts.length), { timeout: 10000 }).toBeGreaterThan(0);
  await app.waitForTimeout(800);
  const puts = await app.evaluate(() => globalThis.__puts);
  expect(puts).not.toContain('big.bin');
  expect(puts).not.toContain('notes.md');
  // and it all comes back after a restart
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.locator('.conv-item', { hasText: 'Files chat' }).locator('.conv-title').click();
  await expect(app.locator('#files-btn')).toContainText(String(after.paths.length));
  await app.click('#files-btn');
  await expect(app.locator('#ws-list')).toContainText('big.bin');
});
