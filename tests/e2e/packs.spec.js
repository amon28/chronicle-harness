import { test, expect } from './helpers.js';

const PACK = { chronicle_pack: 1, id: 'kit', name: 'Kit', version: '1.0', author: 'Ada', snippets: [{ cmd: 'tighten', title: 'Tighten', text: 'Tighter:​ {{text}}' }], recipes: [{ text: '---\nname: outline\n---\n## Outline\nOutline it.' }], mcpServers: [{ name: 'time', command: 'uvx mcp-server-time' }] };

test('a pack: review shows everything (hidden characters, what runs), install adds it, remove takes it all away', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.evaluate(() => document.getElementById('settings-packs').click());
  await app.setInputFiles('#pk-file', { name: 'kit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(PACK)) });
  await expect(app.locator('#pk-items li')).toHaveCount(3);
  await expect(app.locator('#pk-warn')).toContainText('1 hidden character');
  await expect(app.locator('#pk-warn')).toContainText('uvx mcp-server-time');
  await app.click('#pk-install');
  await expect(app.locator('#pk-list')).toContainText('Kit 1.0');
  await expect(app.locator('#pk-list')).toContainText('3 items');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.fill('#input', '/tig');
  await expect(app.locator('#slash-menu')).toContainText('/tighten');
  await app.fill('#input', '/out');
  await expect(app.locator('#slash-menu')).toContainText('/outline');
  await app.fill('#input', '');
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.evaluate(() => document.getElementById('settings-packs').click());
  app.once('dialog', (d) => d.accept());
  await app.click('#pk-list .act:has-text("Remove")');
  await expect(app.locator('#pk-list')).toContainText('No packs installed');
});

test('the MCP registry: search, then Add a remote server', async ({ app }) => {
  await app.route('https://registry.modelcontextprotocol.io/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ servers: [{ server: { name: 'ai.example/clock', title: 'Clock', version: '1.0.0', description: 'A clock', remotes: [{ type: 'streamable-http', url: `${globalThis.__MOCK}/mcp-auth` }] }, _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } } }] }) }),
  );
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.evaluate(() => document.getElementById('open-mcp').click());
  await app.click('#mcp-reg summary');
  await app.fill('#mcp-reg-q', 'clock');
  await app.click('#mcp-reg-go');
  await expect(app.locator('#mcp-reg-list')).toContainText('by ai.example · 🌐 remote');
  app.once('dialog', (d) => d.accept());
  await app.click('#mcp-reg-list .act:has-text("Add")');
  await expect(app.locator('#mcp-list')).toContainText('Clock');
  await expect(app.locator('.mcp-status').last()).toContainText('sign in'); // the test server wants a sign-in
});
