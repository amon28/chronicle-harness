import { test, expect } from './helpers.js';

// Roleplay presets: Rename and Delete are disabled for "Standard" but looked exactly like the buttons beside them,
// and Delete (class "danger") was grey like Export.
test('disabled buttons look disabled, and a destructive ghost button is red', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="rppreset"]');
  await expect(app.locator('#rp-preset-rename')).toBeDisabled();
  const look = (sel) => app.locator(sel).evaluate((el) => ({ opacity: Number(getComputedStyle(el).opacity), color: getComputedStyle(el).color }));
  expect((await look('#rp-preset-rename')).opacity).toBeLessThan(0.6);
  expect((await look('#rp-preset-del')).opacity).toBeLessThan(0.6);
  expect((await look('#rp-preset-export')).opacity).toBe(1);
  expect((await look('#rp-preset-del')).color).not.toBe((await look('#rp-preset-export')).color);
  expect((await look('#term-remove')).color).toBe((await look('#rp-preset-del')).color);
});
