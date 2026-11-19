import { test, expect, send } from './helpers.js';

// Chronicle's tools and skills for Claude Code (decision 166): the real acp-bridge (in the mock server) with the fake
// ACP agent behind it; the agent reads session/new's mcpServers, connects to the "chronicle" MCP server on the bridge
// like Claude Code's MCP client, lists the tools and calls one. The call runs in the app, through the app's gate.
const PORT = 41731;
test.use({ appSettings: { prefs: { tools: true }, toolPerms: { memory: 'ask', contacts: 'deny' }, agentSkills: [{ id: 'sk_t', name: 'trip-notes', description: 'Notes for a trip', instructions: 'Write the notes.', files: { 'scripts/tn.sh': 'echo tn' }, enabled: true, source: 'user' }] } });
test('a Claude Code chat calls Chronicle tools over MCP: consent sheet, permissions, the answer comes back', async ({ app }) => {
  await app.addInitScript((port) => {
    const cc = (globalThis.__cc = { running: null, cmds: [] });
    globalThis.__ocmDevice = { status: async () => ({ batteryFree: true, allFiles: false }), location: async () => ({ lat: 52.52, lon: 13.4, accuracy: 900, address: 'Berlin Mitte', time: Date.now() }) };
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true }),
      addListener: async () => ({ remove() {} }),
      kill: async () => {},
      exec: async ({ cmd, id, mounts }) => {
        const head = cmd.split('\n')[0];
        if (head.startsWith('# ocm-claude')) cc.cmds.push({ head, id, mounts: mounts || '', cmd });
        if (head === '# ocm-claude status') return { output: ['@@NODE v22.11.0', '@@PY yes', '@@CLAUDE 2.1.325 (Claude Code)', '@@ACP yes', '@@AUTH yes claude.ai -', cc.running ? `@@RUNNING 4242 ${cc.running}` : '', '@@END'].join('\n'), exit: 0 };
        if (head === '# ocm-claude start') {
          const secret = /printf '%s\\n' '([A-Za-z0-9_-]+)' \|/.exec(cmd)[1];
          await fetch(`${globalThis.__MOCK}/__spawn-acp?port=${port}&secret=${encodeURIComponent(secret)}`);
          cc.running = port;
          return { output: `@@PORT ${port}\n`, exit: 0 };
        }
        // the skills: a stand-in ~/.claude/skills where nothing is there yet
        if (head === '# ocm-claude skills') return { output: [...cmd.matchAll(/^chk (\S+) /gm)].map((m) => `@@NEED ${m[1]}`).join('\n') + '\n@@PLANNED\n', exit: 0 };
        if (head === '# ocm-claude skills-write') return { output: [...cmd.matchAll(/echo "@@WROTE (\S+)"/g)].map((m) => `@@WROTE ${m[1]}`).join('\n') + '\n', exit: 0 };
        if (head === '# ocm-claude stop') return (cc.running = null), { output: '@@STOPPED\n', exit: 0 };
        return { output: '', exit: 0 };
      },
    };
  }, PORT);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  const reply = app.locator('.msg.assistant').last();

  await app.click('#model-btn');
  await expect(app.locator('#model-list .cc-model')).toHaveCount(2, { timeout: 20000 });
  await app.click('#model-list .cc-model:has-text("Default – Opus 4.8")');

  // 1. what the session got: the "chronicle" http server, Chronicle's tools pre-allowed (it asks itself), the line in the prompt
  await send(app, 'mcp-info');
  await expect(reply).toContainText('servers: chronicle:http', { timeout: 20000 });
  await expect(reply).toContainText('"allowedTools": ["mcp__chronicle__*"]');
  // the chat works in its own workspace, bound at /chats/<chat> in Claude Code's Linux, and the prompt says so
  await expect(reply).toContainText('cwd: /chats/');
  await expect(reply).toContainText("they mean your working directory /chats/");
  // the skill was written as a Claude Code skill before the session started
  const cmds = await app.evaluate(() => globalThis.__cc.cmds);
  const write = cmds.find((c) => c.head === '# ocm-claude skills-write');
  expect(write.cmd).toContain('trip-notes');
  const md = atob(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > "\$T"\/'SKILL\.md'/.exec(write.cmd)[1]);
  expect(new TextDecoder().decode(Uint8Array.from(md, (c) => c.charCodeAt(0)))).toMatch(/^---\nname: trip-notes\ndescription: "Notes for a trip"\n---\n/);
  expect(cmds.findIndex((c) => c.head === '# ocm-claude skills')).toBeLessThan(cmds.length);
  expect(cmds.every((c) => c.id === 'claude-code')).toBe(true);
  // every command in the Claude Code shell carries the same bind of the chats' workspaces (a new one would restart it)
  expect(new Set(cmds.map((c) => c.mounts)).size).toBe(1);
  expect(cmds[0].mounts).toMatch(/:\/chats$/);

  // 2. a call that needs the user's OK for their data: the app's own consent sheet, then the answer goes back
  await app.fill('#input', 'mcp location');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toContainText('Share your approximate location', { timeout: 20000 });
  await app.click('#ask-options .menu-item:has-text("Share")');
  await expect(reply).toContainText('location -> Berlin Mitte', { timeout: 20000 });
  await expect(reply).toContainText('52.52, 13.4 (±900 m, approximate)');
  await expect(reply).toContainText('mcp__chronicle__location'); // Claude Code's own tool card for the call
  await expect(reply).toContainText('tools: ');
  const toolsSeen = await reply.innerText();
  expect(toolsSeen).toContain('calendar');
  expect(toolsSeen).not.toMatch(/tools: [^|]*\bshell\b/);
  expect(toolsSeen).not.toMatch(/tools: [^|]*\brun_python\b/);
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });

  // 3. Settings › Permissions "ask me" for memory: Chronicle's own question, naming Claude Code
  await app.fill('#input', 'mcp memory {"action":"list"}');
  await app.click('#send-btn');
  await expect(app.locator('#ask-sheet')).toContainText('Allow memory (Claude Code)', { timeout: 20000 });
  await app.click('#ask-options .menu-item:has-text("Deny")');
  await expect(reply).toContainText('memory ERROR -> The user did not allow this memory call', { timeout: 20000 });
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });

  // 4. "never" (deny): refused without a question
  await send(app, 'mcp contacts {"query":"Ann"}');
  await expect(reply).toContainText('contacts ERROR -> You may not use contacts in this app', { timeout: 20000 });

  // 5. a tool the chat does not offer (Chronicle's shell): refused
  await send(app, 'mcp shell {"command":"ls"}');
  await expect(reply).toContainText('shell ERROR -> shell is not available in this chat', { timeout: 20000 });

  // 6. checked before it runs (decision 170): a near-miss name is read as the real one and said; an unknown one is
  // refused naming what the tool takes
  await send(app, 'mcp read_chat {"chat_id":"nope"}');
  await expect(reply).toContainText('("chat_id" was read as "id".)', { timeout: 20000 });
  await expect(reply).toContainText('No chat with id nope');
  await send(app, 'mcp read_chat {"foo":1}');
  await expect(reply).toContainText('read_chat: unknown parameter "foo". It takes: id (required)', { timeout: 20000 });
});
