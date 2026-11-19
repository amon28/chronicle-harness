import { test, expect } from './helpers.js';
import { installFakeLinux } from './linuxfiles-fake.js';

test.use({ appSettings: { prefs: { tools: true } } });

const titles = (app) => app.locator('#wsm-list .wsm-title');
const open = (app, name) => app.locator('#wsm-list .wsm-row', { hasText: name }).first().locator('.wsm-open').click();
async function goTo(app, path) {
  await app.click('#wsm-goto');
  await app.fill('#text-input', path);
  await app.click('#text-ok');
}

test('Files › Linux files: browse /root read-only, open, copy into the chat; the sign-in folder and keys stay hidden', async ({ app }) => {
  await app.addInitScript(installFakeLinux);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#open-wsm');
  await app.click('#wsm-loc-linux');
  await expect(app.locator('#wsm-note')).toContainText('Read-only');
  await expect(titles(app)).toContainText(['.config', 'demogame', 'keys']); // folders of /root
  // the sign-in folder is not listed
  await open(app, '.config');
  await expect(app.locator('#wsm-crumbs')).toContainText('.config');
  await expect(titles(app)).toHaveText(['git']);
  await app.click('#wsm-back');
  await open(app, 'demogame');
  await expect(titles(app)).toHaveText(['.git', 'node_modules', 'src', 'logo.png', "notes with 'quotes' é.txt", 'README.md']);
  await expect(app.locator('#wsm-list .wsm-row', { hasText: '.git' }).locator('.wsm-sub')).toContainText('KB'); // its size, read by du
  await expect(app.locator('#wsm-list .wsm-row', { hasText: 'src' }).locator('.wsm-sub')).toContainText('2 items');
  // every folder's size too, and the folder's total at the top (decision 192)
  await expect(app.locator('#wsm-list .wsm-row', { hasText: 'src' }).locator('.wsm-sub')).toHaveText(/^2 items · [\d.]+ (B|KB)/);
  await expect(app.locator('#wsm-summary')).toHaveText(/^3 folders · 3 files · [\d.]+ KB$/);
  // …counted in a shell of their own: opening the next folder never waits for a count (decision 193)
  const shells = await app.evaluate(() => globalThis.__linuxCalls);
  expect(shells.filter((c) => c.op === 'du').map((c) => c.id)).toEqual(expect.arrayContaining(['files-sizes']));
  expect(shells.filter((c) => c.op === 'du').every((c) => c.id === 'files-sizes')).toBe(true);
  expect(shells.filter((c) => c.op === 'list').every((c) => c.id === 'files-browser')).toBe(true);
  // .git is not opened by a plain tap
  await open(app, '.git');
  await expect(app.locator('#choose-title')).toHaveText('Open .git?');
  await app.locator('#choose-list .menu-item', { hasText: 'Stay here' }).click();
  await expect(app.locator('#wsm-crumbs')).not.toContainText('.git');
  // a text file in the viewer: read-only, with Copy into this chat
  await open(app, 'README.md');
  await expect(app.locator('#preview-title')).toHaveText('/root/demogame/README.md');
  await expect(app.locator('#preview-body')).toContainText('A game.');
  await expect(app.locator('#preview-delete')).toBeHidden();
  await expect(app.locator('#preview-html')).toBeHidden();
  await app.click('#preview-tochat');
  await expect(app.locator('#text-input')).toHaveValue('README.md');
  await app.fill('#text-input', 'astral/README.md');
  await app.click('#text-ok');
  await expect(app.locator('#toast')).toContainText('Copied into this chat as astral/README.md');
  await app.click('#preview-sheet [data-close]');
  // odd names work
  await open(app, 'notes with');
  await expect(app.locator('#preview-body')).toContainText('odd name works');
  await app.click('#preview-sheet [data-close]');
  // a picture shows its thumbnail, read when its tile comes into view
  await expect(app.locator('#wsm-list .wsm-row', { hasText: 'logo.png' }).locator('img.wsm-thumb')).toHaveAttribute('src', /^blob:/);
  // code is highlighted in the viewer
  await open(app, 'src');
  await open(app, 'main.js');
  await expect(app.locator('#preview-body .hljs-keyword').first()).toHaveText('export');
  await app.click('#preview-sheet [data-close]');
  await app.click('#wsm-back');
  // a whole folder (no .git / node_modules inside it here), by selecting it
  await app.click('#wsm-select');
  await app.locator('#wsm-list .wsm-row', { hasText: 'src' }).locator('input').check();
  await app.click('#wsm-tochat');
  await expect(app.locator('#text-input')).toHaveValue('src');
  await app.click('#text-ok');
  await expect(app.locator('#toast')).toContainText('Copied 2 files into this chat');
  // the sign-in folder cannot be reached by typing its path either
  await goTo(app, '/root/.config/chronicle');
  await expect(app.locator('#toast')).toContainText('private to the app');
  await goTo(app, '~/demogame/../.config/chronicle/gh-token');
  await expect(app.locator('#toast')).toContainText('private to the app');
  // a private key is never shown, whatever its name
  await goTo(app, '/root/keys');
  await expect(titles(app)).toHaveText(['deploy']);
  await open(app, 'deploy');
  await expect(app.locator('#preview-body')).toContainText('private key – not shown');
  await expect(app.locator('#preview-body')).not.toContainText('BEGIN');
  await expect(app.locator('#preview-actions')).toBeHidden();
  await app.click('#preview-sheet [data-close]');
  // the copies are in this chat's workspace
  await app.click('#wsm-loc-ws');
  await app.click('#wsm-sheet [data-close]');
  await app.click('#files-btn');
  await expect(app.locator('#ws-list')).toContainText('README.md');
  await expect(app.locator('#ws-list')).toContainText('main.js');
  const calls = await app.evaluate(() => globalThis.__linuxCalls);
  // its own shells – one to list and read, one to count sizes (decision 193): a busy chat shell does not block it
  expect(calls.every((c) => ['files-browser', 'files-sizes', 'reaper'].includes(c.id))).toBe(true);
  expect(Object.keys(await app.evaluate(() => Object.fromEntries(Object.entries(globalThis.__linuxDisk).map(([k, v]) => [k, v.length]))))).toContain('/root/.config/chronicle/gh-token'); // nothing was deleted
});

test('Files: grid or list (remembered), long press selects, path bar goes up', async ({ app }) => {
  await app.evaluate(async () => {
    const put = (store, v) => new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => { const t = r.result.transaction(store, 'readwrite'); t.objectStore(store).put(v); t.oncomplete = res; }; });
    const enc = (s) => new TextEncoder().encode(s);
    await put('conversations', { id: 'gc1', title: 'Grid chat', createdAt: 1, updatedAt: 5, personaId: 'general', messages: [{ role: 'user', content: 'hi', at: 1 }] });
    await put('workspaces', { id: 'gc1', files: { 'docs/a.md': { data: enc('a'), mtime: Date.now() }, 'b.txt': { data: enc('bb'), mtime: Date.now() } } });
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#open-wsm');
  await expect(app.locator('#wsm-list')).toHaveClass(/grid/);
  await expect(app.locator('#wsm-loc-linux')).toBeHidden(); // no Linux installed here
  await open(app, 'Grid chat');
  await expect(titles(app)).toHaveText(['docs', 'b.txt']);
  await app.click('#wsm-view');
  await expect(app.locator('#wsm-list')).not.toHaveClass(/grid/);
  // long press (a context-menu press) starts selecting with that file
  await app.locator('#wsm-list .wsm-row', { hasText: 'b.txt' }).locator('.wsm-open').click({ button: 'right' });
  await expect(app.locator('#wsm-count')).toContainText('1 file selected');
  // the selection bar is under the list, not over it, and on screen (decision 192)
  const lb = await app.locator('#wsm-list').boundingBox();
  const bb = await app.locator('#wsm-bar').boundingBox();
  expect(bb.y).toBeGreaterThanOrEqual(lb.y + lb.height - 1);
  expect(bb.y + bb.height).toBeLessThanOrEqual((await app.evaluate(() => innerHeight)) + 1);
  await app.click('#wsm-select');
  await open(app, 'docs');
  await expect(app.locator('#wsm-crumbs')).toContainText('docs');
  await app.click('#wsm-back');
  await expect(titles(app)).toHaveText(['docs', 'b.txt']);
  await app.click('#wsm-back');
  await expect(titles(app)).toContainText(['Grid chat']);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#open-wsm');
  await expect(app.locator('#wsm-list')).not.toHaveClass(/grid/); // the list view was remembered
});

test.describe('at the largest text size', () => {
  test.use({ appSettings: { prefs: { tools: true, textSize: 'xl' } } });
  test('a long file path wraps in the viewer title (✕ stays on screen); the selection bar buttons are one size', async ({ app }) => {
    await app.addInitScript(installFakeLinux);
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.click('#menu-btn');
    await app.click('#open-wsm');
    await app.click('#wsm-loc-linux');
    await open(app, 'demogame');
    await open(app, 'README.md');
    await expect(app.locator('#preview-title')).toHaveText('/root/demogame/README.md');
    const vw = app.viewportSize().width;
    const close = await app.locator('#preview-sheet [data-close]').boundingBox();
    expect(close.x + close.width).toBeLessThanOrEqual(vw);
    const title = await app.locator('#preview-title').boundingBox();
    expect(title.x + title.width).toBeLessThanOrEqual(close.x);
    await app.click('#preview-sheet [data-close]');
    // a chat's files: select one – Download, Share and Delete are the same height
    await app.evaluate(async () => {
      const put = (store, v) => new Promise((res) => { const r = indexedDB.open('chronicle', 3); r.onsuccess = () => { const t = r.result.transaction(store, 'readwrite'); t.objectStore(store).put(v); t.oncomplete = res; }; });
      await put('conversations', { id: 'xl1', title: 'XL chat', createdAt: 1, updatedAt: 5, personaId: 'general', messages: [{ role: 'user', content: 'hi', at: 1 }] });
      await put('workspaces', { id: 'xl1', files: { 'b.txt': { data: new TextEncoder().encode('bb'), mtime: Date.now() } } });
    });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.click('#menu-btn');
    await app.click('#open-wsm');
    await app.click('#wsm-loc-ws');
    await open(app, 'XL chat');
    await app.locator('#wsm-list .wsm-row', { hasText: 'b.txt' }).locator('.wsm-open').click({ button: 'right' });
    await expect(app.locator('#wsm-bar')).toBeVisible();
    const h = async (id) => (await app.locator(id).boundingBox()).height;
    expect(Math.abs((await h('#wsm-del')) - (await h('#wsm-download')))).toBeLessThan(2);
  });
});
