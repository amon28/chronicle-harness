import { test, expect } from './helpers.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.use({ appSettings: { model: 'kimi-k3' } }); // a model that can see pictures

test('pasting a picture into the message box attaches it', async ({ app }) => {
  await app.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector('#input').dispatchEvent(ev);
  }, PNG);
  await expect(app.locator('#attachments .thumb img')).toHaveCount(1);
  await expect(app.locator('#input')).toHaveValue('');
});

test('a picture you just copied is offered above the message box', async ({ app }) => {
  await app.addInitScript((b64) => {
    globalThis.__ocmClip = { hasImage: async () => ({ has: true, stamp: 42 }), readImages: async () => ({ images: [{ mime: 'image/png', base64: b64 }] }) };
  }, PNG);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.focus('#input');
  await expect(app.locator('#clip-offer')).toBeVisible();
  await app.click('#clip-paste');
  await expect(app.locator('#attachments .thumb img')).toHaveCount(1);
  await expect(app.locator('#clip-offer')).toBeHidden();
  // once pasted, the same picture isn't offered again
  await app.evaluate(() => document.querySelector('#input').blur());
  await app.focus('#input');
  await expect(app.locator('#clip-offer')).toBeHidden();
});

test('a picture sent by the keyboard (Gboard clipboard history) is attached', async ({ app }) => {
  await app.evaluate((b64) => globalThis.__ocmCommit('image/png', b64), PNG);
  await expect(app.locator('#attachments .thumb img')).toHaveCount(1);
});
