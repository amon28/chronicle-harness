import { test, expect, send, MOCK } from './helpers.js';

// Claude Code chats (decision 165): Retry and the swipe's ＋ ask Claude Code again – never the chat's normal model.
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
const apiCalls = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages).length;
/** The Claude Code session the last reply came from (the fake agent says it). */
async function sid(app) {
  await expect(reply(app)).toContainText('Echo from s', { timeout: 20000 });
  return /Echo from (s\d+)/.exec(await reply(app).innerText())[1];
}

test('Retry on a Claude Code reply asks Claude Code again, not the normal model; both versions stay swipes', async ({ app, request }) => {
  await ccChat(app, 41772);
  await send(app, 'echo one');
  await sid(app);
  // an agent's reply is not "continued" by the normal model
  await expect(reply(app).locator('button[aria-label="Continue"]')).toHaveCount(0);
  const before = await apiCalls(request);
  await reply(app).locator('button[aria-label="Retry"]').click();
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await sid(app);
  expect(await apiCalls(request)).toBe(before); // nothing went to the normal API
  await expect(reply(app).locator('.pager')).toContainText('2/2');
  // ＋ on the newest version: another one, from Claude Code too
  await reply(app).locator('.pager-btn:has-text("＋")').click();
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await sid(app);
  await expect(reply(app).locator('.pager')).toContainText('3/3');
  expect(await apiCalls(request)).toBe(before);
});
