import { test, expect } from './helpers.js';
import { installFakeLinux } from './linuxfiles-fake.js';

// a phone folder that also has the native "stream a Linux file" export
const fakePhone = () => {
  globalThis.__exports = [];
  globalThis.__ocmPhoneFolder = {
    pick: async () => ({ uri: 'content://fake', name: 'Videos' }),
    list: async () => ({ entries: [] }),
    read: async () => ({ base64: '' }),
    write: async () => ({ existed: false }),
    remove: async () => ({}),
    exists: async () => ({ exists: false, isDir: false, size: 0 }),
    addListener: async (ev, fn) => (ev === 'exportProgress' && (globalThis.__progress = fn), { remove() {} }),
    exportLinuxFile: async (o) => {
      globalThis.__exports.push(o);
      globalThis.__progress?.({ done: 5, total: 10 }); // progress comes while it copies
      const size = globalThis.__linuxDisk?.[o.guest]?.length ?? 0;
      return { name: o.path || o.guest.split('/').pop(), folder: o.uri ? 'Videos' : 'Download/Chronicle', bytes: size };
    },
  };
};

test.use({ appSettings: { prefs: { tools: true, toolShell: true } } });

test('Files › Linux › Download streams the file to the phone (any size), to Downloads or the linked folder', async ({ app }) => {
  await app.addInitScript(installFakeLinux);
  await app.addInitScript(fakePhone);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#files-btn');
  await app.click('#phone-link');
  await app.click('#files-sheet [data-close]');
  await app.click('#menu-btn');
  await app.click('#open-wsm');
  await app.click('#wsm-loc-linux');
  await app.locator('#wsm-list .wsm-row', { hasText: 'demogame' }).locator('.wsm-open').click();
  await app.click('#wsm-select');
  await app.locator('#wsm-list .wsm-row', { hasText: 'logo.png' }).locator('input').check();
  await app.click('#wsm-download');
  await app.locator('#choose-list .menu-item', { hasText: 'Download/Chronicle' }).click();
  await expect(app.locator('#toast')).toContainText('Saved logo.png');
  await app.click('#wsm-download');
  await app.locator('#choose-list .menu-item', { hasText: 'Videos' }).click();
  await expect(app.locator('#toast')).toContainText('to Videos');
  const ex = await app.evaluate(() => globalThis.__exports);
  expect(ex[0]).toEqual({ guest: '/root/demogame/logo.png' }); // no bytes went through the app
  expect(ex[1]).toMatchObject({ guest: '/root/demogame/logo.png', uri: 'content://fake', path: 'logo.png' });
});

test('phone_write from_shell: the assistant saves a shell file to the phone folder after asking (review mode)', async ({ app }) => {
  await app.addInitScript(installFakeLinux);
  await app.addInitScript(fakePhone);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#files-btn');
  await app.click('#phone-link');
  await app.click('#files-sheet [data-close]');
  await app.fill('#input', 'DOCALLS [["phone_write",{"path":"rec/logo.png","from_shell":"~/demogame/logo.png"}]]');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toContainText('from Linux into “Videos” as rec/logo.png');
  await app.click('#ask-options .menu-item:has-text("Save it")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  const ex = await app.evaluate(() => globalThis.__exports);
  expect(ex).toEqual([{ guest: '/root/demogame/logo.png', uri: 'content://fake', path: 'rec/logo.png' }]);
  await expect(app.locator('.tool-card').first()).toContainText('rec/logo.png');
});
