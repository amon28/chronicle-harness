import { test, expect } from './helpers.js';

// Background jobs on the user's Claude Code (decision 169): Settings' learning / helper / advisor lists offer Claude
// Code's models, and a job set to one runs as a hidden Claude Code session with no tools.
const PORT = 41771;
const standIn = (port) => {
  const cc = (globalThis.__cc = { starts: 0, running: null });
  globalThis.__ocmShell = {
    status: async () => ({ available: true, installed: true }),
    addListener: async () => ({ remove() {} }),
    kill: async () => {},
    exec: async ({ cmd }) => {
      const head = cmd.split('\n')[0];
      if (head === '# ocm-claude status') return { output: ['@@NODE v22.11.0', '@@PY yes', '@@CLAUDE 2.1.325 (Claude Code)', '@@ACP yes', '@@AUTH yes claude.ai -', cc.running ? `@@RUNNING 4242 ${cc.running}` : '', '@@END'].join('\n'), exit: 0 };
      if (head === '# ocm-claude start') {
        const secret = /printf '%s\\n' '([A-Za-z0-9_-]+)' \|/.exec(cmd)[1];
        await fetch(`${globalThis.__MOCK}/__spawn-acp?port=${port}&secret=${encodeURIComponent(secret)}`);
        cc.running = port;
        cc.starts++;
        return { output: `@@PORT ${port}\n`, exit: 0 };
      }
      if (head === '# ocm-claude stop') return (cc.running = null), { output: '@@STOPPED\n', exit: 0 };
      return { output: '', exit: 0 };
    },
  };
};

test('Claude Code in the background-job lists, and /polish on it runs a session without tools', async ({ app }) => {
  await app.addInitScript(standIn, PORT);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  // the picker learns the plan's models (a hidden session) – the lists use the same ones
  await app.click('#model-btn');
  await expect(app.locator('#model-list .cc-model')).toHaveCount(2, { timeout: 20000 });
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));

  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="tools"]');
  const helper = app.locator('#pref-helper');
  await expect(helper.locator('optgroup')).toHaveAttribute('label', /Claude Code \(your subscription\)/);
  await expect(helper.locator('optgroup option')).toHaveText(['Claude Code · Default – Opus 4.8 · Most capable', 'Claude Code · Sonnet']);
  await expect(app.locator('#pref-advisor optgroup option')).toHaveCount(2);
  await expect(app.locator('#pref-learn-model optgroup option')).toHaveCount(2);
  await expect(app.locator('#pref-fallback optgroup')).toHaveCount(0); // the fallback answers chats with tools: not offered
  await helper.selectOption('claude-code:sonnet');
  await app.waitForTimeout(600); // auto-save
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  if (await app.evaluate(() => document.body.classList.contains('drawer-open'))) await app.click('#scrim');

  // /polish uses the helper model: a Claude Code session with tools: [] and the Sonnet model
  await app.fill('#input', '/polish i has went to the shop yesterday');
  await app.click('#send-btn');
  await expect(app.locator('#input')).toHaveValue(/^CC-JOB\(model sonnet, tools \[\]\): .*i has went to the shop/, { timeout: 25000 });
  expect(await app.evaluate(() => globalThis.__cc.starts)).toBe(1);

  // the choice stays after a restart; the lists keep it
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="tools"]');
  await expect(app.locator('#pref-helper')).toHaveValue('claude-code:sonnet');
});

// Decision 256: background jobs on Claude Code run one at a time – one that never answers gives up after its limit (5
// minutes; 1.5 s here), so the next one still runs.
test('a Claude Code background job that never answers does not hold up the next one', async ({ app }) => {
  await app.addInitScript(() => (globalThis.__ocmCcTextLimitMs = 1500));
  await app.addInitScript(standIn, PORT + 1);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#model-btn');
  await expect(app.locator('#model-list .cc-model')).toHaveCount(2, { timeout: 20000 });
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="tools"]');
  await app.locator('#pref-helper').selectOption('claude-code:sonnet');
  await app.waitForTimeout(600);
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  if (await app.evaluate(() => document.body.classList.contains('drawer-open'))) await app.click('#scrim');
  await app.fill('#input', '/polish HANG this one never comes back');
  await app.click('#send-btn');
  await expect(app.locator('#toast')).toContainText('did not answer this background job', { timeout: 15000 });
  await app.fill('#input', '/polish i has went to the shop');
  await app.click('#send-btn');
  await expect(app.locator('#input')).toHaveValue(/^CC-JOB\(model sonnet, tools \[\]\): .*i has went to the shop/, { timeout: 25000 });
});
