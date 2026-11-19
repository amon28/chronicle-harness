import { test, expect, send, lastRequest } from './helpers.js';

// Claude Code chats (decision 165) switched back to a normal model: Claude Code's replies, its tool cards included, go to
// the normal model as what Claude Code said and did – not as tool calls the model never made.
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

test('a Claude Code reply with a tool card reaches the normal model as text, with what it did', async ({ app, request }) => {
  await ccChat(app, 41748);
  await app.fill('#input', 'please edit main.py');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toContainText('Edit main.py', { timeout: 15000 });
  await app.click('#ask-options .menu-item:has-text("Allow")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  await expect(reply(app)).toContainText('Done (allow)');
  // back to a normal model in this chat
  await app.click('#model-btn');
  await app.click('#model-list .model-item:not(.cc-model) >> nth=0');
  await send(app, 'what did you just do?');
  const req = await lastRequest(request);
  const tooly = req.messages.filter((m) => m.tool_calls?.length || m.role === 'tool');
  expect(tooly).toEqual([]); // no made-up tool calls (an "edit_file" with the card's title as its path)
  const said = req.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  expect(said).toContain('I will edit it.'); // the text before the tool call is not lost
  expect(said).toContain('Edit main.py'); // …nor what it did
  expect(said).toContain('Done (allow)');
});
