import { test, expect, send } from './helpers.js';

// Claude Code chats (decision 165): deleting one lets its Claude Code session go (each is a process in Linux).
// A stand-in Linux where Claude Code is installed and signed in; the real acp-bridge (mock server) with the fake agent.
const shell = (port) => {
  const cc = (globalThis.__cc = { starts: 0, posts: [], hold: globalThis.__holdStart });
  globalThis.__ocmShell = {
    status: async () => ({ available: true, installed: true }),
    addListener: async () => ({ remove() {} }),
    kill: async () => {},
    exec: async ({ cmd }) => {
      const head = cmd.split('\n')[0];
      if (head === '# ocm-claude status') return { output: '@@NODE v22.11.0\n@@CLAUDE 2.1.325 (Claude Code)\n@@ACP yes\n@@AUTH yes claude.ai -\n@@END\n', exit: 0 };
      if (head === '# ocm-claude start') {
        if (cc.hold) await cc.hold; // a slow start (the phone is busy)
        const secret = /printf '%s\\n' '([A-Za-z0-9_-]+)' \|/.exec(cmd)[1];
        await fetch(`${globalThis.__MOCK}/__spawn-acp?port=${port}&secret=${encodeURIComponent(secret)}`);
        cc.starts++;
        return { output: `@@PORT ${port}\n`, exit: 0 };
      }
      return { output: '', exit: 0 };
    },
  };
  // every message the app posts to the bridge, for the tests to look at
  const real = globalThis.fetch;
  globalThis.fetch = (url, o) => {
    if (o?.method === 'POST' && /^http:\/\/127\.0\.0\.1:\d+\/send$/.test(String(url))) cc.posts.push(JSON.parse(o.body));
    return real(url, o);
  };
};
async function ccChat(app, port) {
  await app.addInitScript(shell, port);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.click('#model-btn');
  await app.click('#model-list .cc-model >> nth=0', { timeout: 15000 });
}
const reply = (app) => app.locator('.msg.assistant').last();
/** The Claude Code session the last reply came from (the fake agent says it). */
async function sid(app) {
  await expect(reply(app)).toContainText('Echo from s', { timeout: 20000 });
  return /Echo from (s\d+)/.exec(await reply(app).innerText())[1];
}

test('deleting a Claude Code chat closes its session in Claude Code', async ({ app }) => {
  await ccChat(app, 41744);
  await send(app, 'echo bye');
  const s = await sid(app);
  await app.click('#menu-btn');
  app.once('dialog', (d) => d.accept());
  await app.click('.conv-item.active .conv-more');
  await app.click('#cm-delete');
  await expect.poll(() => app.evaluate(() => globalThis.__cc.posts.filter((m) => m.method === 'session/close').map((m) => m.params.sessionId)), { timeout: 10000 }).toContain(s);
});
