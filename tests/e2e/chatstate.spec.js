import { test, expect, send } from './helpers.js';

test('each chat keeps its own half-typed message', async ({ app }) => {
  await send(app, 'first chat');
  await app.fill('#input', 'draft for chat one');
  await app.click('#menu-btn');
  await app.click('#drawer-new');
  await expect(app.locator('#input')).toHaveValue(''); // the new chat starts with an empty box
  await send(app, 'second chat');
  await app.fill('#input', 'draft for chat two');
  await app.click('#menu-btn');
  await app.click('.conv-item:has-text("first chat")');
  await expect(app.locator('#input')).toHaveValue('draft for chat one');
  await app.click('#menu-btn');
  await app.click('.conv-item:has-text("second chat")');
  await expect(app.locator('#input')).toHaveValue('draft for chat two');
});
