import { test, expect } from './helpers.js';

// Claude Code chats (decision 165): Stop works while Claude Code is still starting – nothing is sent to it afterwards.
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
test('Stop while Claude Code is still starting: nothing is sent to it, the chat is not left writing', async ({ app }) => {
  await app.addInitScript(() => {
    let release;
    globalThis.__holdStart = new Promise((r) => (release = r));
    globalThis.__releaseStart = () => release();
  });
  await ccChat(app, 41745);
  await app.fill('#input', 'echo do not send me');
  await app.click('#send-btn');
  await app.waitForFunction(() => document.body.classList.contains('streaming'));
  // not just dots: the reply says what it is waiting for (decision 226)
  await expect(app.locator('.msg.assistant').last().locator('.msg-note')).toContainText('starting Claude Code…');
  await app.click('#send-btn'); // the send button is Stop while a reply is writing
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 5000 });
  await app.evaluate(() => globalThis.__releaseStart());
  await app.waitForTimeout(3000);
  const texts = await app.evaluate(() => globalThis.__cc.posts.filter((m) => m.method === 'session/prompt').map((m) => m.params.prompt[0].text));
  expect(texts.filter((t) => t.includes('do not send me'))).toEqual([]);
  expect(await app.evaluate(() => document.body.classList.contains('streaming'))).toBe(false);
});

test('Stop while Claude Code answers ends the reply even when the agent never says it stopped', async ({ app }) => {
  await ccChat(app, 41746);
  // the first message starts the bridge and the agent: on a busy CI machine that can take longer than send()'s 30 s
  await app.fill('#input', 'echo warm up');
  await app.click('#send-btn');
  await expect(reply(app)).toContainText('Echo from s', { timeout: 60000 });
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  // the fake agent asks for a permission and waits: Stop must end the turn without the agent's answer
  await app.fill('#input', 'please edit main.py');
  await app.click('#send-btn');
  await expect(reply(app)).toContainText('I will edit it.', { timeout: 15000 });
  await app.evaluate(() => document.getElementById('send-btn').click()); // Stop (the question sheet stays open)
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 15000 });
});
