import { test, expect } from './helpers.js';

test.describe('PC agents (ACP)', () => {
  test.use({ appSettings: { acpAgents: [{ id: 'acp_1', name: 'Claude on my PC', url: 'http://127.0.0.1:41602', secret: 'tt' }] } });
  test('a chat with a PC agent: the reply streams in, its tool call asks for permission here', async ({ app, request }) => {
    await request.get(`${globalThis.__MOCK}/__spawn-acp?port=41602&secret=tt`);
    await app.click('#menu-btn');
    await app.click('#open-settings');
    await app.evaluate(() => {
      const d = document.getElementById('acp-box');
      d.open = true;
      d.dispatchEvent(new Event('toggle'));
    });
    await app.evaluate(() => [...document.querySelectorAll('#acp-list .act')].find((b) => b.textContent === 'New chat').click());
    await app.fill('#input', 'fix the bug');
    await app.click('#send-btn');
    await expect(app.locator('#ask-sheet')).toContainText('The agent on your PC wants to: Edit main.py', { timeout: 15000 });
    await app.click('#ask-options .menu-item:has-text("Allow")');
    const reply = app.locator('.msg.assistant').last();
    await expect(reply).toContainText('Done (allow) for: fix the bug', { timeout: 15000 });
    await expect(reply).toContainText('I will edit it.');
    await expect(reply).toContainText('Edit main.py');
    await expect(reply.locator('.tool-card')).toContainText('Edited file'); // the agent's tool call is one of the app's own cards
    await expect(reply.locator('.tool-card .tool-status')).toHaveText('✓');
  });
});
