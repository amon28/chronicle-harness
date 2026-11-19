import { test, expect, send } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

test('↩ Undo file changes puts the files back as they were before the reply', async ({ app }) => {
  await send(app, 'SLOWTOOL write me a file');
  const undo = app.locator('.msg.assistant').last().locator('.act', { hasText: 'Undo 1 file change' });
  await expect(undo).toBeVisible();
  await app.click('#files-btn');
  await expect(app.locator('#ws-list')).toContainText('slow.txt');
  await app.click('#files-sheet [data-close]');
  app.once('dialog', (d) => d.accept());
  await undo.click();
  await expect(app.locator('.msg.assistant').last().locator('.act', { hasText: 'Undo' })).toHaveCount(0);
  await expect(app.locator('#files-btn')).toBeHidden(); // no files left
});
