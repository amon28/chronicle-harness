import { test, expect, send, lastRequest } from './helpers.js';

// Claude Code as models in the normal picker (decision 165): a stand-in Linux where Claude Code is installed and
// signed in; the first message starts the real acp-bridge (in the mock server) with the fake ACP agent behind it.
const PORT = 41711;
test('Claude Code in the model picker: pick, send, switch model and effort, usage, back to a normal model', async ({ app, request }) => {
  await app.addInitScript((port) => {
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
  }, PORT);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  const reply = app.locator('.msg.assistant').last();
  const section = app.locator('#model-list .cc-model');

  // 1. the picker asks Linux once and shows Claude Code's models (A–Z among the others, a "claude" badge), plain
  // text, before Claude Code ever ran
  await app.click('#model-btn');
  await expect(section.first()).toContainText('claude', { timeout: 10000 });
  await expect(section.first()).not.toContainText('🤖');
  // opening the picker asked Claude Code for the plan's models (no message sent): "Default" says what it is now
  await expect(app.locator('#model-list .cc-model')).toHaveCount(2, { timeout: 20000 });
  await expect(app.locator('#model-list')).not.toContainText('%'); // no usage in the picker
  await app.click('#model-list .cc-model:has-text("Default – Opus 4.8")');
  await expect(app.locator('#model-name')).toHaveText('Claude Code · Default – Opus 4.8 · Most capable');
  // picking it starts Claude Code in the background, before the first message (decision 178)
  await expect.poll(() => app.evaluate(() => globalThis.__cc.starts), { timeout: 15000 }).toBe(1);

  // 2. send: the bridge starts on its own, a session opens, the reply comes from Claude Code
  await send(app, 'echo hello there');
  await expect(reply).toContainText('(model default, effort default, set: nothing): echo hello there', { timeout: 20000 });
  expect(await app.evaluate(() => globalThis.__cc.starts)).toBe(1);
  // the 🪟 chip shows Claude Code's own context as it reported it – not the normal model's window or a cap from Settings
  await expect(app.locator('#ctx-btn')).toHaveText(/^32K \/ 1M$/, { timeout: 10000 });
  // the same context sheet as other chats, with Claude Code's numbers (decision 173)
  await app.click('#ctx-btn');
  await expect(app.locator('#ctx-sheet')).toHaveClass(/open/);
  await expect(app.locator('#ctx-model')).toContainText('Claude Code');
  await expect(app.locator('#ctx-model')).toContainText('context window 1M tokens');
  await expect(app.locator('#ctx-total')).toHaveText('31,500 tokens used · 3.2%');
  await expect(app.locator('#ctx-source')).toContainText('As Claude Code reported it after its last reply');
  await expect(app.locator('#ctx-rows')).toContainText("Chronicle's context cap, sliding window and auto-compact");
  await expect(app.locator('#ctx-inspect')).toBeHidden();
  // Compact: Claude Code's own /compact goes to Claude Code (not Chronicle's summary)
  await expect(app.locator('#ctx-compact')).toHaveText('📝 Compact now – Claude Code’s /compact');
  await app.click('#ctx-compact');
  await expect(reply).toContainText('CMD /compact', { timeout: 15000 });
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });

  // the "/" menu: Claude Code's commands, marked; where Chronicle has the same name, both are there, each marked
  await app.fill('#input', '/');
  const menu = app.locator('#slash-menu');
  await expect(menu).toBeVisible();
  await app.fill('#input', '/compact');
  await expect(menu.locator('.slash-item')).toHaveCount(3); // Chronicle's, Claude Code's, "Manage snippets"
  await expect(menu.locator('.slash-item').nth(0).locator('.slash-tag')).toHaveText('Chronicle');
  await expect(menu.locator('.slash-item').nth(1).locator('.slash-tag')).toHaveText('Claude Code');
  await app.fill('#input', '/add');
  await expect(menu.locator('.slash-item', { hasText: '/add-dir' }).locator('.slash-tag')).toHaveText('Claude Code'); // Claude Code's only
  await expect(menu.locator('.slash-item', { hasText: '/add-dir' })).toContainText('Add a new working directory (<path>)');
  await app.fill('#input', '/review');
  await expect(menu.locator('.slash-item', { hasText: '/review' }).locator('.slash-tag')).toHaveText(['Chronicle', 'Claude Code']); // both have one
  // picking Claude Code's /compact sends it to Claude Code, past Chronicle's own /compact
  await app.fill('#input', '/compact');
  await menu.locator('.slash-item').nth(1).click();
  await expect(app.locator('#input')).toHaveValue('/compact ');
  await app.locator('#input').pressSequentially('keep the plan');
  await app.click('#send-btn');
  await expect(reply).toContainText('CMD /compact keep the plan', { timeout: 15000 });
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });

  // 3. the picker now lists Claude Code's own models and the subscription usage (a hidden session, in no chat)
  await app.click('#model-btn');
  await expect(app.locator('#model-list .cc-model')).toHaveCount(2, { timeout: 10000 });
  await app.click('#model-list .cc-model:has-text("Sonnet")');
  await expect(app.locator('#model-name')).toHaveText('Claude Code · Sonnet');

  // 4. switch model: session/set_config_option, then the 🧠 chip offers Sonnet's levels and sets one
  await send(app, 'echo second');
  await expect(reply).toContainText('(model sonnet, effort default, set: model=sonnet): echo second', { timeout: 15000 });
  await expect(app.locator('#effort-btn')).toBeVisible();
  await app.click('#effort-btn');
  await expect(app.locator('#effort-btn')).toHaveText('🧠 low');
  await send(app, 'echo third');
  await expect(reply).toContainText('(model sonnet, effort low, set: model=sonnet,effort=low): echo third', { timeout: 15000 });
  await expect(reply).toContainText('Claude Code · Sonnet');

  // 5. the usage sheet (from the side menu's Claude line): a bar for each window, reset times
  await app.click('#menu-btn');
  const cu = app.locator('#cc-usage-line');
  await expect(cu.locator('.go-usage-title')).toContainText('Claude Code usage', { timeout: 15000 });
  await expect(cu.locator('.meter')).toHaveCount(2);
  await expect(cu.locator('.meter').first()).toContainText('5-hour');
  await expect(cu.locator('.meter').first()).toContainText('32%');
  await expect(cu.locator('.meter').nth(1)).toContainText('Weekly');
  await expect(cu.locator('.meter').nth(1)).toContainText('61%');
  await cu.getByRole('button', { name: 'Details' }).click();
  const sheet = app.locator('#cc-usage-sheet');
  await expect(sheet).toHaveClass(/open/);
  await expect(sheet.locator('.meter')).toHaveCount(3, { timeout: 10000 });
  await expect(sheet).toContainText('5-hour limit');
  await expect(sheet).toContainText('32% · resets');
  await expect(sheet).toContainText('Weekly · all models');
  await app.evaluate(() => { document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()); if (document.body.classList.contains('drawer-open')) document.getElementById('scrim').click(); });

  // the drawer's usage card has the Claude rows; the hidden session made no chat
  await app.click('#menu-btn');
  await expect(app.locator('#cc-usage-line .meter')).toHaveCount(2);
  await expect(app.locator('#conv-list')).not.toContainText('/usage');
  // Settings › Data can hide it
  await app.click('#open-settings');
  await app.click('.set-item[data-page="data"]');
  await app.locator('#pref-claude-usage').uncheck();
  await app.evaluate(() => { document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()); if (document.body.classList.contains('drawer-open')) document.getElementById('scrim').click(); });
  await app.click('#menu-btn');
  await expect(app.locator('#cc-usage-line')).toBeHidden();
  await app.click('#drawer-new');

  // 6. a new chat follows the last pick: Claude Code (Sonnet)
  await expect(app.locator('#model-name')).toHaveText('Claude Code · Sonnet');
  // …and a normal model in it makes it a normal chat again, which goes to the normal API
  await app.click('#model-btn');
  await app.click('#model-list .model-item:not(.cc-model) >> nth=0');
  await expect(app.locator('#model-name')).not.toHaveText('Claude Code · Sonnet');
  await send(app, 'normal now');
  await expect(reply).not.toContainText('Echo from');
  const req = await lastRequest(request);
  expect(req.messages.at(-1)).toEqual({ role: 'user', content: 'normal now' });
  expect(await app.evaluate(() => globalThis.__cc.starts)).toBe(1);
});

test('a chat switched from a normal model to Claude Code takes the chat so far, and back', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true }),
      addListener: async () => ({ remove() {} }),
      kill: async () => {},
      exec: async ({ cmd }) => {
        const head = cmd.split('\n')[0];
        if (head === '# ocm-claude status') return { output: '@@NODE v22.11.0\n@@CLAUDE 2.1.325 (Claude Code)\n@@ACP yes\n@@AUTH yes claude.ai -\n@@END\n', exit: 0 };
        if (head === '# ocm-claude start') {
          const secret = /printf '%s\\n' '([A-Za-z0-9_-]+)' \|/.exec(cmd)[1];
          await fetch(`${globalThis.__MOCK}/__spawn-acp?port=41712&secret=${encodeURIComponent(secret)}`);
          return { output: '@@PORT 41712\n', exit: 0 };
        }
        return { output: '', exit: 0 };
      },
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await send(app, 'first, to the normal model');
  const reply = app.locator('.msg.assistant').last();
  await app.click('#model-btn');
  await app.click('#model-list .cc-model', { timeout: 10000 });
  await send(app, 'echo now Claude Code');
  // the earlier user message and reply went along as context: more than one line in the prompt
  await expect(reply).toContainText('Earlier in this chat', { timeout: 20000 });
  await expect(reply).toContainText(/prompt lines: (?!1\b)\d+/);
  // back to a normal model: a normal chat again
  await app.click('#model-btn');
  await app.click('#model-list .model-item:not(.cc-model) >> nth=0');
  expect(await app.evaluate(() => JSON.stringify(document.querySelector('#model-name').textContent))).not.toContain('Claude Code');
});


test('the picker lists the plan\'s models before any message, under a "Claude" filter chip, without a badge', async ({ app }) => {
  const PORT = 41712;
  await app.addInitScript((port) => {
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
  }, PORT);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#model-btn');
  const items = app.locator('#model-list .cc-model');
  // Claude Code is started in the background and asked for its models: more than the placeholder, no message sent
  await expect.poll(() => items.count(), { timeout: 20000 }).toBeGreaterThan(1);
  await expect(items.first()).not.toContainText('Claude Code – default model');
  await expect(app.locator('#model-list')).not.toContainText('your Claude Code');
  expect(await app.locator('.msg').count()).toBe(0); // nothing went into a chat
  // the "Claude" chip shows only them
  const chip = app.locator('#model-filters .filter-chip', { hasText: 'Claude' });
  await expect(chip).toBeVisible();
  // in All they are in the same A–Z as the other models, not a block on top
  const names = await app.locator('#model-list .model-item .model-title').allTextContents();
  expect(names.length).toBeGreaterThan(await items.count());
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })));
  expect(await app.locator('#model-list .cc-models-head').count()).toBe(0);
  await chip.click();
  await expect(app.locator('#model-list .model-item:not(.cc-model)')).toHaveCount(0);
  await expect(app.locator('#model-list .cc-models-head')).toContainText('Claude Code (your subscription)');
  await expect.poll(() => items.count()).toBeGreaterThan(1);
});


test.describe('a persona in a Claude Code chat', () => {
  test.use({ appSettings: { personas: [{ id: 'lia', name: 'Lia', description: 'my assistant', prompt: 'You are Lia, warm and direct.' }], defaultPersonaId: 'lia' } });
  test('Claude Code gets the chat persona as its added instructions, and answers as it', async ({ app }) => {
    const PORT = 41713;
  await app.addInitScript((port) => {
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
    }, PORT);
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.click('#model-btn');
    await expect(app.locator('#model-list .cc-model')).toHaveCount(2, { timeout: 20000 });
    await app.click('#model-list .cc-model:has-text("Sonnet")');
    await send(app, 'who are you?');
    const reply = app.locator('.msg.assistant').last();
    await expect(reply).toContainText('SP(append): In this chat you are Lia – my assistant. When asked who you are, you are Lia.', { timeout: 20000 });
  });
});

test('Claude Code installed after the picker first looked: it shows up without a restart; without its adapter the picker says so', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__ccStage = 'none'; // none → claude only (installed by hand) → claude and its adapter
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true, distro: 'debian' }),
      addListener: async () => ({ remove() {} }),
      kill: async () => {},
      exec: async ({ cmd }) => {
        if (cmd.split('\n')[0] !== '# ocm-claude status') return { output: '', exit: 0 };
        const s = globalThis.__ccStage;
        const lines = ['@@NODE v24.22.3', '@@PY yes'];
        if (s !== 'none') lines.push('@@CLAUDE 2.1.326 (Claude Code)', '@@AUTH yes claude.ai -');
        if (s === 'full') lines.push('@@ACP yes');
        return { output: [...lines, '@@END'].join('\n'), exit: 0 };
      },
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  const section = app.locator('#model-list .cc-model');
  await app.click('#model-btn');
  await app.waitForTimeout(800);
  await expect(section).toHaveCount(0); // not installed: no Claude Code models
  await app.click('#model-sheet [data-close]');
  // claude installed by hand in the terminal, no adapter: the picker (asked again – 15 s later) says what is missing
  await app.evaluate(() => (globalThis.__ccStage = 'claude'));
  await app.evaluate(() => { const n = Date.now; Date.now = () => n() + 16000; });
  await app.click('#model-btn');
  await expect(app.locator('#model-list')).toContainText('Claude Code 2.1.326 is in Linux, but the part that connects it to Chronicle (claude-agent-acp) is not', { timeout: 10000 });
  await app.click('#model-sheet [data-close]');
  // Settings' Install added it: the next open shows its models
  await app.evaluate(() => (globalThis.__ccStage = 'full'));
  await app.evaluate(() => { const n = Date.now; Date.now = () => n() + 16000; });
  await app.click('#model-btn');
  await expect(section.first()).toContainText('claude', { timeout: 10000 });
});
