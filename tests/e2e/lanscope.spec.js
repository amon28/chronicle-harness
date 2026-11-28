import { test, expect } from './helpers.js';

// Decision 271: a chat may reach exact addresses on the user's network only with their OK; the 🏠 chip shows it and
// takes it back.
test.use({ appSettings: { prefs: { tools: true, toolWeb: true } } });

test('local_network asks, the 🏠 chip shows the grant, and it can be taken back', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__ocmLanNet = async () => ({ connected: true, transport: 'wifi', gateway: '192.168.1.1', ipv4: ['192.168.1.57/24'], dns: ['192.168.1.1'] });
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await expect(app.locator('#grants-btn')).toBeHidden();
  await app.fill('#input', 'DOCALLS [["local_network",{"action":"request","addresses":["192.168.1.20"],"reason":"Read the printer page"}]]');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toContainText('Let the assistant reach 192.168.1.20 on the network behind 192.168.1.1 in this chat?');
  await expect(app.locator('#ask-sheet')).toContainText('The Linux shell is not limited by it at all.');
  await app.click('#ask-options .menu-item:has-text("Allow in this chat")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });
  await expect(app.locator('#grants-btn')).toHaveText('🏠 192.168.1.20');
  await app.click('#grants-btn');
  await expect(app.locator('#grants-items')).toContainText('🏠 Local network: 192.168.1.20 – on the network behind 192.168.1.1');
  await app.click('#grants-items .grant-x');
  await expect(app.locator('#grants-btn')).toBeHidden();
});
