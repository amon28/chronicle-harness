import { test, expect, send, MOCK } from './helpers.js';
import { devices } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const card = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url));

async function seed(page, convs) {
  await page.evaluate(
    (convs) =>
      new Promise((resolve) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => {
          const t = q.result.transaction('conversations', 'readwrite');
          convs.forEach((c) => t.objectStore('conversations').put(c));
          t.oncomplete = resolve;
        };
      }),
    convs,
  );
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
}
const now = new Date();
const daysAgo = (n, h = 10) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, h).getTime();
const chat = (id, title, updatedAt) => ({ id, title, createdAt: updatedAt, updatedAt, personaId: 'assistant', messages: [{ role: 'user', content: 'hi ' + title }, { role: 'assistant', content: 'hello', personaId: 'assistant' }] });
const dated = () => [
  chat('t', 'Today chat', Math.max(daysAgo(0, 0) + 60_000, Date.now() - 60_000)),
  chat('y', 'Yesterday chat', daysAgo(1)),
  chat('w', 'This week chat', daysAgo(4)),
  chat('m', 'This month chat', daysAgo(15)),
  chat('o', 'Older month chat', daysAgo(45)),
  chat('old', 'Years ago chat', daysAgo(800)),
  ...Array.from({ length: 24 }, (_, i) => chat('f' + i, `Filler ${i}`, daysAgo(16 + i))),
];

test('the drawer groups chats by when they were used, with a quiet time on each row and sticky headers', async ({ app }) => {
  await seed(app, dated());
  await app.click('#menu-btn');
  const heads = app.locator('#conv-list .conv-when');
  const labels = await heads.allTextContents();
  expect(labels.slice(0, 4)).toEqual(['Today', 'Yesterday', '7 Days', '30 Days']);
  expect(labels.slice(4, -1).every((l) => /^[A-Z][a-z]{2,4}\.? \d{4}$/.test(l))).toBe(true); // "Oct 2026"
  expect(labels.at(-1)).toBe(String(new Date(daysAgo(800)).getFullYear()));
  // each chat under its own header
  const order = await app.locator('#conv-list :is(.conv-when, .conv-item)').evaluateAll((els) => els.map((e) => (e.classList.contains('conv-when') ? '#' + e.textContent : e.querySelector('.conv-name')?.textContent)));
  expect(order.indexOf('Yesterday chat')).toBe(order.indexOf('#Yesterday') + 1);
  expect(order.indexOf('This week chat')).toBe(order.indexOf('#7 Days') + 1);
  expect(order.indexOf('Years ago chat')).toBe(order.length - 1);
  // a time on each row: hh:mm today, a weekday this week
  await expect(app.locator('.conv-item:has-text("Today chat") .conv-time')).toHaveText(/\d{1,2}[:.]\d\d/);
  await expect(app.locator('.conv-item:has-text("This week chat") .conv-time')).toHaveText(/^[A-Z][a-z]{1,3}\.?$/);
  // headers stick flush to the top of the list while it scrolls (no strip of rows above them)
  const stuck = await app.evaluate(async () => {
    const list = document.querySelector('#conv-list');
    list.scrollTop = 600;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const top = list.getBoundingClientRect().top;
    // the header that is stuck covers the list's top edge (nothing of the rows under it shows above it)
    return [...list.querySelectorAll('.conv-when')].filter((h) => {
      const r = h.getBoundingClientRect();
      return r.top <= top + 0.01 && r.bottom > top + 10;
    }).length;
  });
  expect(stuck).toBe(1);
  // search still shows its own results, and the groups come back
  await app.fill('#conv-search', 'week chat');
  await expect(app.locator('.search-hit-item')).toHaveCount(1);
  await app.fill('#conv-search', '');
  await expect(heads.first()).toHaveText('Today');
});

test.describe('small phone, largest text', () => {
  test.use({ viewport: { width: 360, height: 760 }, appSettings: { prefs: { textSize: 'xl' } } });
  test('rows keep the name, the time and the ⋮ button inside the drawer', async ({ app }) => {
    await seed(app, [{ ...chat('long', 'A very long chat name that will not fit on one line at all', Date.now() - 60_000), pinned: true, pinnedAt: 1 }, ...dated().slice(0, 6)]);
    await app.click('#menu-btn');
    const bad = await app.evaluate(() => {
      const list = document.querySelector('#conv-list');
      const out = [];
      if (list.scrollWidth > list.clientWidth + 1) out.push('list scrolls sideways');
      for (const row of list.querySelectorAll('.conv-item')) {
        const r = row.getBoundingClientRect();
        const time = row.querySelector('.conv-time')?.getBoundingClientRect();
        const more = row.querySelector('.conv-more').getBoundingClientRect();
        const name = row.querySelector('.conv-name').getBoundingClientRect();
        if (!time || time.width < 10) out.push('no time: ' + row.textContent);
        else if (time.right > more.left + 0.5 || name.right > time.left + 0.5 || more.right > r.right + 0.5) out.push('overlap: ' + row.textContent);
      }
      return out;
    });
    expect(bad).toEqual([]);
  });
});

test.use({ acceptDownloads: true });

/** Another phone: a fresh browser with nothing in it but the API settings. */
async function otherPhone(browser, testInfo) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], baseURL: testInfo.project.use.baseURL, acceptDownloads: true });
  const page = await ctx.newPage();
  const seedSettings = { apiKey: 'good', proxyUrl: MOCK, model: 'glm-5.3', prefs: { learn: false, autoTitle: false, tools: false, userName: 'Sam' } };
  await page.addInitScript((s) => {
    if (!localStorage.getItem('ocm.settingsInIdb') && !localStorage.getItem('ocm.settings')) localStorage.setItem('ocm.settings', JSON.stringify(s));
  }, seedSettings);
  await page.goto('/');
  await page.waitForSelector('body[data-ready="1"]');
  return { ctx, page };
}

test('export a roleplay as a Chronicle chat and import it on a phone without the character', async ({ app, browser }, testInfo) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await send(app, 'Where am I?');

  // ⋮ › More › Export chat… › Chronicle chat (.json)
  await app.click('#chat-more-btn');
  await app.click('#cm-more');
  await app.click('#cm-export');
  await expect(app.locator('#cm-export-json')).toContainText('Imports back with its character');
  await expect(app.locator('#cm-export-box')).toContainText('workspace files');
  // where to import now (the side menu's ⤵ is gone), and no colour emoji left among the line icons
  await expect(app.locator('#cm-export-box')).toContainText("Import chat on a character's page");
  await expect(app.locator('#cm-export-box')).not.toContainText('next to the search');
  const raw = await app.evaluate(() => {
    const c = document.querySelector('#cm-export-box').cloneNode(true);
    c.querySelectorAll('.ic-e').forEach((x) => x.remove()); // the hidden emoji behind a drawn icon
    return c.textContent.match(/\p{Extended_Pictographic}/gu) || [];
  });
  expect(raw).toEqual([]);
  const [dl] = await Promise.all([app.waitForEvent('download'), app.click('#cm-export-json')]);
  expect(dl.suggestedFilename()).toMatch(/\.chronicle\.json$/);
  const file = testInfo.outputPath(dl.suggestedFilename());
  await dl.saveAs(file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(data).toMatchObject({ format: 'chronicle-chat', version: 1 });
  expect(data.characters.map((p) => p.name)).toEqual(['Seraphina']);
  expect(data.chat.messages.some((m) => m.greeting)).toBe(true);
  expect(data.chat.messages.some((m) => m.content === 'Where am I?')).toBe(true);
  expect(JSON.stringify(data)).not.toMatch(/"apiKey"|"good"/);

  // the other phone has no Seraphina: importing the file (Settings › Data) brings her too
  const { ctx, page } = await otherPhone(browser, testInfo);
  try {
    await page.setInputFiles('#st-file', file);
    await expect(page.locator('#persona-name')).toHaveText('Seraphina');
    await expect(page.locator('.msg.user')).toContainText('Where am I?');
    await expect(page.locator('body')).toHaveClass(/mode-rp/);
    await page.click('#menu-btn');
    await expect(page.locator('.mode-tab.active')).toHaveAttribute('data-mode', 'rp');
    await expect(page.locator('#conv-list .conv-item.active')).toBeVisible();
    await page.click('#open-personas');
    await expect(page.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toHaveCount(1);
  } finally {
    await ctx.close();
  }

  // on this phone, from Seraphina's own page (⤵ Import chat): a second chat with her, still one Seraphina
  await app.evaluate(() => { document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()); if (document.body.classList.contains('drawer-open')) document.getElementById('scrim').click(); });
  await app.click('#menu-btn');
  await app.click('#drawer-new');
  await app.locator('.char-grid .persona-pick[data-pid]', { hasText: 'Seraphina' }).click();
  const [chooser] = await Promise.all([app.waitForEvent('filechooser'), app.click('#cv-import-chat')]);
  await chooser.setFiles(file);
  await expect(app.locator('#persona-name')).toHaveText('Seraphina');
  await expect(app.locator('.msg.user')).toContainText('Where am I?');
  await app.click('#menu-btn');
  await expect(app.locator('#conv-list .conv-item')).toHaveCount(2);
  await app.click('#open-personas');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toHaveCount(1);
  // the chat list has no import button any more (it is on the character's page and in Settings › Data)
  await expect(app.locator('#conv-import')).toHaveCount(0);
});
