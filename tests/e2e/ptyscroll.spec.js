import { test, expect } from './helpers.js';

// Swipe to scroll anywhere on the full terminal, also on its text (decision 191)
test.use({ hasTouch: true });

test('a swipe on the text scrolls the history; in a full-screen program it sends the arrow keys', async ({ app }) => {
  await app.addInitScript(() => {
    const ls = {};
    globalThis.__typed = [];
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true, distro: 'debian' }),
      exec: async () => ({ output: '', exit: 0 }),
      kill: async () => {},
      addListener: async (name, fn) => ((ls[name] = fn), { remove() {} }),
      ptyStart: async ({ id }) => {
        const text = Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${'x'.repeat(30)}`).join('\r\n') + '\r\n$ ';
        setTimeout(() => ls.ptyData?.({ id, b64: btoa(text) }), 50);
      },
      ptyWrite: async ({ data }) => void globalThis.__typed.push(data),
      ptyResize: async () => {},
      ptyKill: async () => {},
    };
    globalThis.__ptyOut = (s) => ls.ptyData?.({ id: 'fullterm', b64: btoa(s) });
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.evaluate(() => document.querySelector('#open-settings').click());
  await app.evaluate(() => document.querySelector('#open-terminal').click());
  await expect(app.locator('#pty-view')).toBeVisible();
  await expect(app.locator('#pty-term .xterm-rows')).toContainText('line 300', { timeout: 10000 });
  // a finger on the text, dragged down: the earlier lines come into view
  const swipe = (from, to) =>
    app.evaluate(
      ([y0, y1]) => {
        const el = document.querySelector('#pty-term .xterm-rows');
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const t = (y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: r.top + y });
        el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(y0)], changedTouches: [t(y0)], bubbles: true, cancelable: true }));
        for (let i = 1; i <= 10; i++) el.dispatchEvent(new TouchEvent('touchmove', { touches: [t(y0 + ((y1 - y0) * i) / 10)], changedTouches: [t(y0 + ((y1 - y0) * i) / 10)], bubbles: true, cancelable: true }));
        el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(y1)], bubbles: true, cancelable: true }));
      },
      [from, to],
    );
  await swipe(20, 320);
  await expect(app.locator('#pty-term .xterm-rows')).not.toContainText('line 300');
  // the alternate screen (less, vim): no history there – the swipe is ↑ keys
  await app.evaluate(() => globalThis.__ptyOut('\x1b[?1049h\x1b[Hless'));
  await app.waitForTimeout(200);
  await swipe(20, 200);
  await expect.poll(() => app.evaluate(() => globalThis.__typed.join(''))).toContain('\x1b[A');
});
