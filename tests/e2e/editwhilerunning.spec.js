import { test, expect } from './helpers.js';

const idle = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
test.use({ appSettings: { model: 'kimi-k3' } });

test('editing your message while a reply runs leaves the reply alone; Cancel keeps it going', async ({ app }) => {
  await app.fill('#input', 'LONGTHINK first');
  await app.click('#send-btn');
  await expect(app.locator('body')).toHaveClass(/streaming/);
  await app.locator('.msg.user').first().locator('button[aria-label="Edit"]').click();
  await expect(app.locator('#edit-bar')).toBeVisible();
  await expect(app.locator('body')).toHaveClass(/streaming/); // still writing
  await app.click('#edit-cancel');
  await idle(app);
  const reply = app.locator('.msg.assistant').last();
  await expect(reply.locator('.msg-cut')).toHaveCount(0); // it finished on its own, not stopped
  await expect(reply).not.toContainText('Stopped');
});

test('sending the edit while a reply runs stops that reply and answers the edited message', async ({ app }) => {
  await app.fill('#input', 'LONGTHINK first');
  await app.click('#send-btn');
  await expect(app.locator('body')).toHaveClass(/streaming/);
  await app.locator('.msg.user').first().locator('button[aria-label="Edit"]').click();
  await app.fill('#input', 'the edited question');
  await app.click('#send-btn');
  await expect(app.locator('.msg.user').last()).toContainText('the edited question', { timeout: 20000 });
  await idle(app);
  await expect(app.locator('.msg.user')).toHaveCount(1); // the edit replaced it (the old one is a version)
});
