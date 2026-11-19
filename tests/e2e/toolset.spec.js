import { test, expect, send, lastRequest } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

test('a persona\'s toolset: only its tool groups are sent', async ({ app, request }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-list .persona-item:has-text("Assistant")');
  await app.click('#pe-tools-box summary');
  await app.click('#pe-toolset-presets [data-preset="research"]'); // web + files + helpers
  await expect(app.locator('#pe-tools-sum')).toContainText('3 of');
  await app.click('#pe-save');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await send(app, 'hello');
  const names = (await lastRequest(request)).tools.map((t) => t.function.name);
  expect(names).toContain('web_search');
  expect(names).toContain('read_file');
  expect(names).not.toContain('run_python');
  expect(names).not.toContain('search_chats');
});

test('single tools: a light persona keeps one tool of a group that is off, and loses one that is always there', async ({ app, request }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-list .persona-item:has-text("Assistant")');
  await app.click('#pe-tools-box summary');
  await app.click('#pe-toolset-presets [data-preset="none"]');
  // the Autonomy group is off: give it search_chats alone
  const auto = app.locator('#pe-toolset .toolset-tools[data-group="autonomy"]');
  await auto.locator('summary').click();
  await expect(auto.locator('summary')).toContainText('0 of');
  await auto.locator('input[data-tool="search_chats"]').check();
  await expect(auto.locator('summary')).toContainText('1 of');
  await expect(auto.locator('summary')).toContainText('given one by one');
  // memory is in every chat: take it away
  const base = app.locator('#pe-toolset .toolset-tools[data-group="base"]');
  await base.locator('summary').click();
  await base.locator('input[data-tool="memory"]').uncheck();
  await expect(app.locator('#pe-tools-sum')).toContainText('+1 −1 single');
  await app.click('#pe-save');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await send(app, 'hello');
  const names = (await lastRequest(request)).tools.map((t) => t.function.name);
  expect(names).toContain('search_chats');
  expect(names).not.toContain('read_chat'); // only the one given, not its whole group
  expect(names).not.toContain('memory');
  expect(names).not.toContain('web_search');
  // the editor shows it again as it was saved
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-list .persona-item:has-text("Assistant")');
  await app.click('#pe-tools-box summary');
  await expect(app.locator('#pe-tools-sum')).toContainText('+1 −1 single');
});
