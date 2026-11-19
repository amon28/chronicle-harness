import { test, expect } from './helpers.js';
import { fileURLToPath } from 'node:url';

const card = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url));

test('edit a card field with AI, then undo', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.locator('#persona-list .persona-item', { hasText: 'Seraphina' }).click();
  await app.click('#ai-edit summary');
  const before = await app.inputValue('#pc-desc');
  await app.fill('#ai-inst', 'more detail about her clothes');
  await app.click('#ai-run');
  await expect(app.locator('#pc-desc')).toHaveValue('EDITED: more detail about her clothes');
  await app.click('#ai-undo');
  await expect(app.locator('#pc-desc')).toHaveValue(before);
});
