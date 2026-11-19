import { test, expect } from './helpers.js';

test('ⓘ next to a setting explains it, names the fast model, and does not toggle the setting', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="rp"]');
  await app.locator('#pref-tracker').scrollIntoViewIfNeeded();
  const before = await app.isChecked('#pref-tracker');
  const btn = app.locator('.info-btn[data-info="tracker"]');
  await btn.click();
  await expect(app.locator('.info-pop')).toContainText('scene sheet');
  await expect(app.locator('.info-pop')).toContainText('small request asks');
  expect(await app.isChecked('#pref-tracker')).toBe(before); // the tap did not reach the checkbox
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  // a tap outside closes it
  await app.locator('.set-page[data-page="rp"] h3.section').first().click({ force: true });
  await expect(app.locator('.info-pop')).toHaveCount(0);
  // the story-memory model: which one, in words
  const fast = app.locator('.info-btn[data-info="fast-model"]');
  await fast.scrollIntoViewIfNeeded();
  await fast.click();
  await expect(app.locator('.info-pop')).toContainText('Right now:');
  await expect(app.locator('.info-pop')).toContainText('Flash');
  await fast.click(); // the same ⓘ again closes it
  await expect(app.locator('.info-pop')).toHaveCount(0);
});
