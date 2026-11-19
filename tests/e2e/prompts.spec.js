import { test, expect, send, lastRequest } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true, toolWeb: false, toolPython: false } } });

test('built-in prompts can be edited in Settings › Prompts and reset', async ({ app, request }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="prompts"]');
  await expect(app.locator('.prompt-item')).toHaveCount(13); // the Chats tab (the other prompts are on the Roleplay and Group tabs)
  await app.fill('#prompts-search', 'agent');
  const item = app.locator('.prompt-item', { hasText: 'Extra instructions for the agent' });
  await item.locator('summary').click();
  await item.locator('textarea').fill('Always answer in haiku.');
  await expect(item.locator('.badge')).toHaveText('edited');
  await app.waitForTimeout(600);
  await app.evaluate(() => document.querySelectorAll('.sheet.open').forEach((x) => x.querySelector('[data-close]')?.click()));

  await send(app, 'hello');
  expect((await lastRequest(request)).messages[0].content).toContain('Always answer in haiku.');

  // survives a reload, then reset brings the original back
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="prompts"]');
  const again = app.locator('.prompt-item', { hasText: 'Extra instructions for the agent' });
  await expect(again).toHaveClass(/edited/);
  await again.locator('summary').click();
  await again.locator('button:has-text("Reset")').click();
  await expect(again.locator('textarea')).toHaveValue('');
  await app.waitForTimeout(600);
  await app.evaluate(() => document.querySelectorAll('.sheet.open').forEach((x) => x.querySelector('[data-close]')?.click()));
  await send(app, 'again');
  expect((await lastRequest(request)).messages[0].content).not.toContain('haiku');
});

test('shortcuts lead to the roleplay prompts on the Roleplay presets page', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="prompts"]');
  await app.click('#prompts-tabs .insp-tab:has-text("Roleplay")');
  await app.click('.prompt-link:has-text("Post-history")');
  await expect(app.locator('#set-title')).toHaveText('🎛 Roleplay presets');
  await expect(app.locator('#pref-phi')).toBeFocused();
});

test('the drawer has no OpenCode-on-PC button, and the Go usage meter can be hidden', async ({ app }) => {
  await app.click('#menu-btn');
  await expect(app.locator('.drawer-foot #open-pc')).toHaveCount(0);
  await app.click('#open-settings');
  await app.click('.set-item[data-page="connect"]');
  await expect(app.locator('#open-pc')).toBeVisible();
  await app.click('#set-back');
  await app.click('.set-item[data-page="data"]');
  await app.uncheck('#pref-go-usage');
  await app.waitForTimeout(600);
  expect(await app.evaluate(() => document.body.classList.contains('hide-go-usage'))).toBe(true);
});

test('the prompts page has tabs instead of one long list', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="prompts"]');
  await expect(app.locator('#prompts-tabs .insp-tab')).toHaveCount(3);
  const chat = await app.locator('#prompts-list .prompt-item').count();
  await app.click('#prompts-tabs .insp-tab:has-text("Group")');
  const group = await app.locator('#prompts-list .prompt-item').count();
  expect(chat).toBeGreaterThan(0);
  expect(group).toBeGreaterThan(0);
  await expect(app.locator('#prompts-list')).toContainText('Group chat instructions');
  await app.fill('#prompts-search', 'agent');
  await expect(app.locator('#prompts-tabs')).toBeHidden();
});
