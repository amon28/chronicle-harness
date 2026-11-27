import { test, expect } from './helpers.js';

// Decision 248: Claude Code's own auto-updater stays off; the app asks the npm registry which version is newest and
// says so – once in a message, and on the card until it is updated. Updating stays the card's button.
test('a newer Claude Code is announced once, and the card offers the update', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__npmAsked = 0;
    globalThis.__ocmNpmHttp = async (url) => (globalThis.__npmAsked++, { status: 200, body: JSON.stringify({ name: '@anthropic-ai/claude-code', version: url.includes('claude-code/latest') ? '2.1.330' : '0.0.0' }) });
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true }),
      addListener: async () => ({ remove() {} }),
      kill: async () => {},
      exec: async ({ cmd }) => {
        const head = cmd.split('\n')[0];
        if (head === '# ocm-claude status') return { output: '@@NODE v22.11.0\n@@PY yes\n@@CLAUDE 2.1.325 (Claude Code)\n@@ACP yes\n@@AUTH yes claude.ai -\n@@END\n', exit: 0 };
        return { output: '', exit: 0 };
      },
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  const openCard = async () => {
    await app.click('#menu-btn');
    await app.click('#open-settings');
    await app.evaluate(() => {
      const d = document.getElementById('cc-box');
      d.open = true;
      d.dispatchEvent(new Event('toggle'));
    });
  };
  await openCard();
  await expect(app.locator('#cc-status')).toContainText('✓ Claude Code 2.1.325 installed');
  await expect(app.locator('#cc-status')).toContainText('⬆ Update available: 2.1.330 (you have 2.1.325)');
  await expect(app.locator('#cc-install')).toHaveText('Update to 2.1.330');
  await expect(app.locator('#toast')).toContainText('Claude Code 2.1.330 is out (you have 2.1.325)');
  expect(await app.evaluate(() => globalThis.__npmAsked)).toBe(1);
  // later the same day: the card still says it, the registry is not asked again and the message is not repeated
  await app.evaluate(() => document.querySelector('#toast').classList.remove('show'));
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await openCard();
  await expect(app.locator('#cc-install')).toHaveText('Update to 2.1.330');
  await app.waitForTimeout(500);
  expect(await app.evaluate(() => globalThis.__npmAsked)).toBe(0); // a fresh page: its counter starts at 0, and nothing asked
  await expect(app.locator('#toast')).not.toContainText('2.1.330 is out');
});
