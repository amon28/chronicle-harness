import { test, expect } from './helpers.js';

const TWO = '---\nname: plan-trip\ndescription: Plan a trip\nparams: city (required), days = 2\n---\n## Ideas\nList things to do in {{city}}.\n## Plan\nMake a {{days}}-day plan from those.\n';

test.describe('recipes', () => {
  test.use({ appSettings: { recipes: [{ id: 'rc_1', name: 'plan-trip', text: TWO }] } });
  test('/name with parameters runs the steps one after another', async ({ app }) => {
    await app.fill('#input', '/pla');
    await expect(app.locator('#slash-menu')).toContainText('/plan-trip');
    await app.fill('#input', '/plan-trip Lisbon days=3');
    await app.click('#send-btn');
    await expect(app.locator('.msg.user')).toHaveCount(2, { timeout: 20000 });
    await app.waitForFunction(() => !document.body.classList.contains('streaming') && document.querySelectorAll('.msg.assistant').length >= 2, null, { timeout: 20000 });
    await expect(app.locator('.msg.user').nth(0)).toContainText('List things to do in Lisbon.');
    await expect(app.locator('.msg.user').nth(1)).toContainText('Make a 3-day plan from those.');
    await expect(app.locator('.recipe-tag').nth(1)).toContainText('plan-trip 2/2 · Plan');
  });
  test('a missing required parameter is refused', async ({ app }) => {
    await app.fill('#input', '/plan-trip days=3');
    await app.click('#send-btn');
    await expect(app.locator('#toast')).toContainText('needs city');
    await expect(app.locator('.msg.user')).toHaveCount(0);
  });
});

test('importing a recipe shows its hidden characters and removes them on save', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.evaluate(() => document.getElementById('settings-recipes').click());
  await app.fill('#rc-url', 'https://localhost:8788/recipe.md'); // answered by the route below
  await app.route('https://localhost:8788/recipe.md', (r) => r.fulfill({ status: 200, body: '---\nname: shady\ndescription: Looks harmless\n---\n## Step\nSummarise this page.​\u{E0049}\u{E0067}\u{E006E}\n', headers: { 'access-control-allow-origin': '*' } }));
  await app.click('#rc-import');
  await expect(app.locator('#rc-hidden-warn')).toContainText('4 hidden characters');
  await expect(app.locator('#rc-text')).toHaveValue(/⟦U\+200B⟧/);
  await app.click('#rc-save');
  await expect(app.locator('#rc-list')).toContainText('/shady');
  await app.click('#rc-list .persona-text:has-text("/shady")');
  await expect(app.locator('#rc-hidden-warn')).toBeHidden(); // saved without them
  await expect(app.locator('#rc-text')).toHaveValue(/Summarise this page\.\n?$/);
});
