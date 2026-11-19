import { test, expect, send, lastRequest } from './helpers.js';
import { fileURLToPath } from 'node:url';

const card = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url));

test.describe('choice chips', () => {
  test.use({ appSettings: { prefs: { rpChoices: true } } });
  test('a roleplay reply offers choices as buttons; tapping one sends it', async ({ app, request }) => {
    await app.click('#menu-btn');
    await app.click('#open-personas');
    await app.setInputFiles('#card-file', card);
    await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
    await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
    await app.click('.persona-pick:has-text("Seraphina")');
    await app.click('#cv-chat');
    await send(app, 'I knock on the door');
    const reply = app.locator('.msg.assistant').last();
    await expect(reply).toContainText('The door creaks open');
    await expect(reply.locator('.md')).not.toContainText('Step inside'); // the block itself is hidden
    await expect(reply.locator('.choice')).toHaveText(['Step inside', '*Run* away']);
    await reply.locator('.choice', { hasText: 'Step inside' }).click();
    await expect(app.locator('.msg.user').last()).toContainText('Step inside');
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });
    const req = await lastRequest(request);
    expect(req.messages.some((m) => m.role === 'assistant' && /<choices>/.test(m.content))).toBe(false); // not sent back
    await expect(app.locator('.choice')).toHaveCount(0); // only the newest reply has them
  });
});
