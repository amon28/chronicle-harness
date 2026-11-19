import { test, expect } from './helpers.js';

// A short button beside a field (Show, Personas, Use) was squeezed until its word broke letter by letter.
for (const size of [{ width: 412, height: 915 }, { width: 360, height: 640 }]) {
  test(`buttons beside a field stay on one line at ${size.width}px`, async ({ app }) => {
    await app.setViewportSize(size);
    await app.click('#menu-btn');
    await app.click('#open-settings');
    const oneLine = async (sel) => {
      const b = app.locator(sel);
      await b.scrollIntoViewIfNeeded();
      const lines = await b.evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
      });
      expect(lines, sel).toBe(1);
      const box = await b.boundingBox();
      expect(box.x + box.width, sel).toBeLessThanOrEqual(size.width);
    };
    await app.click('.set-item[data-page="account"]');
    await app.evaluate(() => (document.querySelector('#ocg-box').open = true)); // closed once a key is saved
    await oneLine('#toggle-key');
    await app.click('#set-back');
    await app.click('.set-item[data-page="chat"]');
    await oneLine('#settings-personas');
    await app.click('#set-back');
    await app.click('.set-item[data-page="connect"]');
    await app.evaluate(() => document.querySelectorAll('#settings-sheet details').forEach((d) => (d.open = true)));
    await oneLine('#gh-pat-save');
  });
}
