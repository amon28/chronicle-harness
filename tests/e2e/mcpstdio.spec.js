import { test, expect } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

test('a stdio MCP server (a command) runs behind mcp-bridge in Linux, and its tools load', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__cmds = [];
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true }),
      addListener: async () => ({ remove() {} }),
      kill: async () => {},
      exec: async ({ cmd }) => {
        globalThis.__cmds.push(cmd);
        const m = /mcp-bridge --port (\d+) --secret '([^']+)'/.exec(cmd);
        if (m) await fetch(`${globalThis.__MOCK}/__spawn-bridge?port=${m[1]}&secret=${encodeURIComponent(m[2])}`);
        return { output: m ? 'started' : '', exit: 0 };
      },
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.evaluate(() => document.getElementById('open-mcp').click());
  await app.fill('#mcp-url', 'npx -y @example/server-echo');
  await app.click('#mcp-add');
  await expect(app.locator('.mcp-status').last()).toContainText('1 tool', { timeout: 20000 });
  await expect(app.locator('#mcp-list .persona-desc').last()).toContainText('🐧 npx -y @example/server-echo');
  const cmds = await app.evaluate(() => globalThis.__cmds.join('\n'));
  expect(cmds).toMatch(/command -v node >\/dev\/null 2>&1 \|\| \{ if command -v apt-get .*apt-get install -y -q --no-install-recommends nodejs npm.* else apk add --no-cache nodejs npm/); // npx needs Node, installed the first time (Debian or Alpine)
  expect(cmds).toContain("-- sh -c 'npx -y @example/server-echo'");
});
