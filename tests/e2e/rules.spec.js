import { test, expect, send, lastRequest } from './helpers.js';

test('regex scripts: a "saved" rule changes the reply that is stored; a "shown" rule only what you see', async ({ app, request }) => {
  await app.evaluate(() => document.querySelector('#open-settings').click());
  await app.evaluate(() => document.querySelector('#open-regex').click());
  await expect(app.locator('#rules-title')).toHaveText('🔁 Regex scripts');
  await app.click('#rules-add');
  const card = app.locator('.rule-card').first();
  await card.locator('input[placeholder^="Find"]').fill('Reply');
  await card.locator('input[placeholder^="Replace"]').fill('Answer');
  await card.locator('input[placeholder^="Try it"]').fill('Reply #9');
  await expect(card.locator('.rule-preview')).toHaveText('→ Answer #9');
  await app.click('#rules-add');
  const shown = app.locator('.rule-card').nth(1);
  await shown.locator('input[placeholder^="Find"]').fill('/#(\\d)/');
  await shown.locator('input[placeholder^="Replace"]').fill('number $1');
  await shown.locator('select').first().selectOption('display');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await send(app, 'hello');
  await expect(app.locator('.msg.assistant:last-child .md')).toContainText('Answer number 1');
  // the next request carries the saved change but not the display-only one
  await send(app, 'again');
  const req = await lastRequest(request);
  expect(JSON.stringify(req.messages)).toContain('Answer #1');
});

test('hooks: the editor adds a hook with an event and a tool filter', async ({ app }) => {
  await app.evaluate(() => document.querySelector('#open-settings').click());
  await app.evaluate(() => document.querySelector('#open-hooks').click());
  await expect(app.locator('#rules-title')).toHaveText('🪝 Hooks');
  await expect(app.locator('#rules-list')).toContainText('Examples');
  await app.click('#rules-add');
  const card = app.locator('.rule-card').first();
  await expect(card.locator('input[placeholder^="Tools"]')).toBeVisible();
  await card.locator('select').first().selectOption('stop');
  await expect(card.locator('input[placeholder^="Tools"]')).toBeHidden();
  await card.locator('textarea').fill('npm test');
});
