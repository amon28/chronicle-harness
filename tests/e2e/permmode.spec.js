import { test, expect, lastRequest } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

test('one switch: Ask first makes every change wait for an OK; Plan turns plan mode on', async ({ app, request }) => {
  await expect(app.locator('#mode-btn')).toHaveText('⚡ Auto');
  await app.click('#mode-btn');
  await app.locator('#perm-options .menu-item[data-perm="ask"]').click();
  await expect(app.locator('#mode-btn')).toHaveText('🛡 Ask first');
  await app.fill('#input', 'PATCHME please');
  await app.click('#send-btn');
  await expect(app.locator('#ask-question')).toContainText('Allow ✏️ Write files');
  // every change in the turn asks (the patch after the write too); say no to each
  for (let i = 0; i < 10 && (await app.evaluate(() => document.body.classList.contains('streaming'))); i++) {
    const deny = app.locator('#ask-options button', { hasText: 'Deny' });
    if (await deny.isVisible().catch(() => false)) await deny.click();
    await app.waitForTimeout(300);
  }
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  const req = await lastRequest(request);
  expect(req.messages.filter((m) => m.role === 'tool')[0].content).toContain('The user did not allow this write_file call');
  await app.click('#mode-btn');
  await app.locator('#perm-options .menu-item[data-perm="plan"]').click();
  await expect(app.locator('#mode-btn')).toHaveText('📋 Plan');
});
