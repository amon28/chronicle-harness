import { test, expect } from './helpers.js';

test('the full terminal shows the program’s screen and sends keys, with Ctrl from the extra row', async ({ app }) => {
  await app.addInitScript(() => {
    const ls = {};
    const emit = (n, e) => (ls[n] || []).forEach((f) => f(e));
    const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
    globalThis.__written = [];
    globalThis.__started = [];
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true }),
      addListener: async (n, f) => ((ls[n] ||= []).push(f), { remove() {} }),
      exec: async () => ({ output: '', exit: 0 }),
      kill: async () => {},
      ptyStart: async (o) => (globalThis.__started.push(o), setTimeout(() => emit('ptyData', { id: o.id, b64: b64('\x1b[32mWelcome to vim-ish\x1b[0m\r\n$ ') }), 50)),
      ptyWrite: async ({ id, data }) => (globalThis.__written.push(data), emit('ptyData', { id, b64: b64(data === '\x03' ? '^C\r\n$ ' : data) })),
      ptyResize: async () => {},
      ptyKill: async () => {},
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  // Linux terminal opens straight into the terminal screen (Linux is installed), with Termux's two rows of keys
  await app.evaluate(() => document.getElementById('open-terminal').click());
  await expect(app.locator('#pty-view')).toBeVisible();
  await expect(app.locator('#pty-keys .pty-row').first().locator('button')).toHaveText(['ESC', '/', '–', 'HOME', '↑', 'END', 'PGUP']);
  await expect(app.locator('#pty-term .xterm-rows')).toContainText('Welcome to vim-ish');
  const start = await app.evaluate(() => globalThis.__started[0]);
  expect(start.cols).toBeGreaterThan(20);
  await app.locator('#pty-term').click();
  await app.keyboard.type('ls');
  await expect(app.locator('#pty-term .xterm-rows')).toContainText('$ ls');
  await app.click('#pty-keys [data-k="ctrl"]');
  await app.locator('#pty-term').click();
  await app.keyboard.type('c');
  await expect.poll(() => app.evaluate(() => globalThis.__written.includes('\x03'))).toBe(true);
  await app.click('#pty-keys [data-k="esc"]');
  await expect.poll(() => app.evaluate(() => globalThis.__written.includes('\x1b'))).toBe(true);
  await app.click('#pty-keys [data-k="pgup"]');
  await expect.poll(() => app.evaluate(() => globalThis.__written.includes('\x1b[5~'))).toBe(true);
  // the simple command box is one tap away
  await app.click('#pty-simple');
  await expect(app.locator('#pty-view')).toBeHidden();
  await expect(app.locator('#term-sheet')).toHaveClass(/open/);
});
