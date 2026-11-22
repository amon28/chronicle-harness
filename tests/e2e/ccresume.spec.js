import { test, expect } from './helpers.js';

// Decision 234: after Claude Code was started again (Android stops the app's Linux in the background, or the app was
// restarted), the chat's session is reopened instead of starting over with the whole chat – and when it cannot be, the
// reply says why. A stand-in Linux; the real acp-bridge with the fake agent (FAKE_ACP_STORE keeps its sessions on disk).
const shell = ([port, store]) => {
  globalThis.__ocmShell = {
    status: async () => ({ available: true, installed: true }),
    addListener: async () => ({ remove() {} }),
    kill: async () => {},
    exec: async ({ cmd }) => {
      const head = cmd.split('\n')[0];
      if (head === '# ocm-claude status') return { output: '@@NODE v22.11.0\n@@CLAUDE 2.1.325 (Claude Code)\n@@ACP yes\n@@AUTH yes claude.ai -\n@@END\n', exit: 0 };
      if (head === '# ocm-claude start') {
        const secret = /printf '%s\\n' '([A-Za-z0-9_-]+)' \|/.exec(cmd)[1];
        await fetch(`${globalThis.__MOCK}/__spawn-acp?port=${port}&secret=${encodeURIComponent(secret)}${store ? '&store=' + encodeURIComponent(store) : ''}`);
        return { output: `@@PORT ${port}\n`, exit: 0 };
      }
      return { output: '', exit: 0 };
    },
  };
};
const reply = (app) => app.locator('.msg.assistant').last();
const sidOf = async (app) => {
  await expect(reply(app)).toContainText('Echo from s');
  return /Echo from (s\d+)/.exec(await reply(app).innerText())[1];
};
async function sendCc(app, text) {
  await app.fill('#input', text);
  await app.click('#send-btn');
  await app.waitForFunction(() => document.body.classList.contains('streaming') || document.querySelector('.msg.assistant:last-child .msg-actions'), null, { timeout: 10000 });
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 60000 });
}
async function startCcChat(app, port, store) {
  await app.addInitScript(shell, [port, store]);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#model-btn');
  await app.click('#model-list .cc-model >> nth=0', { timeout: 15000 });
}
async function restartAndReopen(app) {
  // the app restarts: its connection and the bridge's secret are gone, so Claude Code is started again on the next send
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.evaluate(() => document.querySelector('#menu-btn').click());
  await app.locator('.conv-item').first().click();
}

test('Claude Code started again: the chat goes on in its own session (resumed), not a new one with the whole chat', async ({ app }) => {
  const store = `/tmp/fake-acp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  await startCcChat(app, 41781, store);
  await sendCc(app, 'echo one');
  const sid = await sidOf(app);
  await restartAndReopen(app);
  await sendCc(app, 'echo two');
  expect(await sidOf(app)).toBe(sid);
  await expect(reply(app)).not.toContainText('A new Claude Code session');
  await expect(reply(app)).toContainText('prompt lines: 1'); // only the new message went to it – not the chat again
});

test('when the session cannot be reopened, the reply says why a new one started – not "the chat changed"', async ({ app }) => {
  await startCcChat(app, 41782, '');
  await sendCc(app, 'echo one');
  const sid = await sidOf(app);
  await restartAndReopen(app);
  await sendCc(app, 'echo two');
  expect(await sidOf(app)).not.toBe(sid);
  await expect(reply(app)).toContainText("A new Claude Code session: Claude Code had been restarted (Android stops the app's Linux after a while in the background) and could not reopen this chat's session – this Claude Code cannot reopen sessions. It was given the chat so far as context.");
  await expect(reply(app)).not.toContainText('the chat changed');
});

test.describe('with Chronicle tools (its own MCP server, whose address changes with every restart)', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('a restart does not count as "MCP servers changed": the session is reopened', async ({ app }) => {
    const store = `/tmp/fake-acp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    await startCcChat(app, 41783, store);
    await sendCc(app, 'mcp-info');
    await expect(reply(app)).toContainText('servers: chronicle:http');
    await sendCc(app, 'echo one');
    const sid = await sidOf(app);
    await restartAndReopen(app);
    await sendCc(app, 'echo two');
    expect(await sidOf(app)).toBe(sid);
    await expect(reply(app)).not.toContainText('A new Claude Code session');
  });
});

test.describe('a chat saved by an earlier version', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('its setup record (one piece, with "|" in it) is taken as it is: no new session after the update', async ({ app }) => {
    const store = `/tmp/fake-acp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    await startCcChat(app, 41784, store);
    await sendCc(app, 'echo one');
    const sid = await sidOf(app);
    // as the earlier version saved it: the persona's part, then the folder, tools and servers as ONE fingerprint
    await app.evaluate(
      () =>
        new Promise((resolve) => {
          const q = indexedDB.open('chronicle');
          q.onsuccess = () => {
            const t = q.result.transaction('conversations', 'readwrite');
            const os = t.objectStore('conversations');
            os.getAll().onsuccess = (e) => {
              for (const c of e.target.result) if (c.acp?.promptSig) os.put({ ...c, acp: { ...c.acp, promptSig: c.acp.promptSig.split('#')[0] + '#120:/root/chats/x|ask_model,list_models,web_search|chronicle,…|ask_model,list_models,web_search|chronicle' } });
              t.oncomplete = resolve;
            };
          };
        }),
    );
    await restartAndReopen(app);
    await sendCc(app, 'echo two');
    expect(await sidOf(app)).toBe(sid);
    await expect(reply(app)).not.toContainText('A new Claude Code session');
  });
});
