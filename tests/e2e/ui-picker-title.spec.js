import { test, expect } from './helpers.js';
import { fileURLToPath } from 'node:url';

const card = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url));

// The chat's "🎛 Roleplay preset" dropdown opened a sheet whose title was only the icon.
test('a dropdown whose label starts with an icon still gets its words as the title', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await app.click('#chat-more-btn');
  await app.click('#cm-settings');
  await app.locator('#chat-preset').scrollIntoViewIfNeeded();
  await app.click('#chat-preset');
  await expect(app.locator('#pick-sheet')).toHaveClass(/open/);
  await expect(app.locator('#pick-title')).toContainText('Roleplay preset');
  // a plain label keeps its short title (without the greyed explanation)
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="rppreset"]');
  await app.click('#rp-preset-sel');
  await expect(app.locator('#pick-title')).toHaveText('Preset');
});
