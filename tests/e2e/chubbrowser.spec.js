import { test, expect } from './helpers.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const fx = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url));
const b64 = (f) => fs.readFileSync(fx(f)).toString('base64');

// The native Chub browser screen only exists in the Android app; stand in for what it hands back.
async function fakeBrowser(app, items) {
  await app.evaluate((items) => (globalThis.__ocmChubBrowserTest = async (site) => ((globalThis.__sites ||= []).push(site), { items })), items);
}
async function openRoleplayPersonas(app) {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-tabs [data-ptab="rp"]');
}

test('Browse Chub: a downloaded card PNG is imported automatically', async ({ app }) => {
  await app.evaluate(() => (globalThis.__ocmChubBrowserTest = null));
  await app.addInitScript(() => (globalThis.__ocmChubBrowserTest = async () => ({ items: [] })));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await fakeBrowser(app, [{ name: 'seraphina.png', base64: b64('seraphina.png') }]);
  await openRoleplayPersonas(app);
  await expect(app.locator('#chub-browse')).toBeVisible();
  await app.click('#chub-browse');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  // with its full art
  const art = await app.evaluate(() => new Promise((r) => {
    const q = indexedDB.open('chronicle');
    q.onsuccess = () => {
      const g = q.result.transaction('kv').objectStore('kv').getAllKeys();
      g.onsuccess = () => r(g.result.filter((k) => String(k).startsWith('art:')).length);
    };
  }));
  expect(art).toBe(1);
});

test('Browse Chub: a downloaded lorebook JSON goes to Lorebooks; a JSON card becomes a character', async ({ app }) => {
  await app.addInitScript(() => (globalThis.__ocmChubBrowserTest = async () => ({ items: [] })));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  const lore = { name: 'City folk', entries: { 0: { uid: 0, key: ['herald'], content: 'Master Orrin, the herald.', comment: 'Herald', order: 10 } } };
  await fakeBrowser(app, [
    { name: 'city-folk.json', base64: Buffer.from(JSON.stringify(lore)).toString('base64') },
    { name: 'rook.json', base64: b64('rook.json') },
  ]);
  await openRoleplayPersonas(app);
  await app.click('#chub-browse');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Captain Rook' })).toBeVisible();
  await app.click('#open-lorebooks');
  await expect(app.locator('#lb-list')).toContainText('City folk'); // the lorebook's own name
});

test('Browse Chub: "Import this page" hands back a character link, which is downloaded and imported', async ({ app }) => {
  await app.addInitScript(() => (globalThis.__ocmChubBrowserTest = async () => ({ items: [] })));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  let asked = '';
  await app.route('https://avatars.charhub.io/**', (r) => {
    asked = r.request().url();
    r.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(fx('seraphina.png')) });
  });
  await fakeBrowser(app, [{ link: 'https://chub.ai/characters/someone/seraphina-1234' }]);
  await openRoleplayPersonas(app);
  await app.click('#chub-browse');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  expect(asked).toContain('someone/seraphina-1234');
});

test('without the Android app there is no Browse Chub button', async ({ app }) => {
  await openRoleplayPersonas(app);
  await expect(app.locator('#chub-browse')).toBeHidden();
});

test('Browse BotBooru: its downloads are imported the same way', async ({ app }) => {
  await app.addInitScript(() => (globalThis.__ocmChubBrowserTest = async () => ({ items: [] })));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await fakeBrowser(app, [{ name: 'botbooru-123.png', base64: b64('seraphina.png') }]);
  await openRoleplayPersonas(app);
  await expect(app.locator('#botbooru-browse')).toBeVisible();
  await app.click('#botbooru-browse');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  expect(await app.evaluate(() => globalThis.__sites)).toEqual(['botbooru']);
});

test('Browse Character Archive: its downloads are imported the same way', async ({ app }) => {
  await app.addInitScript(() => (globalThis.__ocmChubBrowserTest = async () => ({ items: [] })));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await fakeBrowser(app, [{ name: 'archive-card.png', base64: b64('seraphina.png') }]);
  await openRoleplayPersonas(app);
  await expect(app.locator('#chararc-browse')).toBeVisible();
  await app.click('#chararc-browse');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  expect(await app.evaluate(() => globalThis.__sites)).toEqual(['chararc']);
});

test('pasting a botbooru.com link downloads its card PNG', async ({ app }) => {
  let asked = '';
  await app.route('https://botbooru.com/download/png/**', (r) => {
    asked = r.request().url();
    r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(fx('seraphina.png')) });
  });
  await openRoleplayPersonas(app);
  await app.fill('#chub-url', 'https://botbooru.com/post/4242');
  await app.click('#chub-go');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  expect(asked).toBe('https://botbooru.com/download/png/4242');
});

test('Browse Chub: cards downloaded while the site is open are imported at once, said in its own message bar, one app message at the end', async ({ app }) => {
  await app.addInitScript(() => (globalThis.__ocmChubBrowserTest = async () => ({ items: [] })));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  const card = b64('seraphina.png');
  await app.evaluate((card) => {
    globalThis.__toasts = [];
    new MutationObserver(() => {
      const t = document.querySelector('#toast');
      if (t?.classList.contains('show')) globalThis.__toasts.push(t.textContent);
    }).observe(document.querySelector('#toast'), { attributes: true, childList: true, subtree: true });
    globalThis.__ocmChubBrowserTest = async (site, deliver) => {
      await deliver({ name: 'seraphina.png', base64: card }); // the screen is still open
      await deliver({ name: 'broken.png', base64: btoa('not a card') });
      return { items: [] }; // closed: nothing left to hand back
    };
  }, card);
  await openRoleplayPersonas(app);
  await app.click('#chub-browse');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  const status = await app.evaluate(() => globalThis.__ocmChubStatus);
  expect(status[0]).toBe('Imported Seraphina ✓');
  expect(status[1]).toMatch(/^Couldn't import that/);
  await expect(app.locator('#toast')).toContainText('Imported Seraphina');
  const toasts = [...new Set(await app.evaluate(() => globalThis.__toasts))];
  expect(toasts.filter((t) => /Seraphina/.test(t))).toHaveLength(1); // the app says it once, not per card and again at the end
});
