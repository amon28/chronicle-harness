import { test, expect, MOCK } from './helpers.js';

// The side menu's usage card folds to one line with a tap on its title, and stays folded (decision 205)
test.use({ appSettings: { workspaceId: 'wrk_test' } });

test('tap the usage title: one line of percentages; tap again: the meters; remembered after a restart', async ({ app }) => {
  // OpenCode Go's usage, from the test server (12 % / 55 % / 30 %)
  await app.addInitScript((u) => (globalThis.__ocmUsageUrl = u), MOCK + '/usage');
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  const box = app.locator('#go-usage');
  await expect(box.locator('.meter')).toHaveCount(3, { timeout: 10000 });
  await box.locator('.go-usage-name').click();
  await expect(box.locator('.meter').first()).toBeHidden();
  await expect(box.locator('.usage-sum')).toHaveText('5h 12% · wk 55% · mo 30%');
  const folded = await box.boundingBox();
  expect(folded.height).toBeLessThan(60); // one line, the chat list gets the room
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await expect(app.locator('#go-usage .usage-sum')).toBeVisible({ timeout: 10000 }); // still folded
  await app.locator('#go-usage .go-usage-name').click();
  await expect(app.locator('#go-usage .meter').first()).toBeVisible();
  await expect(app.locator('#go-usage .usage-sum')).toBeHidden();
});
