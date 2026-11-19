import { test, expect, MOCK, lastRequest } from './helpers.js';

// a stand-in for the built-in Linux that remembers every command it was given
const fakeShell = () => {
  globalThis.__cmds = [];
  globalThis.__ocmShell = {
    status: async () => ({ available: true, installed: true, abi: 'arm64-v8a' }),
    exec: ({ cmd }) => {
      globalThis.__cmds.push(cmd);
      return Promise.resolve({ output: cmd.includes('python3 app.py') ? '1\n' : '', exit: 0 });
    },
    kill: async () => {},
    addListener: async () => ({ remove() {} }),
  };
};
const withShell = async (app) => {
  await app.addInitScript(fakeShell);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
};
const allRequests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
const finished = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
const ask = async (app, text) => {
  await app.fill('#input', text);
  await app.click('#send-btn');
};
const checkNotes = (reqs) => reqs.filter((r) => /^\[Done check – from the app/.test(String(r.messages.at(-1)?.content || '')));

test.describe('done check', () => {
  test.use({ appSettings: { prefs: { tools: true, toolShell: true, checkWork: true } } });

  test('a turn that wrote a file and ran nothing is sent back once, and the chat says why', async ({ app, request }) => {
    await ask(app, 'DOCALLS [["write_file",{"path":"app.py","content":"print(1)\\n"}]]');
    await finished(app);
    const notes = checkNotes(await allRequests(request));
    expect(notes).toHaveLength(1);
    const note = notes[0].messages.at(-1).content;
    expect(note).toContain('app.py');
    expect(note).toContain('exactly these files: app.py');
    expect(note).toContain('do not look for other changes');
    expect(notes[0].messages.at(-2)).toMatchObject({ role: 'assistant' }); // its first answer stays before the note
    const reply = app.locator('.msg.assistant').last();
    await expect(reply.locator('.check-note')).toContainText('Wrote app.py and ran nothing to check them');
    await expect(reply).toContainText('Unchecked: I did not run app.py.');
    // the next message is a new turn: one check per message, and the old one is not repeated
    await ask(app, 'thanks');
    await finished(app);
    expect(checkNotes(await allRequests(request))).toHaveLength(1);
  });

  test('a turn that only deleted or moved files is not sent back', async ({ app, request }) => {
    await ask(app, 'DOCALLS [["write_file",{"path":"a.py","content":"1\\n"}],["write_file",{"path":"b.py","content":"2\\n"}]]');
    await finished(app);
    const before = checkNotes(await allRequests(request)).length;
    await ask(app, 'DOCALLS [["delete_file",{"path":"a.py"}],["move_file",{"from":"b.py","to":"old/b.py"}]]');
    await finished(app);
    expect(checkNotes(await allRequests(request))).toHaveLength(before);
  });

  test('a turn that ran its file after writing it finishes normally', async ({ app, request }) => {
    await withShell(app);
    await ask(app, 'DOCALLS [["write_file",{"path":"app.py","content":"print(1)\\n"}],["shell",{"command":"python3 app.py"}]]');
    await finished(app);
    expect(checkNotes(await allRequests(request))).toHaveLength(0);
    await expect(app.locator('.msg.assistant').last()).toContainText('RESULTS:');
    await expect(app.locator('.check-note')).toHaveCount(0);
  });

  test('a shell command that only changes files (chmod) is not a check; one run before the change does not count', async ({ app, request }) => {
    await withShell(app);
    await ask(app, 'DOCALLS [["shell",{"command":"python3 app.py"}],["write_file",{"path":"run.sh","content":"echo hi\\n"}],["shell",{"command":"chmod +x run.sh"}]]');
    await finished(app);
    const notes = checkNotes(await allRequests(request));
    expect(notes).toHaveLength(1);
    expect(notes[0].messages.at(-1).content).toContain('run.sh');
  });
});

test.describe('done check switched off', () => {
  test.use({ appSettings: { prefs: { tools: true, checkWork: false } } });
  test('Settings › Tools & agent turns it off', async ({ app, request }) => {
    await ask(app, 'DOCALLS [["write_file",{"path":"app.py","content":"print(1)\\n"}]]');
    await finished(app);
    expect(checkNotes(await allRequests(request))).toHaveLength(0);
    await expect(app.locator('.msg.assistant').last()).toContainText('RESULTS:');
  });
});

test.describe('dangerous shell commands', () => {
  test.use({ appSettings: { prefs: { tools: true, toolShell: true } } });

  test('rm -rf on the phone waits for the user even in Auto; "Not now" keeps it from running', async ({ app, request }) => {
    await withShell(app);
    await ask(app, 'DOCALLS [["shell",{"command":"rm -rf /phone/Pictures"}]]');
    await expect(app.locator('#ask-question')).toContainText('Run this shell command');
    await expect(app.locator('#ask-question')).toContainText('deletes files on your phone (/phone/Pictures)');
    await app.locator('#ask-options button', { hasText: 'Not now' }).click();
    await finished(app);
    const tool = (await lastRequest(request)).messages.filter((m) => m.role === 'tool').at(-1).content;
    expect(tool).toContain('The user did not let this command run');
    expect(await app.evaluate(() => globalThis.__cmds.some((c) => c.includes('rm -rf /phone')))).toBe(false);
  });

  test('"Run it" runs it; a safe rm -rf inside the workspace is not asked about', async ({ app, request }) => {
    await withShell(app);
    await ask(app, 'DOCALLS [["shell",{"command":"git push --force origin main"}]]');
    await expect(app.locator('#ask-question')).toContainText('Git push with --force');
    await expect(app.locator('.sheet.open #ask-question')).toHaveCount(1);
    await app.locator('#ask-options button', { hasText: 'Run it' }).click();
    await finished(app);
    expect(await app.evaluate(() => globalThis.__cmds.some((c) => c.includes('git push --force origin main')))).toBe(true);
    await ask(app, 'DOCALLS [["shell",{"command":"rm -rf /workspace/build node_modules"}]]');
    await finished(app);
    await expect(app.locator('.sheet.open #ask-question')).toHaveCount(0);
    expect(await app.evaluate(() => globalThis.__cmds.some((c) => c.includes('rm -rf /workspace/build node_modules')))).toBe(true);
    const tool = (await lastRequest(request)).messages.filter((m) => m.role === 'tool').at(-1).content;
    expect(tool).not.toContain('did not let');
  });

  test('a helper agent cannot ask, so its dangerous command is refused with the reason', async ({ app, request }) => {
    await withShell(app);
    const task = 'clean up the repo\nSUBCALLS [["shell",{"command":"git reset --hard"}]]';
    await ask(app, `DOCALLS [["delegate",{"task":${JSON.stringify(task)},"tools":"full"}]]`);
    await finished(app);
    const reqs = await allRequests(request);
    const refused = reqs.flatMap((r) => r.messages).filter((m) => m.role === 'tool' && /Not run: git reset --hard throws away uncommitted changes, and nobody is here to say yes/.test(String(m.content)));
    expect(refused.length).toBeGreaterThan(0);
    await expect(app.locator('.sheet.open #ask-question')).toHaveCount(0);
    expect(await app.evaluate(() => globalThis.__cmds.some((c) => c.includes('git reset --hard')))).toBe(false);
  });
});

test.describe('dangerous shell commands, guard off', () => {
  test.use({ appSettings: { prefs: { tools: true, toolShell: true, shellGuard: false } } });
  test('with the guard off the command runs without a question', async ({ app }) => {
    await withShell(app);
    await ask(app, 'DOCALLS [["shell",{"command":"rm -rf /phone/Pictures"}]]');
    await finished(app);
    expect(await app.evaluate(() => globalThis.__cmds.some((c) => c.includes('rm -rf /phone/Pictures')))).toBe(true);
  });
});

test.describe('/btw', () => {
  test('a side question is answered in a bubble and never becomes part of the chat', async ({ app, request }) => {
    await ask(app, 'hello there');
    await finished(app);
    const before = await app.locator('.msg').count();
    await ask(app, '/btw what did you just say?');
    const panel = app.locator('#btw-panel');
    await expect(panel).toContainText('By the way: what did you just say?');
    await expect(panel).toContainText('BTW answer (no tools, 4 messages): what did you just say?'); // system, user, reply, the question
    await expect(app.locator('.msg')).toHaveCount(before);
    await expect(app.locator('#input')).toHaveValue('');
    await panel.locator('.btw-close').click();
    await expect(panel).toHaveCount(0);
    await ask(app, 'and now?');
    await finished(app);
    const said = JSON.stringify((await lastRequest(request)).messages);
    expect(said).not.toContain('quick side question');
    expect(said).not.toContain('BTW answer');
  });

});

test.describe('/btw while the agent works', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('it works while a reply is running and does not disturb it', async ({ app, request }) => {
    await ask(app, 'STEPSTHENTEXT please');
    await app.waitForFunction(() => document.body.classList.contains('streaming'));
    await app.waitForFunction(() => /Answer paragraph 2\b/.test(document.querySelector('.msg.assistant:last-child')?.textContent || ''), null, { timeout: 20000 });
    await app.fill('#input', '/btw are you nearly done?');
    await app.click('#send-btn');
    const panel = app.locator('#btw-panel');
    await expect(panel).toContainText('BTW answer');
    await expect(panel).toContainText('are you nearly done?');
    expect(await app.evaluate(() => document.body.classList.contains('streaming'))).toBe(true); // still going
    await expect(app.locator('#queue-bar')).toBeHidden(); // not queued as a message either
    await finished(app);
    await expect(app.locator('.msg.assistant').last()).toContainText('Answer paragraph 39');
    const reqs = await allRequests(request);
    const btw = reqs.find((r) => /quick side question/.test(String(r.messages.at(-1)?.content || '')));
    expect(btw.tools || []).toHaveLength(0);
    expect(btw.messages.some((m) => m.role === 'tool' || m.tool_calls)).toBe(false);
    expect(JSON.stringify(btw.messages)).toContain('[called list_files');
    // the running reply's own requests never saw the question
    expect(reqs.filter((r) => r !== btw && JSON.stringify(r.messages).includes('are you nearly done?'))).toHaveLength(0);
  });
});
