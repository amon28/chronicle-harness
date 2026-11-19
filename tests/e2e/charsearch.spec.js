import { test, expect } from './helpers.js';

const ch = (id, name, tags = []) => ({ id, name, rp: true, cardMode: true, prompt: `You are ${name}.`, description: `${name} the character`, avatar: { emoji: '🎭', bg: '#333' }, card: { name, description: name, tags, first_mes: `Hi, I am ${name}.` } });
const PERSONAS = [ch('c_zed', 'Zed', ['knight']), ch('c_amy', 'Amy', ['elf', 'princess']), ch('c_mo', 'Mo', ['pirate']), ch('c_kai', 'Kai', ['elf'])];
const conv = (id, pid, t) => ({ id, title: `Chat ${pid}`, createdAt: t, updatedAt: t, personaId: pid, messages: [{ role: 'user', content: 'Hello', at: t }] });

test.use({ appSettings: { personas: PERSONAS, prefs: { mode: 'rp' } } });

test('Roleplay start screen: search by name or tag, and sort (remembered)', async ({ app }) => {
  await app.evaluate(
    (convs) =>
      new Promise((resolve) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => {
          const t = q.result.transaction('conversations', 'readwrite');
          convs.forEach((c) => t.objectStore('conversations').put(c));
          t.oncomplete = resolve;
        };
      }),
    [conv('k1', 'c_mo', 5000), conv('k2', 'c_mo', 4000), conv('k3', 'c_kai', 9000)],
  );
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#drawer-new');
  const names = () => app.locator('.char-grid .persona-pick[data-pid]:visible .cc-title').allTextContents();
  await expect(app.locator('.char-search')).toBeVisible();
  // the same search field as the side menu's and Files' (a drawn magnifier, no colour 🔍 emoji in the placeholder)
  await expect(app.locator('.char-search')).toHaveClass(/search-field/);
  expect(await app.locator('.char-search').getAttribute('placeholder')).not.toMatch(/\p{Extended_Pictographic}/u);
  // search: by tag, by name, several words
  await app.fill('.char-search', 'elf');
  await expect.poll(names).toEqual(expect.arrayContaining(['Amy', 'Kai']));
  expect((await names()).length).toBe(2);
  await app.fill('.char-search', 'elf princess');
  await expect.poll(names).toEqual(['Amy']);
  await app.fill('.char-search', 'nobody');
  await expect(app.locator('.char-none')).toContainText('No character matches');
  await app.fill('.char-search', '');
  // sort
  await app.selectOption('.char-sort', 'name');
  await expect.poll(async () => (await names()).filter((n) => ['Amy', 'Kai', 'Mo', 'Zed'].includes(n))).toEqual(['Amy', 'Kai', 'Mo', 'Zed']);
  await app.selectOption('.char-sort', 'chats');
  await expect.poll(async () => (await names()).slice(0, 2)).toEqual(['Mo', 'Kai']);
  await app.selectOption('.char-sort', 'recent');
  await expect.poll(async () => (await names()).slice(0, 2)).toEqual(['Kai', 'Mo']);
  await expect(app.locator('.char-grid')).toHaveClass(/no-drag/);
  // remembered after a restart
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#drawer-new');
  await expect(app.locator('.char-sort')).toHaveValue('recent');
});
