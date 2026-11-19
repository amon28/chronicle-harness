import { test, expect, send, MOCK } from './helpers.js';

// Claude Code and Chronicle's models calling each other (decision 167): the real acp-bridge (in the mock server) with
// the fake ACP agent behind it. (a) a normal model hands a task to Claude Code with claude_code: a hidden session in
// the chat's folder, its progress and permission question in the calling chat, the answer back as the tool result;
// (b) Claude Code calls Chronicle's list_models and ask_model and gets the mock model's answer.
const PORT = 41761;
test.use({ appSettings: { prefs: { tools: true, toolClaudeCode: true } } });

async function fakeLinux(app, { cached = true } = {}) {
  await app.addInitScript(
    ({ port, cached }) => {
      const cc = (globalThis.__cc = { running: null });
      // what the Claude Code card last read from Linux (installed, signed in) – the tool is offered from this alone
      try {
        if (cached) localStorage.setItem('ocm.cache.ccReady', JSON.stringify({ installed: true, auth: 'yes', at: Date.now() }));
      } catch {
        /* a sandboxed frame (a preview) has no storage */
      }
      globalThis.__ocmShell = {
        status: async () => ({ available: true, installed: true }),
        addListener: async () => ({ remove() {} }),
        // a helper's long command (decision 183): it ends only when its shell is killed
        kill: async ({ id }) => {
          (globalThis.__killed ||= []).push(id);
          (globalThis.__sleeping || []).splice(0).forEach((end) => end({ output: 'partial\n', exit: 137 }));
        },
        exec: async ({ cmd, id }) => {
          const head = cmd.split('\n')[0];
          if (/c_second\.txt/.test(cmd)) (globalThis.__second ||= []).push(cmd); // must never reach the shell after a cancel
          if (/sleep 90/.test(cmd)) return new Promise((end) => (globalThis.__sleeping ||= []).push(end));
          // like Android: one command at a time per shell (decision 186)
          if (/sleep 1; echo both/.test(cmd)) {
            const busy = (globalThis.__busy ||= new Set());
            if (busy.has(id)) return Promise.reject(new Error('The previous command in this shell is still running'));
            busy.add(id);
            (globalThis.__ran ||= []).push(id);
            return new Promise((res) => setTimeout(() => (busy.delete(id), res({ output: 'both ok\n', exit: 0 })), 800));
          }
          if (head === '# ocm-claude status') return { output: ['@@NODE v22.11.0', '@@PY yes', '@@CLAUDE 2.1.325 (Claude Code)', '@@ACP yes', '@@AUTH yes claude.ai -', cc.running ? `@@RUNNING 4242 ${cc.running}` : '', '@@END'].join('\n'), exit: 0 };
          if (head === '# ocm-claude start') {
            const secret = /printf '%s\\n' '([A-Za-z0-9_-]+)' \|/.exec(cmd)[1];
            await fetch(`${globalThis.__MOCK}/__spawn-acp?port=${port}&secret=${encodeURIComponent(secret)}`);
            cc.running = port;
            return { output: `@@PORT ${port}\n`, exit: 0 };
          }
          if (head === '# ocm-claude skills') return { output: '@@PLANNED\n', exit: 0 };
          if (head === '# ocm-claude stop') return (cc.running = null), { output: '@@STOPPED\n', exit: 0 };
          return { output: '', exit: 0 };
        },
      };
    },
    { port: PORT, cached },
  );
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
}

test('a normal model hands a task to Claude Code: progress, its permission question, the answer comes back', async ({ app, request }) => {
  await fakeLinux(app);
  const calls = [
    ['claude_code', { task: 'please edit main.py' }],
    ['claude_code', { task: 'mcp-info' }],
    ['claude_code', { task: 'mcp ask_model {"task":"loop?"}' }],
  ];
  await app.fill('#input', `DOCALLS ${JSON.stringify(calls)}`);
  await app.click('#send-btn');
  // Claude Code's own permission question reaches the user on the app's ask sheet, while the card says it waits
  await expect(app.locator('#ask-sheet')).toContainText('Claude Code (in Linux, working for the assistant) wants to: Edit main.py', { timeout: 30000 });
  await expect(app.locator('.msg.assistant').last()).toContainText('waiting for your OK');
  await app.click('#ask-options .menu-item:has-text("Allow")');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  const reply = app.locator('.msg.assistant').last();
  // the final text of each task is the tool result the model got
  await expect(reply).toContainText('RESULTS: I will edit it. Done (allow) for: please edit main.py');
  const reqs = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
  const last = reqs.at(-1);
  expect(last.tools.some((t) => t.function.name === 'claude_code')).toBe(true);
  const results = last.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  expect(results[0]).toContain("[Claude Code (model default), on the user's Claude plan; it took 1 step: edit]");
  // the hidden session works in the chat's own folder, with Chronicle's tools pre-allowed and its task framing
  expect(results[1]).toMatch(/servers: chronicle:http/);
  expect(results[1]).toContain('cwd: /chats/');
  expect(results[1]).toContain('"allowedTools": ["mcp__chronicle__*"]');
  // no loops: a task a model started has no ask_model, and a call to it is refused
  expect(results[2]).not.toMatch(/tools: [^|]*ask_model/);
  expect(results[2]).toContain('ask_model ERROR -> ask_model is not available here');
  // the card: the steps Claude Code took, the task and its answer (three calls fold into "3 steps")
  await reply.locator('summary', { hasText: '3 steps' }).click();
  const card = reply.locator('.tool-card', { hasText: 'please edit main.py' }).first();
  await card.locator('summary').click();
  await expect(card).toContainText('✓ edit · Edit main.py');
  await expect(card).toContainText("in this chat's files, on your Claude plan");
});

test('Stop cancels a Claude Code task waiting on its question', async ({ app }) => {
  await fakeLinux(app);
  await app.fill('#input', `DOCALLS ${JSON.stringify([['claude_code', { task: 'please edit main.py' }]])}`);
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toContainText('wants to: Edit main.py', { timeout: 30000 });
  await app.evaluate(() => document.getElementById('send-btn').click()); // Stop
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await expect(app.locator('#ask-sheet')).not.toHaveClass(/open/);
  // the next task runs in a fresh session: the stopped one was cancelled, not left waiting
  await app.fill('#input', `DOCALLS ${JSON.stringify([['claude_code', { task: 'echo again' }]])}`);
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await expect(app.locator('.msg.assistant').last()).toContainText(/RESULTS: Echo from s\d+ \(model default/);
});

test('not offered while Claude Code is not known to be installed and signed in', async ({ app, request }) => {
  await fakeLinux(app, { cached: false });
  await send(app, 'hello');
  const last = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages).at(-1);
  expect(last.tools.some((t) => t.function.name === 'claude_code')).toBe(false);
});

test("Claude Code calls Chronicle's models: list_models and ask_model with the mock model's answer", async ({ app }) => {
  await fakeLinux(app);
  const reply = app.locator('.msg.assistant').last();
  await app.click('#model-btn');
  await expect(app.locator('#model-list .cc-model')).toHaveCount(2, { timeout: 20000 });
  await app.click('#model-list .cc-model:has-text("Default – Opus 4.8")');
  await send(app, 'mcp list_models');
  await expect(reply).toContainText('list_models -> ', { timeout: 20000 });
  const listed = await reply.innerText();
  expect(listed).toMatch(/tools: [^|]*ask_model/);
  expect(listed).toMatch(/tools: [^|]*list_models/);
  expect(listed).toMatch(/list_models -> \d+ models \(the helper model first, then A–Z; ids for ask_model's "model"\)/);
  expect(listed).toContain('[helper model – the default]');
  expect(listed).not.toContain('cc:');
  await send(app, 'mcp ask_model {"task":"Say hello to Claude Code"}');
  await expect(reply).toContainText(/ask_model -> Reply #\d+\. Here is/, { timeout: 20000 });
  await expect(reply).toContainText('[model: ');
  await expect(reply).toContainText(/job job_[a-z0-9]{6}/); // every call is a job (decision 179)

  // background: the id at once; a message in the chat when it is over wakes Claude Code; its answer from the status
  await send(app, 'mcp ask_model {"task":"Write a haiku","background":true}');
  await expect(reply).toContainText(/ask_model -> Started job_[a-z0-9]{6} on /, { timeout: 20000 });
  const id = /Started (job_[a-z0-9]{6})/.exec(await reply.innerText())[1];
  // the app's own message: a notice, not a user bubble – and Claude Code is told it is from the app (decision 181)
  await expect(app.locator('.msg.app-note').last()).toContainText(`🔔 Chronicle → Claude Code: Your ask_model job ${id} is done.`, { timeout: 20000 });
  await expect(app.locator('.msg.assistant').last()).toContainText(`PING [Message from the Chronicle app, not from the user] Your ask_model job ${id} is done.`, { timeout: 20000 });
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  await send(app, `mcp ask_model_status {"job_id":"${id}"}`);
  await expect(reply).toContainText(`ask_model_status -> ${id}: done`, { timeout: 20000 });
  await expect(reply).toContainText('Its answer:');
  await send(app, 'mcp ask_model_status');
  await expect(reply).toContainText(new RegExp(`${id} +done`), { timeout: 20000 });
  await send(app, `mcp ask_model_cancel {"job_id":"${id}"}`);
  await expect(reply).toContainText(`${id} was already done`, { timeout: 20000 });
  await send(app, 'mcp ask_model_status {"job_id":"job_nope00"}');
  await expect(reply).toContainText('No job job_nope00 in this chat', { timeout: 20000 });
});

test("Claude Code's own error text is shown, and a crash is not called a sign-out (decision 184)", async ({ app }) => {
  await fakeLinux(app);
  await app.click('#model-btn');
  await expect(app.locator('#model-list .cc-model')).toHaveCount(2, { timeout: 20000 });
  await app.click('#model-list .cc-model:has-text("Default – Opus 4.8")');
  await send(app, 'crash me');
  const err = app.locator('.msg.assistant .msg-error').last();
  await expect(err).toHaveText('Claude Code in Linux: Claude Agent process died: Claude Code process terminated by signal SIGBUS.', { timeout: 20000 });
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  await send(app, 'signed out');
  await expect(err).toContainText('Claude Code is not signed in.', { timeout: 20000 });
  await expect(err).toContainText('Claude Code said: Invalid API key · Please run /login');
  // both are in the error log with Claude Code's words
  await app.waitForFunction(() => /SIGBUS/.test(localStorage.getItem('ocm.errlog') || '') && /Please run \/login/.test(localStorage.getItem('ocm.errlog') || ''), null, { timeout: 5000 });
});

test.describe('with the shell on', () => {
  test.use({ appSettings: { prefs: { tools: true, toolShell: true, shellGuard: false } } });
  test('ask_model_cancel kills the step that is running and says what it left (decision 183)', async ({ app }) => {
    await fakeLinux(app);
    const reply = app.locator('.msg.assistant').last();
    await app.click('#model-btn');
    await expect(app.locator('#model-list .cc-model')).toHaveCount(2, { timeout: 20000 });
    await app.click('#model-list .cc-model:has-text("Default – Opus 4.8")');
    const task = 'write partial then sleep\nSUBCALLS [["shell",{"command":"echo partial > r4_cancel.txt; sleep 90","timeout_s":20}]]';
    await send(app, `mcp ask_model ${JSON.stringify({ task, tools: 'full', background: true, notify: false })}`);
    await expect(reply).toContainText(/ask_model -> Started job_[a-z0-9]{6} on /, { timeout: 20000 });
    const id = /Started (job_[a-z0-9]{6})/.exec(await reply.innerText())[1];
    await app.waitForFunction(() => (globalThis.__sleeping || []).length > 0, null, { timeout: 20000 }); // its step is running
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
    await send(app, `mcp ask_model_status {"job_id":"${id}"}`);
    await expect(reply).toContainText(`ask_model_status -> ${id}: running`, { timeout: 20000 });
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
    await send(app, `mcp ask_model_cancel {"job_id":"${id}"}`);
    await expect(reply).toContainText(`ask_model_cancel -> Cancelled ${id}: its shell step was killed mid-way`, { timeout: 20000 });
    await expect(reply).toContainText('it will not write anything else');
    expect(await app.evaluate(() => globalThis.__killed || [])).toContainEqual(expect.stringMatching(/^chat:/));
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
    await send(app, `mcp ask_model_status {"job_id":"${id}"}`);
    await expect(reply).toContainText(`ask_model_status -> ${id}: cancelled`, { timeout: 20000 });
  });

  test('two helper jobs run shell commands at the same time, each in a shell of its own (decision 186)', async ({ app }) => {
    await fakeLinux(app);
    const reply = app.locator('.msg.assistant').last();
    await app.click('#model-btn');
    await expect(app.locator('#model-list .cc-model')).toHaveCount(2, { timeout: 20000 });
    await app.click('#model-list .cc-model:has-text("Default – Opus 4.8")');
    const ids = [];
    for (const n of ['A', 'B']) {
      const task = `job ${n}\nSUBCALLS [["shell",{"command":"sleep 1; echo both ${n}","timeout_s":20}]]`;
      await send(app, `mcp ask_model ${JSON.stringify({ task, tools: 'full', background: true, notify: false })}`);
      await expect(reply).toContainText(/ask_model -> Started job_[a-z0-9]{6} on /, { timeout: 20000 });
      ids.push(/Started (job_[a-z0-9]{6})/.exec(await reply.innerText())[1]);
      await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
    }
    await app.waitForFunction(() => (globalThis.__ran || []).length >= 2, null, { timeout: 20000 });
    const ran = await app.evaluate(() => globalThis.__ran);
    expect(new Set(ran).size).toBe(2); // two shells, not one
    expect(ran.every((r) => /^chat:[^:]+:job_[a-z0-9]{6}$/.test(r))).toBe(true);
    for (const id of ids) {
      await expect
        .poll(async () => {
          await send(app, `mcp ask_model_status {"job_id":"${id}"}`);
          await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
          return reply.innerText();
        }, { timeout: 20000 })
        .toContain(`${id}: done`);
    }
  });
  test('a call waiting its turn is shown as waiting, and a cancel names it as not run – it never reaches the shell (decision 189)', async ({ app }) => {
    await fakeLinux(app);
    const reply = app.locator('.msg.assistant').last();
    await app.click('#model-btn');
    await expect(app.locator('#model-list .cc-model')).toHaveCount(2, { timeout: 20000 });
    await app.click('#model-list .cc-model:has-text("Default – Opus 4.8")');
    const task = `two calls\nSUBCALLS [["shell",{"command":"sleep 90; printf 'first' > c_first.txt","timeout_s":20}],["shell",{"command":"printf 'second' > c_second.txt","timeout_s":20}]]`;
    await send(app, `mcp ask_model ${JSON.stringify({ task, tools: 'full', background: true, notify: false })}`);
    await expect(reply).toContainText(/ask_model -> Started job_[a-z0-9]{6} on /, { timeout: 20000 });
    const id = /Started (job_[a-z0-9]{6})/.exec(await reply.innerText())[1];
    await app.waitForFunction(() => (globalThis.__sleeping || []).length > 0, null, { timeout: 20000 });
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
    await send(app, `mcp ask_model_cancel {"job_id":"${id}"}`);
    await expect(reply).toContainText(`Cancelled ${id}: its shell step was killed mid-way`, { timeout: 20000 });
    await expect(reply).toContainText("Not run (they were waiting their turn and will not run later): shell printf 'second' > c_second.txt");
    await app.waitForTimeout(1500);
    expect(await app.evaluate(() => globalThis.__second || [])).toEqual([]);
  });
});
