import { test, expect, send } from './helpers.js';

// Claude Code chats (decision 165): when the chat is changed under it (a message edited and resent, a reply edited),
// the next message starts a new Claude Code session with the chat as it now is – not the old conversation.
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

test('an edited and resent message in a Claude Code chat starts over in a new session with the chat as it now is', async ({ app }) => {
  await ccChat(app, 41733);
  await send(app, 'echo first try');
  const first = await sid(app);
  await send(app, 'echo second');
  expect(await sid(app)).toBe(first); // an ordinary next message: the same session
  // edit the second message: the first exchange stays, the old second one is gone from what Claude Code knows
  await app.locator('.msg.user').last().locator('button[aria-label="Edit"]').click();
  await app.fill('#input', 'echo second, edited');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  const edited = await sid(app);
  expect(edited).not.toBe(first);
  await expect(reply(app)).toContainText('Earlier in this chat'); // the chat so far went along
  await send(app, 'echo third');
  expect(await sid(app)).toBe(edited); // …and the new session carries on
});
