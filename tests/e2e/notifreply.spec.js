import { test, expect } from './helpers.js';

const fake = () => {
  globalThis.__notes = [];
  let listener = null;
  globalThis.__ocmKeepAlive = {
    start: async () => {},
    stop: async () => {},
    requestPermission: async () => ({ granted: true }),
    notify: async (o) => globalThis.__notes.push(o),
    clear: async () => {},
    pendingActions: async () => ({ actions: [] }),
    addListener: async (name, fn) => ((listener = fn), { remove() {} }),
  };
  globalThis.__tap = (a) => listener?.(a);
  Object.defineProperty(document, 'hidden', { get: () => !!globalThis.__away, configurable: true });
};

test.describe('answering from notifications', () => {
  test.use({ appSettings: { prefs: { tools: true }, toolPerms: { write_file: 'ask' } } });
  test('a question goes to a notification; its button answers it; a reply box sends the next message', async ({ app }) => {
    await app.addInitScript(fake);
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.evaluate(() => (globalThis.__away = true)); // the user switched to another app
    await app.fill('#input', 'PATCHME please');
    await app.click('#send-btn');
    await expect.poll(() => app.evaluate(() => globalThis.__notes.find((n) => n.kind === 'ask')?.actions)).toEqual(['Allow once', 'Allow for this chat', 'Deny']);
    const convId = await app.evaluate(() => globalThis.__notes.find((n) => n.kind === 'ask').id);
    await app.evaluate((id) => globalThis.__tap({ kind: 'ask', id, action: 'Allow for this chat', text: '' }), convId);
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    await expect(app.locator('.msg.assistant').last()).toContainText('Done: Patch applied');
    // the finished reply's notification has a reply box; typing into it sends the next message
    await expect.poll(() => app.evaluate(() => globalThis.__notes.some((n) => n.kind === 'reply' && n.reply))).toBe(true);
    await app.evaluate((id) => globalThis.__tap({ kind: 'reply', id, text: 'thanks from the notification' }), convId);
    await expect(app.locator('.msg.user').last()).toContainText('thanks from the notification');
  });
});
