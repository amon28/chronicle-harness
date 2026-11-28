import { test, expect, MOCK } from './helpers.js';

const idle = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });

test.describe('tools', () => {
  test.use({ appSettings: { model: 'hy3', prefs: { tools: true } } });

  test('a script that ran out of time takes its waiting question with it', async ({ app }) => {
    await app.fill('#input', 'DOCALLS [["run_script",{"code":"const r = await tools.write_file({path:\'late.txt\',content:\'x\'}); print(r.ok)","timeout_s":2}]]');
    await app.click('#mode-btn');
    await app.locator('#perm-options .menu-item[data-perm="ask"]').click();
    await app.click('#send-btn');
    await expect(app.locator('#ask-question')).toContainText('Allow ✏️ Write files (a script)', { timeout: 15000 });
    // nobody answers; the script's 2 s pass and the reply finishes
    await expect(app.locator('.msg.assistant').last()).toContainText('RESULTS:', { timeout: 15000 });
    await idle(app);
    await expect(app.locator('#ask-sheet')).not.toHaveClass(/open/);
    await expect(app.locator('#ask-chip')).toBeHidden();
  });

  test('code mode: run_script is always offered, its card lists each call; a helper may script only its own tools (decision 185)', async ({ app, request }) => {
    await app.fill('#input', 'DOCALLS [["run_script",{"code":"await tools.write_file({path:\'a.txt\',content:\'1\'}); const r = await Promise.all([\'a.txt\',\'nope.txt\'].map((path) => tools.read_file({ path }))); print(r.map((x) => x.ok).join(\',\'))"}]]');
    await app.click('#send-btn');
    await idle(app);
    const reqs = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
    expect(reqs[0].tools.map((t) => t.function.name)).toContain('run_script'); // not held back any more
    expect(String(reqs[0].messages[0].content)).toContain('Code mode:');
    const card = app.locator('.tool-card', { hasText: 'Ran a script' }).last();
    await card.locator('summary').click();
    await expect(card).toContainText('3 tool calls from the script:');
    await expect(card.locator('.script-steps li')).toHaveText(['✓ write_file · a.txt', '✓ read_file · a.txt', '✗ read_file · nope.txt']);
    await expect(card).toContainText('true,false');

    // a helper's script: its own tools work, a tool a helper may never have is refused – also from inside a script
    const task = 'look around\nSUBCALLS [["run_script",{"code":"const a = await tools.list_files({}); const b = await tools.search_chats({query:\'x\'}); print(a.ok, b.ok, b.result)"}]]';
    await app.fill('#input', `DOCALLS [["delegate",${JSON.stringify({ task, tools: 'full' })}]]`);
    await app.click('#send-btn');
    await idle(app);
    const all = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
    const out = all.flatMap((r) => r.messages).filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(out.some((t) => /true false search_chats is not one of your tools, so your script cannot call it either/.test(t))).toBe(true);
  });

  test('a file name with a space, in backticks, is a link to the file; commands and plain text are not', async ({ app }) => {
    await app.fill('#input', 'DOCALLS [["write_file",{"path":"output/my notes.md","content":"# notes\\n"}]]');
    await app.click('#send-btn');
    await idle(app);
    await app.fill('#input', 'FILELINKS');
    await app.click('#send-btn');
    await idle(app);
    const reply = app.locator('.msg.assistant').last();
    await expect(reply.locator('code.ws-file')).toHaveText(['output/my notes.md', 'output/my notes.md:4']);
    await expect(reply.locator('code:not(.ws-file)')).toHaveText(['npm run dev', 'output/my']);
    await reply.locator('code.ws-file').nth(1).click();
    await expect(app.locator('#preview-title')).toHaveText('output/my notes.md');
  });
});
