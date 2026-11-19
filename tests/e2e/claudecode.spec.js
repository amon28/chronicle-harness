import { test, expect } from './helpers.js';

// Claude Code in Linux (decisions 163, 165): a stand-in Linux answers the card's commands; Start makes the mock server run
// the real acp-bridge on 127.0.0.1 with a fake ACP agent behind it, and the chat talks to it like a PC agent.
test('Claude Code in Linux: install, sign in yourself in the terminal, start on 127.0.0.1, chat', async ({ app }) => {
  await app.addInitScript(() => {
    const ls = {};
    const cc = (globalThis.__cc = { installed: false, polls: 0, signed: false, running: null, cmds: [], pty: [], typed: [] });
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true }),
      addListener: async (n, f) => ((ls[n] ||= []).push(f), { remove() {} }),
      kill: async () => {},
      ptyStart: async (o) => void cc.pty.push(o),
      ptyWrite: async ({ data }) => void cc.typed.push(data),
      ptyResize: async () => {},
      ptyKill: async () => {},
      exec: async ({ id, cmd }) => {
        const head = cmd.split('\n')[0];
        if (!head.startsWith('# ocm-claude')) return { output: '', exit: 0 };
        cc.cmds.push({ id, cmd });
        if (head === '# ocm-claude status') {
          const out = ['@@NODE v22.11.0', '@@PY yes'];
          if (cc.installed) out.push('@@CLAUDE 2.1.325 (Claude Code)', '@@ACP yes', cc.signed ? '@@AUTH yes claude.ai -' : '@@AUTH no - -');
          if (cc.running) out.push(`@@RUNNING 4242 ${cc.running}`);
          return { output: out.join('\n') + '\n@@END\n', exit: 0 };
        }
        if (head === '# ocm-claude install') return { output: '@@STARTED\n', exit: 0 };
        if (head === '# ocm-claude poll') {
          cc.polls++;
          if (cc.polls < 3) return { output: '@@LOG\n== Linux packages\napk add nodejs npm\n== npm install -g @anthropic-ai/claude-code\n\n@@STATE\nrunning\n', exit: 0 };
          cc.installed = true;
          return { output: '@@LOG\n== npm install -g @anthropic-ai/claude-code\nadded 3 packages\n@@VERSIONS\nclaude 2.1.325 (Claude Code)\nclaude-agent-acp 0.107.0\nnode v22.11.0\n@@DONE\n\n@@STATE\nexit 0\n', exit: 0 };
        }
        if (head === '# ocm-claude start') {
          const secret = /printf '%s\\n' '([A-Za-z0-9_-]+)' \|/.exec(cmd)[1];
          const cwd = new TextDecoder().decode(Uint8Array.from(atob(/W=\$\(printf '%s' '([^']+)'/.exec(cmd)[1]), (c) => c.charCodeAt(0)));
          Object.assign(cc, { secret, cwd, host: /--host (\S+)/.exec(cmd)?.[1] });
          await fetch(`${globalThis.__MOCK}/__spawn-acp?port=41703&secret=${encodeURIComponent(secret)}`);
          cc.running = 41703;
          return { output: '@@PORT 41703\n', exit: 0 };
        }
        if (head === '# ocm-claude stop') {
          cc.running = null;
          return { output: '@@STOPPED\n', exit: 0 };
        }
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
  // the card is on Settings › Account & models (decision 165), in plain text
  expect(await app.evaluate(() => document.getElementById('cc-box').closest('.set-page').dataset.page)).toBe('account');
  await expect(app.locator('#cc-box summary')).not.toContainText('🤖');
  const status = app.locator('#cc-status');
  await expect(status).toContainText('Not installed yet.');
  await expect(app.locator('#cc-box')).toContainText('You sign in inside Claude Code itself');
  await expect(app.locator('#cc-box')).not.toContainText('Sign in with Claude');
  await expect(app.locator('#cc-start')).toBeDisabled();

  // 1. install: its output shows as it comes, then the versions
  await app.evaluate(() => document.getElementById('cc-install').click());
  await expect(app.locator('#cc-log')).toContainText('npm install -g @anthropic-ai/claude-code', { timeout: 10000 });
  await expect(status).toContainText('✓ Claude Code 2.1.325 installed (Node v22.11.0)', { timeout: 15000 });
  await expect(status).toContainText('not signed in yet – sign in inside Claude Code');
  await expect(app.locator('#cc-log')).toContainText('claude-agent-acp 0.107.0');

  // 2. the user's own terminal, `claude` typed at the prompt but not run
  await app.evaluate(() => document.getElementById('cc-terminal').click());
  await expect(app.locator('#pty-view')).toBeVisible();
  await expect.poll(() => app.evaluate(() => globalThis.__cc.typed)).toEqual(['claude']);
  expect(await app.evaluate(() => globalThis.__cc.pty[0].cmd)).toBe('sh -c "command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l"');
  await app.click('#pty-close');
  await app.evaluate(() => (globalThis.__cc.signed = true)); // the user signed in inside Claude Code
  await openCard();
  await app.evaluate(() => document.getElementById('cc-recheck').click());
  await expect(status).toContainText('✓ signed in (in Claude Code)');

  // 3. start in a folder: 127.0.0.1, the secret only in memory
  await app.evaluate(() => (document.getElementById('cc-cwd').value = '/root/proj'));
  await app.evaluate(() => document.getElementById('cc-start').click());
  await expect(status).toContainText('running on 127.0.0.1:41703 in /root/proj', { timeout: 15000 });
  const cc = await app.evaluate(() => globalThis.__cc);
  expect(cc.host).toBe('127.0.0.1');
  expect(cc.cwd).toBe('/root/proj');
  expect(cc.cmds.every((c) => c.id === 'claude-code')).toBe(true);
  const stored = await app.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain(cc.secret);
  await app.evaluate(() => {
    const d = document.getElementById('acp-box');
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
  });
  await expect(app.locator('#acp-list')).toContainText('Claude Code');
  await expect(app.locator('#acp-list')).not.toContainText('(phone)'); // one name everywhere: the line below says where it runs
  await expect(app.locator('#acp-list')).toContainText("in this phone's Linux · /root/proj");

  // a chat with it: the reply streams in from the bridge, its permission question comes here
  await app.evaluate(() => document.getElementById('cc-chat').click());
  await app.fill('#input', 'fix the bug');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toContainText('Claude Code wants to: Edit main.py', { timeout: 15000 });
  await app.click('#ask-options .menu-item:has-text("Allow")');
  const reply = app.locator('.msg.assistant').last();
  await expect(reply).toContainText('Done (allow) for: fix the bug', { timeout: 15000 });
  await expect(reply).toContainText('I will edit it.');

  // stop
  await openCard();
  await app.evaluate(() => document.getElementById('cc-stop').click());
  await expect.poll(() => app.evaluate(() => globalThis.__cc.cmds.some((c) => c.cmd.startsWith('# ocm-claude stop')))).toBe(true);
  await expect(status).not.toContainText('running');
});

test('Claude Code in Linux without Linux says what to do first', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__ocmShell = { status: async () => ({ available: true, installed: false }), addListener: async () => ({ remove() {} }), exec: async () => ({ output: '', exit: 0 }), kill: async () => {} };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.evaluate(() => {
    const d = document.getElementById('cc-box');
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
  });
  await expect(app.locator('#cc-status')).toContainText('Install Linux first');
  await expect(app.locator('#cc-start')).toBeDisabled();
});
