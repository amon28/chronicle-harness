import { test, expect } from './helpers.js';
import { fileURLToPath } from 'node:url';

const card = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url));

test('tapping a roleplay character opens its page (like Chub), with Chat, Edit and the card details', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  await expect(app.locator('#char-sheet')).toHaveClass(/open/);
  await expect(app.locator('#cv-title')).toHaveText('Seraphina');
  await expect(app.locator('#cv-chat')).toHaveText(/Chat with Seraphina/);
  await expect(app.locator('.cv-art')).toBeVisible();
  await expect(app.locator('.cv-pill').first()).toContainText('tokens');
  // the card's sections are there, folded
  const defs = app.locator('.cv-section', { hasText: 'Definitions' });
  await expect(defs).toBeVisible();
  await defs.locator('summary').click();
  await expect(defs.locator('.cv-field').first()).toBeVisible();
  await expect(app.locator('.cv-section', { hasText: 'Greetings' })).toBeVisible();
  // nothing started yet; "Chat with" starts the roleplay with its greeting
  await expect(app.locator('.msg.assistant')).toHaveCount(0);
  await app.click('#cv-chat');
  await expect(app.locator('#char-sheet')).not.toHaveClass(/open/);
  await expect(app.locator('.msg.assistant').first()).toContainText('Seraphina');
});

test.describe('at the largest text size', () => {
  test.use({ appSettings: { prefs: { textSize: 'xl' } } });
  test("the character page's buttons wrap onto a second line instead of running off the sheet", async ({ app }) => {
    await app.click('#menu-btn');
    await app.click('#open-personas');
    await app.setInputFiles('#card-file', card);
    await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
    await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
    await app.click('.persona-pick:has-text("Seraphina")');
    await expect(app.locator('#char-sheet')).toHaveClass(/open/);
    const vw = app.viewportSize().width;
    for (const b of await app.locator('#char-sheet .ghost-btn', { hasText: /Edit|Export|Import chat|Group chat/ }).all()) {
      const r = await b.boundingBox();
      expect(r.x + r.width, await b.textContent()).toBeLessThanOrEqual(vw);
    }
  });
});
