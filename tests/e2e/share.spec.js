import { test, expect, lastRequest } from './helpers.js';

test('a link shared from another app: choose what to do, it starts a new chat with tools on', async ({ app, request }) => {
  await app.evaluate(() => globalThis.__ocmOnShare({ text: 'https://example.com/post', files: [] }));
  await expect(app.locator('#share-sheet')).toHaveClass(/open/);
  await expect(app.locator('#share-preview')).toContainText('https://example.com/post');
  await expect(app.locator('#share-actions .menu-item')).toHaveCount(3);
  await app.click('#share-actions .menu-item:has-text("Read it and summarize")');
  await expect(app.locator('.msg.user').first()).toContainText('summarize it for me: https://example.com/post');
  await expect(app.locator('#tools-btn')).toHaveText(/\d+ tools/);
  const req = await lastRequest(request);
  expect(JSON.stringify(req.messages)).toContain('https://example.com/post');
});

test('shared text offers summarize / translate / explain and keeps the text', async ({ app, request }) => {
  await app.evaluate(() => globalThis.__ocmOnShare({ text: 'Bonjour tout le monde', subject: 'Salut', files: [] }));
  await app.click('#share-actions .menu-item:has-text("Translate")');
  await expect(app.locator('.msg.user').first()).toContainText('Translate this to English');
  await expect(app.locator('.msg.user').first()).toContainText('Bonjour tout le monde');
  expect(JSON.stringify((await lastRequest(request)).messages)).toContain('Bonjour tout le monde');
});

test.describe('with a picture', () => {
  test.use({ appSettings: { model: 'kimi-k3' } });
  test('a shared picture is attached and described', async ({ app }) => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await app.evaluate((b64) => globalThis.__ocmOnShare({ files: [{ name: 'shot.png', mime: 'image/png', base64: b64 }] }), png);
    await expect(app.locator('#share-preview')).toContainText('shot.png');
    await app.click('#share-actions .menu-item:has-text("Describe it")');
    await expect(app.locator('.msg.user').first().locator('.msg-images img')).toHaveCount(1);
  });
});
