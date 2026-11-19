import { test, expect } from './helpers.js';

// Settings › Account & models: OpenCode Go and the on-device model are folded cards like Claude Code's
const openAccount = async (app) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="account"]');
};

test('with a key saved the OpenCode Go card is folded and says so; it opens on a tap', async ({ app }) => {
  await openAccount(app);
  const card = app.locator('#ocg-box');
  await expect(card).not.toHaveAttribute('open', '');
  await expect(card.locator('summary')).toContainText('Key saved');
  await expect(app.locator('#api-key')).toBeHidden();
  await card.locator('summary').click();
  await expect(app.locator('#api-key')).toBeVisible();
  await expect(app.locator('#workspace-id')).toBeVisible();
  // the on-device model is a card too, folded
  await expect(app.locator('#local-box summary')).toContainText('On-device model');
  await expect(app.locator('#pref-local')).toBeHidden();
  await app.click('#local-box summary');
  await expect(app.locator('#pref-local')).toBeVisible();
  // the fallback is for every model, outside the cards
  await expect(app.locator('#pref-fallback')).toBeVisible();
});

test.describe('no key yet', () => {
  test.use({ appSettings: { apiKey: '' } });
  test('the OpenCode Go card opens by itself', async ({ app }) => {
    // (no key: Settings opens on this page; its button is clicked directly – a normal click did not settle in this state)
    await app.evaluate(() => document.querySelector('#open-settings').click());
    await expect(app.locator('.set-page[data-page="account"]')).toBeVisible();
    await expect(app.locator('#ocg-box')).toHaveAttribute('open', '');
    await expect(app.locator('#ocg-sum')).toContainText('No key yet');
    await expect(app.locator('#api-key')).toBeVisible();
  });
});

test('searching Settings for a field inside a folded card opens the card', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.fill('#set-search', 'Workspace ID');
  await app.click('#set-results .set-result >> nth=0');
  await expect(app.locator('#ocg-box')).toHaveAttribute('open', '');
  await expect(app.locator('#workspace-id')).toBeVisible();
});
