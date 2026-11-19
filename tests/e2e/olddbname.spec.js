import { test, expect } from './helpers.js';

// Decision 217/218: an install updated in place still has its data under the database's old name
// ("opencode-mobile"); it is copied into "chronicle" before anything reads it, and the old one is left alone.
test('data under the old database name is copied over on first start, once, and shows', async ({ app }) => {
  const url = new URL(app.url());
  await app.route(`${url.origin}/setup-old.html`, (r) => r.fulfill({ body: '<!doctype html><title>setup</title>', contentType: 'text/html' }));
  await app.goto(`${url.origin}/setup-old.html`);
  await app.evaluate(async () => {
    const del = (n) => new Promise((res) => { const r = indexedDB.deleteDatabase(n); r.onsuccess = r.onerror = r.onblocked = () => res(); });
    await del('chronicle');
    await del('opencode-mobile');
    // the test's own settings (its key) went with the database: let the fixture seed them again, or the app opens
    // Settings on start (as it does without a key) and covers the menu
    localStorage.removeItem('ocm.settingsInIdb');
    const db = await new Promise((res) => {
      const r = indexedDB.open('opencode-mobile', 3);
      r.onupgradeneeded = () => { r.result.createObjectStore('conversations', { keyPath: 'id' }); r.result.createObjectStore('workspaces', { keyPath: 'id' }); r.result.createObjectStore('kv'); };
      r.onsuccess = () => res(r.result);
    });
    await new Promise((res) => {
      const t = db.transaction(['conversations', 'workspaces', 'kv'], 'readwrite');
      t.objectStore('conversations').put({ id: 'old1', title: 'From before the rename', createdAt: 1, updatedAt: Date.now(), messages: [{ role: 'user', content: 'hi from the old app' }] });
      t.objectStore('workspaces').put({ id: 'old1', files: { 'notes.txt': { data: new TextEncoder().encode('kept'), mtime: 1 } } });
      t.objectStore('kv').put({ objects: { a: new Uint8Array([1]) } }, 'git:old1');
      t.oncomplete = res;
    });
    db.close();
  });
  await app.goto(url.href);
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await expect(app.locator('#conv-list')).toContainText('From before the rename');
  const r = await app.evaluate(async () => {
    const open = (n) => new Promise((res) => { const q = indexedDB.open(n); q.onsuccess = () => res(q.result); });
    const get = (db, store, k) => new Promise((res) => { const q = db.transaction(store).objectStore(store).get(k); q.onsuccess = () => res(q.result); });
    const now = await open('chronicle');
    const old = await open('opencode-mobile');
    const ws = await get(now, 'workspaces', 'old1');
    return { file: new TextDecoder().decode(ws.files['notes.txt'].data), git: [...(await get(now, 'kv', 'git:old1')).objects.a], marked: !!(await get(now, 'kv', '__copiedFromOldName')), oldKept: !!(await get(old, 'conversations', 'old1')) };
  });
  expect(r).toEqual({ file: 'kept', git: [1], marked: true, oldKept: true });
});
