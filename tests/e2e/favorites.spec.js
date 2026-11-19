import { test, expect } from './helpers.js';

// Favourite models (decision 176): a ☆ on each model, a "★ Favorites" chip that shows only those, kept across restarts.
test.use({ viewport: { width: 412, height: 860 } });

test('star a model: it stays selected as before, and the Favorites chip lists it', async ({ app }) => {
  await app.click('#model-btn');
  const chip = app.locator('#model-filters .filter-chip.fav');
  await expect(chip).toHaveText('★ Favorites');
  await chip.click();
  await expect(app.locator('#model-list')).toContainText('No favorites yet – tap ☆ on a model to keep it here.');
  await app.locator('#model-filters .filter-chip', { hasText: 'All' }).click();
  const row = app.locator('#model-list .model-item', { hasText: 'DeepSeek V4 Pro' });
  await row.locator('.fav-star').click();
  await expect(app.locator('#model-sheet')).toHaveClass(/open/); // the star does not pick the model
  await expect(app.locator('#model-name')).toHaveText('GLM-5.3');
  await expect(app.locator('#model-list .model-item', { hasText: 'DeepSeek V4 Pro' }).locator('.fav-star')).toHaveText('★');
  await expect(chip).toHaveText('★ Favorites 1');
  await chip.click();
  await expect(app.locator('#model-list .model-item')).toHaveCount(1);
  await expect(app.locator('#model-list .model-item')).toContainText('DeepSeek V4 Pro');
  if (process.env.SHOT) await app.locator('#model-sheet .sheet-card').screenshot({ path: process.env.SHOT });
  // after a restart it is still a favourite; un-starring it empties the list again
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#model-btn');
  await app.locator('#model-filters .filter-chip.fav').click();
  await expect(app.locator('#model-list .model-item')).toHaveCount(1);
  await app.locator('#model-list .model-item .fav-star').click();
  await expect(app.locator('#model-list')).toContainText('No favorites yet');
});
