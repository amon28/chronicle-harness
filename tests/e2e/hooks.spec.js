import { test, expect, lastRequest } from './helpers.js';

const fakeShell = () => {
  let manifest = '';
  globalThis.__hookRuns = [];
  globalThis.__ocmShell = {
    status: async () => ({ available: true, installed: true, abi: 'arm64-v8a' }),
    exec: ({ cmd }) => {
      if (cmd.includes("cat > '/usr/local/bin/.toolkit'")) {
        manifest = [...cmd.matchAll(/^([0-9a-f]{64})  (job|doctor|toolkit-pull)$/gm)].map((m) => m[1] + '  ' + m[2]).join('\n');
        return Promise.resolve({ output: '', exit: 0 });
      }
      if (cmd.includes("sha256sum 'job'")) return Promise.resolve({ output: manifest, exit: manifest ? 0 : 1 });
      if (cmd.includes('GUARD-WRITE')) {
        globalThis.__hookRuns.push(cmd);
        return Promise.resolve({ output: 'no writing to app.py today\n', exit: 2 });
      }
      if (cmd.includes('LINT-AFTER')) {
        globalThis.__hookRuns.push(cmd);
        return Promise.resolve({ output: 'lint: 0 problems\n', exit: 0 });
      }
      return Promise.resolve({ output: '', exit: 0 });
    },
    kill: async () => {},
    addListener: async () => ({ remove() {} }),
  };
};

test.use({
  appSettings: {
    prefs: { tools: true, toolShell: true },
    hooks: [
      { id: 'h1', name: 'guard', event: 'pre_tool', matcher: 'write_file', command: 'echo GUARD-WRITE; exit 2', enabled: true },
      { id: 'h2', name: 'lint', event: 'post_tool', matcher: 'read_file|repo_map', command: 'echo LINT-AFTER', enabled: true },
    ],
  },
});

test('hooks: a pre-tool hook blocks a call with its reason; a post-tool hook adds its output to the result', async ({ app, request }) => {
  await app.addInitScript(fakeShell);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', 'PATCHME please');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  const req = await lastRequest(request);
  const tools = req.messages.filter((m) => m.role === 'tool');
  expect(tools[0].content).toContain('Blocked by your hook "guard" refused it');
  expect(tools[0].content).toContain('no writing to app.py today');
  // the tool sees which tool and arguments triggered it
  const runs = await app.evaluate(() => globalThis.__hookRuns);
  expect(runs[0]).toContain("export TOOL_NAME='write_file'");
  // the post hook ran after repo_map and its output is part of that result
  expect(tools.at(-1).content).toContain('[hook "lint"]');
  expect(tools.at(-1).content).toContain('lint: 0 problems');
});

test.describe('stop hook', () => {
  test.use({ appSettings: { prefs: { tools: true, toolShell: true }, hooks: [{ id: 'h3', name: 'tests', event: 'stop', command: 'STOP-CHECK', enabled: true }] } });
  test('exit 2 sends the agent back to work with the output; exit 0 lets it finish', async ({ app, request }) => {
    await app.addInitScript(() => {
      let n = 0;
      globalThis.__ocmShell = {
        status: async () => ({ available: true, installed: true, abi: 'arm64-v8a' }),
        exec: ({ cmd }) => (cmd.includes('STOP-CHECK') ? Promise.resolve(n++ === 0 ? { output: '1 test failed: test_total\n', exit: 2 } : { output: 'all passed\n', exit: 0 }) : Promise.resolve({ output: '', exit: 0 })),
        kill: async () => {},
        addListener: async () => ({ remove() {} }),
      };
    });
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.fill('#input', 'fix the tests');
    await app.click('#send-btn');
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    const req = await lastRequest(request);
    const said = JSON.stringify(req.messages);
    expect(said).toContain('Stop hook \\"tests\\" says the work is not finished');
    expect(said).toContain('1 test failed: test_total');
    await expect(app.locator('.msg.assistant').last()).toContainText('Reply #2');
  });
});

test.describe('tool permissions', () => {
  test.use({ appSettings: { prefs: { tools: true }, toolPerms: { write_file: 'ask', repo_map: 'deny' } } });
  test('"Ask me" stops for your OK, "Allow for this chat" is remembered, "Never" refuses', async ({ app, request }) => {
    await app.fill('#input', 'PATCHME please');
    await app.click('#send-btn');
    await expect(app.locator('#ask-question')).toContainText('Allow write_file');
    await app.locator('#ask-options button', { hasText: 'Allow for this chat' }).click();
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    const req = await lastRequest(request);
    const tools = req.messages.filter((m) => m.role === 'tool');
    expect(tools[0].content).toContain('Wrote app.py');
    expect(tools.at(-1).content).toContain('You may not use repo_map');
  });

  test('"Never" also holds inside a script: the assistant cannot get round it with run_script', async ({ app, request }) => {
    await app.fill('#input', 'SCRIPTPERM go');
    await app.click('#send-btn');
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
    const req = await lastRequest(request);
    const tool = req.messages.filter((m) => m.role === 'tool').at(-1).content;
    expect(tool).toContain('ok=false You may not use repo_map');
  });
});
