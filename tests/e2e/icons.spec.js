import { test, expect } from './helpers.js';

test.describe('interface icons while a reply streams', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('a tool card being redrawn never shows its raw emoji on screen (no flicker)', async ({ app }) => {
    // after every painted frame, look for an interface emoji that was not swapped for its icon
    await app.evaluate(() => {
      window.__rawSeen = 0;
      const rx = /[📜🛠🧭✏📝🐍💻📁]/u;
      const look = () => {
        for (const s of document.querySelectorAll('#messages .tool-card summary, #messages .tool-head')) {
          const w = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
          for (let n = w.nextNode(); n; n = w.nextNode()) if (rx.test(n.nodeValue) && !n.parentElement.closest('.ic-wrap, code, pre')) window.__rawSeen++;
        }
      };
      const loop = () => {
        setTimeout(look, 0); // runs after the frame was painted
        if (!window.__stopLook) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    await app.fill('#input', 'SLOWTOOL please');
    await app.click('#send-btn');
    await expect(app.locator('.tool-card').last()).toBeVisible();
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    const seen = await app.evaluate(() => ((window.__stopLook = true), window.__rawSeen));
    expect(seen).toBe(0);
  });
});
