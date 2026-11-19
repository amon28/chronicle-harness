import { test, expect } from './helpers.js';

test.use({ appSettings: { mcpServers: [{ id: 'mcp_auth', name: 'Secure', url: `${globalThis.__MOCK}/mcp-auth`, enabled: false }] } });

test('an MCP server that needs sign-in: Test asks for it, Sign in runs OAuth with PKCE, then its tools load', async ({ app }) => {
  // the "browser": the sign-in page sends the user straight back to the app with a code
  await app.addInitScript(() => {
    globalThis.__ocmOpenSignIn = async (url) => {
      const r = await (await fetch(url)).json();
      setTimeout(() => globalThis.__ocmDeepLink(r.redirect), 50);
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.evaluate(() => document.getElementById('open-mcp').click()); // on the Agent page of Settings
  const row = app.locator('#mcp-list .mcp-item').first();
  await row.locator('.act', { hasText: 'Test' }).click();
  await expect(app.locator('.mcp-status').first()).toContainText('needs you to sign in');
  await row.locator('.act', { hasText: 'Sign in' }).click();
  await expect(app.locator('.mcp-status').first()).toContainText('1 tool', { timeout: 10000 });
  await expect(app.locator('#mcp-list .mcp-item').first().locator('.act', { hasText: 'Sign out' })).toBeVisible();
});
