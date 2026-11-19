import { test, expect, send } from './helpers.js';
import { fileURLToPath } from 'node:url';

test("storage view shows what's using space, and full art can be removed", async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url)));
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await send(app, 'A message to make a saved chat');

  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="data"]');
  await app.click('#storage-show');
  const view = app.locator('#storage-view');
  await expect(view).toContainText('in total');
  await expect(view.locator('summary', { hasText: 'Chats (1)' })).toBeVisible();
  const artGroup = view.locator('.storage-group', { hasText: 'Full-size character art (1)' });
  await artGroup.locator('summary').click();
  await expect(artGroup.locator('.storage-row')).toContainText('Seraphina');
  app.once('dialog', (d) => d.accept());
  await artGroup.locator('button:has-text("Remove art")').click();
  await expect(view.locator('summary', { hasText: 'Full-size character art (0)' })).toBeVisible();
  // the avatar is still there
  const hasArt = await app.evaluate(() => new Promise((r) => {
    const q = indexedDB.open('chronicle');
    q.onsuccess = () => {
      const g = q.result.transaction('kv').objectStore('kv').get('settings');
      g.onsuccess = () => r(g.result.personas.find((p) => p.name === 'Seraphina'));
    };
  }));
  expect(hasArt.hasArt).toBeFalsy();
  expect(hasArt.avatar.image).toMatch(/^data:image/);
});
