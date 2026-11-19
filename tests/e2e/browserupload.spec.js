import { test, expect } from './helpers.js';

const fake = () => {
  let frame;
  globalThis.__ocmBrowser = {
    open: async () => {
      frame?.remove();
      frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;left:-9999px;width:390px;height:844px';
      frame.srcdoc = '<title>Apply</title><h1>Send your CV</h1><input id=f type=file onchange="document.getElementById(\'out\').textContent=\'got \'+this.files[0].name+\' \'+this.files[0].size+\'B\'"><div id=out></div>';
      document.body.append(frame);
      await new Promise((r) => (frame.onload = r));
      return { url: 'https://example.test/upload', title: 'Apply' };
    },
    eval: async ({ js }) => ({ value: JSON.stringify(frame.contentWindow.eval(js.split('location.href').join("'https://example.test/upload'"))) }),
    screenshot: async () => ({ base64: '', width: 1, height: 1 }),
    close: async () => frame?.remove(),
  };
};

test.use({ appSettings: { prefs: { tools: true, toolBrowser: true, agentMode: 'auto' } } });

test('browser upload: a workspace file goes into the page’s file field', async ({ app }) => {
  await app.addInitScript(fake);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'UPLOADME send my cv');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 25000 });
  await expect(app.locator('.msg.assistant').last()).toContainText('attached 1 file');
  await expect(app.locator('.tool-card').last()).toContainText('got cv.txt 5B');
});
