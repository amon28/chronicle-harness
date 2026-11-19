import { test, expect } from './helpers.js';

test.use({ appSettings: { model: 'local:qwen2.5-0.5b', prefs: { localModel: true } } });

test('the on-device model answers without any server', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__ocmLocalLLM = async (messages, onToken) => {
      globalThis.__localSaw = messages;
      for (const t of ['Hello ', 'from the ', 'phone.']) onToken(t);
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await expect(app.locator('#model-btn')).toContainText('On-device');
  await app.fill('#input', 'say hi');
  await app.click('#send-btn');
  await expect(app.locator('.msg.assistant').last()).toContainText('Hello from the phone.');
  expect(await app.evaluate(() => globalThis.__localSaw.at(-1).content)).toBe('say hi');
});
