import { test, expect, MOCK } from './helpers.js';
import { fileURLToPath } from 'node:url';

// "Send me the picture" (decision 225): show_image puts images from /workspace (or the shell, or the phone folder) into the
// chat under the reply – for the user, not the model – and they stay there after a reload.
const zip = fileURLToPath(new URL('./fixtures/photos.zip', import.meta.url));
test.use({ appSettings: { model: 'kimi-k3', prefs: { tools: true, toolWeb: false, toolPython: false } } });

test('the assistant shows a picture from the workspace under its reply; a missing one is said', async ({ app, request }) => {
  await app.setInputFiles('#file-input', zip);
  await expect(app.locator('#attachments .file-chip')).toHaveCount(1);
  await app.fill('#input', 'send me the red one\nDOCALLS [["show_image",{"paths":["photos/photos/red.png","photos/missing.png"],"caption":"the red square"}]]');
  await app.click('#send-btn');
  const reply = app.locator('.msg.assistant').last();
  await expect(reply).toContainText('RESULTS: Shown to the user under your reply: photos/photos/red.png');
  await expect(reply).toContainText('Could not show: photos/missing.png (not found)');
  const img = reply.locator('.shown-images img');
  await expect(img).toHaveCount(1);
  expect(await img.getAttribute('alt')).toBe('red.png');
  expect(await img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  await expect(reply.locator('.shown-caption')).toHaveText('the red square');
  // the picture went to the user, not into what the model is sent
  const reqs = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
  const tool = reqs.at(-1).messages.find((m) => m.role === 'tool');
  expect(JSON.stringify(tool.content)).not.toContain('data:image');

  // kept with the chat: still there when it is opened again after a restart
  const saved = await app.evaluate(
    () =>
      new Promise((res) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => {
          const r = q.result.transaction('conversations').objectStore('conversations').getAll();
          r.onsuccess = () => res(JSON.stringify(r.result));
        };
      }),
  );
  expect(saved).toContain('"shown":[{"path":"photos/photos/red.png","name":"red.png","url":"data:image/png;base64,');
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.evaluate(() => document.querySelector('#menu-btn').click());
  await app.locator('.conv-item', { hasText: 'send me the red one' }).click();
  await expect(app.locator('.msg.assistant').last().locator('.shown-images img')).toHaveCount(1);
});
