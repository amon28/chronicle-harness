import { test, expect, send, MOCK } from './helpers.js';

// Claude Code chats (decision 165): a message that comes in while the chat is not on screen (a notification reply)
// is answered by Claude Code, never by the chat's normal model.
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
// the chats' prompts (not the app's own hidden "/usage" session)
const sessionsPrompted = (app) => app.evaluate(() => globalThis.__cc.posts.filter((m) => m.method === 'session/prompt' && m.params.prompt[0].text !== '/usage').map((m) => m.params.sessionId));
/** The Claude Code session the last reply came from (the fake agent says it). */
async function sid(app) {
  await expect(reply(app)).toContainText('Echo from s', { timeout: 20000 });
  return /Echo from (s\d+)/.exec(await reply(app).innerText())[1];
}

test.describe('notification replies', () => {
  test('a reply typed into the notification of a Claude Code chat goes to Claude Code', async ({ app, request }) => {
    await app.addInitScript(() => {
      let listener = null;
      globalThis.__ocmKeepAlive = {
        start: async () => {},
        stop: async () => {},
        requestPermission: async () => ({ granted: true }),
        notify: async () => {},
        clear: async () => {},
        pendingActions: async () => ({ actions: [] }),
        addListener: async (name, fn) => ((listener = fn), { remove() {} }),
      };
      globalThis.__tap = (a) => listener?.(a);
    });
    await ccChat(app, 41747);
    await send(app, 'echo from the app');
    const s = await sid(app);
    const id = await app.evaluate(async () => {
      const _db = await new Promise((res) => { const r = indexedDB.open('chronicle'); r.onsuccess = () => res(r.result); });
      const all = await new Promise((res) => { const q = globalThis.__ocmChatsReq(); q.onsuccess = () => res(q.result); });
      return all[0].id;
    });
    const before = await apiCalls(request);
    await app.click('#menu-btn');
    await app.click('#drawer-new'); // the user is in another chat
    await app.evaluate((convId) => globalThis.__tap({ kind: 'reply', id: convId, text: 'echo from the notification' }), id);
    await expect.poll(() => sessionsPrompted(app), { timeout: 20000 }).toEqual([s, s]);
    expect(await apiCalls(request)).toBe(before); // the normal API was not asked
  });
});
