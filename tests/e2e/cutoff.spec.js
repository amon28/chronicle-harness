import { test, expect, send } from './helpers.js';

test.describe('auto-continue on (default)', () => {
  test('a reply that hits the length limit is continued automatically', async ({ app }) => {
    await send(app, 'LONGREPLY please');
    const reply = app.locator('.msg.assistant').last();
    await expect(reply).toContainText('The first part of a long reply and here is the rest of it.');
    await expect(app.locator('.msg-cut')).toHaveCount(0);
  });
});

test.describe('auto-continue off', () => {
  test.use({ appSettings: { prefs: { autoContinue: false } } });

  test('shows why a reply was cut off, and Continue finishes it', async ({ app }) => {
    await send(app, 'LONGREPLY please');
    const note = app.locator('.msg-cut');
    await expect(note).toContainText('Cut off – this reply hit its length limit');
    await expect(app.locator('.msg.assistant').last()).toContainText('The first part of a long reply');
    await note.locator('button:has-text("Continue")').click();
    await app.waitForFunction(() => !document.body.classList.contains('streaming'));
    await expect(app.locator('.msg.assistant').last()).toContainText('The first part of a long reply and here is the rest of it.');
    await expect(app.locator('.msg-cut')).toHaveCount(0);
  });

  test('a dropped connection is reported too', async ({ app }) => {
    await send(app, 'DROPPED please');
    await expect(app.locator('.msg-cut')).toContainText('connection ended before the reply was finished');
    await expect(app.locator('.msg-cut button:has-text("Continue")')).toBeVisible();
  });
});

test('a normal reply shows no cut-off note', async ({ app }) => {
  await send(app, 'just a normal question');
  await expect(app.locator('.msg-cut')).toHaveCount(0);
});
