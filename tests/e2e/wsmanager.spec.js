import { test, expect } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

async function seed(app) {
  await app.evaluate(async () => {
    const put = (store, v) => new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => { const t = r.result.transaction(store, 'readwrite'); t.objectStore(store).put(v); t.oncomplete = res; }; });
    const enc = (s) => new TextEncoder().encode(s);
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    await put('conversations', { id: 'wc1', title: 'Aquarium build', createdAt: 1, updatedAt: 5, personaId: 'general', messages: [{ role: 'user', content: 'hi', at: 1 }] });
    await put('conversations', { id: 'wc2', title: 'Notes chat', createdAt: 1, updatedAt: 4, personaId: 'general', messages: [{ role: 'user', content: 'yo', at: 1 }] });
    await put('workspaces', { id: 'wc1', files: { 'output/aquarium/index.html': { data: enc('<h1>Fish</h1>'), mtime: Date.now() }, 'output/aquarium/style.css': { data: enc('h1{color:red}'), mtime: Date.now() - 1000 }, 'output/chart.png': { data: png, mtime: Date.now() - 5000 }, 'readme.md': { data: enc('# hello'), mtime: Date.now() - 9000 } } });
    await put('workspaces', { id: 'wc2', files: { 'todo.txt': { data: enc('milk'), mtime: Date.now() } } });
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
}

test('Workspace manager: browse chats and folders, search, preview, select and delete', async ({ app }) => {
  await seed(app);
  await app.click('#menu-btn');
  await app.click('#open-wsm');
  const rows = app.locator('#wsm-list .wsm-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Notes chat' })).toContainText('1 file');
  await expect(rows.filter({ hasText: 'Aquarium build' })).toContainText('4 files');
  // into the chat, then into folders
  await rows.filter({ hasText: 'Aquarium build' }).locator('.wsm-open').click();
  await expect(app.locator('#wsm-list .wsm-title')).toHaveText(['output', 'readme.md']);
  await app.locator('#wsm-list .wsm-row', { hasText: 'output' }).locator('.wsm-open').click();
  await expect(app.locator('#wsm-list .wsm-title')).toHaveText(['aquarium', 'chart.png']);
  await expect(app.locator('#wsm-crumbs')).toContainText('output');
  await app.locator('#wsm-list .wsm-row', { hasText: 'aquarium' }).locator('.wsm-open').click();
  // preview a page from here
  await app.locator('#wsm-list .wsm-row', { hasText: 'index.html' }).locator('.wsm-open').click();
  await expect(app.locator('#preview-title')).toHaveText('output/aquarium/index.html');
  await expect(app.locator('#preview-html')).toBeVisible();
  await app.click('#preview-sheet [data-close]');
  // search across everything
  await app.fill('#wsm-search', 'chart');
  await expect(app.locator('#wsm-list .wsm-title')).toHaveText(['output/chart.png']); // searches inside this chat
  await app.fill('#wsm-search', '');
  await app.click('.wsm-crumb:has-text("Workspace")');
  await app.fill('#wsm-search', 'todo');
  await expect(app.locator('#wsm-list .wsm-title')).toHaveText(['todo.txt']); // …or across all chats
  await app.fill('#wsm-search', '');
  await app.locator('#wsm-list .wsm-row', { hasText: 'Aquarium build' }).locator('.wsm-open').click();
  await app.locator('#wsm-list .wsm-row', { hasText: 'output' }).locator('.wsm-open').click();
  await app.locator('#wsm-list .wsm-row', { hasText: 'aquarium' }).locator('.wsm-open').click();
  // select the folder and delete it
  await app.click('#wsm-select');
  await app.locator('#wsm-list .wsm-row', { hasText: 'style.css' }).locator('input').check();
  await expect(app.locator('#wsm-count')).toContainText('1 file selected');
  app.once('dialog', (d) => d.accept());
  await app.click('#wsm-del');
  await expect(app.locator('#wsm-list .wsm-title')).toHaveText(['index.html']);
});

test('a text file can be copied whole from its preview', async ({ app, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await seed(app);
  await app.click('#menu-btn');
  await app.click('#open-wsm');
  await app.locator('#wsm-list .wsm-row', { hasText: 'Aquarium build' }).locator('.wsm-open').click();
  await app.locator('#wsm-list .wsm-row', { hasText: 'readme.md' }).locator('.wsm-open').click();
  await expect(app.locator('#preview-copy')).toBeVisible();
  await app.click('#preview-copy');
  await expect(app.locator('#toast')).toContainText('Copied');
  // a picture has no text to copy
  await app.click('#preview-sheet [data-close]');
  await app.locator('#wsm-list .wsm-row', { hasText: 'output' }).locator('.wsm-open').click();
  await app.locator('#wsm-list .wsm-row', { hasText: 'chart.png' }).locator('.wsm-open').click();
  await expect(app.locator('#preview-copy')).toBeHidden();
});

test('a file can be kept on the phone: Download into Download/Chronicle, or Save as… anywhere', async ({ app }) => {
  await seed(app);
  await app.evaluate(() => {
    globalThis.__saved = [];
    globalThis.__ocmPhoneFolder = {
      saveToDownloads: async (o) => (globalThis.__saved.push({ how: 'downloads', ...o }), { name: o.name, folder: 'Download/Chronicle' }),
      saveAs: async (o) => (globalThis.__saved.push({ how: 'as', ...o }), { saved: true, name: o.name }),
    };
  });
  await app.click('#menu-btn');
  await app.click('#open-wsm');
  await app.locator('#wsm-list .wsm-row', { hasText: 'Notes chat' }).locator('.wsm-open').click();
  await app.locator('#wsm-list .wsm-row', { hasText: 'todo.txt' }).locator('.wsm-open').click();
  await app.click('#preview-download');
  await expect(app.locator('.toast').last()).toContainText('Saved to Download/Chronicle/todo.txt');
  await app.click('#preview-saveas');
  await expect(app.locator('.toast').last()).toContainText('Saved todo.txt');
  const saved = await app.evaluate(() => globalThis.__saved);
  expect(saved.map((s) => s.how)).toEqual(['downloads', 'as']);
  expect(saved[0]).toMatchObject({ name: 'todo.txt', mime: 'text/plain' });
  expect(atob(saved[0].data)).toBe('milk');
});
