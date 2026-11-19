import { test, expect, MOCK, lastRequest } from './helpers.js';

// ⚡ Bypass permissions (docs/DECISIONS.md 161): tools run without the app asking – but Never stays Never, personal
// data still asks, and the chip shows it is on.

// a stand-in for the built-in Linux that remembers every command, and a phone that can tell where it is
const standIns = () => {
  globalThis.__cmds = [];
  globalThis.__ocmShell = {
    status: async () => ({ available: true, installed: true, abi: 'arm64-v8a' }),
    exec: ({ cmd }) => {
      globalThis.__cmds.push(cmd);
      return Promise.resolve({ output: '', exit: 0 });
    },
    kill: async () => {},
    addListener: async () => ({ remove() {} }),
  };
  globalThis.__ocmDevice = { status: async () => ({ batteryFree: true, allFiles: false }), location: async (o) => ({ lat: 52.52008, lon: 13.40495, accuracy: 12, precise: !!o.precise, time: Date.now() }) };
};
const withStandIns = async (app) => {
  await app.addInitScript(standIns);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
};
const finished = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
const ask = async (app, text) => {
  await app.fill('#input', text);
  await app.click('#send-btn');
};
const ran = (app, part) => app.evaluate((p) => globalThis.__cmds.some((c) => c.includes(p)), part);
const allRequests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
const turnOnBypass = async (app) => {
  await app.click('#mode-btn');
  await app.locator('#perm-options .menu-item[data-perm="bypass"]').click();
  // asked once, on the app's own sheet, saying what still asks
  await expect(app.locator('#choose-title')).toHaveText('⚡ Bypass permissions in this chat?');
  await expect(app.locator('#choose-hint')).toContainText('No longer asked');
  await expect(app.locator('#choose-hint')).toContainText('tools you set to Never');
  await expect(app.locator('#choose-hint')).toContainText('location');
  await app.locator('#choose-list .menu-item', { hasText: 'Turn on Bypass' }).click();
  await expect(app.locator('#mode-btn')).toHaveText('⚡ Bypass');
  await expect(app.locator('#mode-btn')).toHaveClass(/bypass-chip/);
};

test.describe('⚡ Bypass permissions', () => {
  test.use({ appSettings: { prefs: { tools: true, toolShell: true, toolDevice: true }, toolPerms: { write_file: 'ask', delete_file: 'deny' } } });

  test('cancelling the warning leaves the chat as it was', async ({ app }) => {
    await app.click('#mode-btn');
    await app.locator('#perm-options .menu-item[data-perm="bypass"]').click();
    await app.locator('#choose-list .menu-item', { hasText: 'Cancel' }).click();
    await expect(app.locator('#mode-btn')).toHaveText('⚡ Auto');
    await expect(app.locator('#mode-btn')).not.toHaveClass(/bypass-chip/);
  });

  test('a command the guard stops and an "Ask me" tool run without a question; the model is told', async ({ app, request }) => {
    await withStandIns(app);
    await turnOnBypass(app);
    await ask(app, 'DOCALLS [["shell",{"command":"rm -rf /phone/Pictures"}],["shell",{"command":"git reset --hard"}],["write_file",{"path":"a.txt","content":"hi\\n"}]]');
    await finished(app);
    await expect(app.locator('.sheet.open #ask-question')).toHaveCount(0);
    expect(await ran(app, 'rm -rf /phone/Pictures')).toBe(true);
    expect(await ran(app, 'git reset --hard')).toBe(true);
    const req = await lastRequest(request);
    const tools = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(tools.join('\n')).not.toMatch(/did not (let|allow)|You may not use/);
    expect(req.messages[0].content).toContain('⚡ Bypass permissions is on in this chat');
  });

  test('a tool set to Never stays denied, and location still asks', async ({ app, request }) => {
    await withStandIns(app);
    await turnOnBypass(app);
    await ask(app, 'DOCALLS [["delete_file",{"path":"a.txt"}],["location",{}]]');
    await expect(app.locator('#ask-question')).toContainText('Share your approximate location');
    await app.locator('#ask-options button', { hasText: 'Not now' }).click();
    await finished(app);
    const tools = (await lastRequest(request)).messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(tools[0]).toContain('You may not use delete_file');
    expect(tools[1]).toContain('The user said no');
  });

  test('tapping the chip offers to turn it off; then the guard asks again', async ({ app, request }) => {
    await withStandIns(app);
    await turnOnBypass(app);
    await app.click('#mode-btn');
    await expect(app.locator('#choose-title')).toHaveText('⚡ Bypass permissions is on');
    await app.locator('#choose-list .menu-item', { hasText: 'Turn Bypass off' }).click();
    await expect(app.locator('#mode-btn')).toHaveText('⚡ Auto');
    await expect(app.locator('#mode-btn')).not.toHaveClass(/bypass-chip/);
    await ask(app, 'DOCALLS [["shell",{"command":"rm -rf /phone/Pictures"}]]');
    await expect(app.locator('#ask-question')).toContainText('Run this shell command');
    await app.locator('#ask-options button', { hasText: 'Not now' }).click();
    await finished(app);
    expect(await ran(app, 'rm -rf /phone')).toBe(false);
    const reqs = await allRequests(request);
    expect(reqs.at(-1).messages[0].content).not.toContain('Bypass permissions is on');
  });
});

test.describe('⚡ Bypass as the default for new chats', () => {
  test.use({ appSettings: { prefs: { tools: true, toolShell: true, bypassDefault: true } } });

  test('a new chat starts in Bypass and shows it', async ({ app }) => {
    await withStandIns(app);
    await expect(app.locator('#mode-btn')).toHaveText('⚡ Bypass');
    await ask(app, 'DOCALLS [["shell",{"command":"rm -rf /phone/Pictures"}]]');
    await finished(app);
    await expect(app.locator('.sheet.open #ask-question')).toHaveCount(0);
    expect(await ran(app, 'rm -rf /phone/Pictures')).toBe(true);
  });
});

test.describe('⚡ Bypass in Settings', () => {
  test.use({ appSettings: { prefs: { tools: true } } });

  test('the default for new chats asks once before it is stored; cancelled it stays off', async ({ app }) => {
    await app.click('#menu-btn');
    await app.click('#open-settings');
    await app.click('.set-item[data-page="tools"]');
    const box = app.locator('#pref-bypass-default');
    await expect(box).not.toBeChecked();
    await box.check({ force: true }).catch(() => {}); // the box is unticked again until the warning is answered
    await expect(app.locator('#choose-title')).toHaveText('⚡ Bypass permissions in new chats?');
    await app.locator('#choose-list .menu-item', { hasText: 'Cancel' }).click();
    await expect(box).not.toBeChecked();
    await app.waitForTimeout(500); // past the auto-save
    const newChatMode = async () => {
      await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
      await app.click('#menu-btn');
      await app.click('#drawer-new');
      return app.locator('#mode-btn').textContent();
    };
    expect(await newChatMode()).toBe('⚡ Auto');
    await app.click('#menu-btn');
    await app.click('#open-settings');
    await app.click('.set-item[data-page="tools"]');
    await box.click({ force: true });
    await app.locator('#choose-list .menu-item', { hasText: 'Turn on Bypass' }).click();
    await expect(box).toBeChecked();
    expect(await newChatMode()).toBe('⚡ Bypass');
  });
});

test.describe('⚡ Bypass and the phone folder', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  const fakeFolder = () => {
    const disk = { 'a.txt': new TextEncoder().encode('hello') };
    const b64 = (u8) => btoa(String.fromCharCode(...u8));
    globalThis.__disk = disk;
    globalThis.__ocmPhoneFolder = {
      pick: async () => ({ uri: 'content://fake', name: 'Projects' }),
      list: async () => ({ entries: Object.entries(disk).map(([path, d]) => ({ path, isDir: false, size: d.length })) }),
      read: async ({ path }) => ({ base64: b64(disk[path]) }),
      write: async ({ path, base64 }) => ((disk[path] = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))), { existed: path in disk }),
      remove: async ({ path }) => (delete disk[path], {}),
      exists: async ({ path }) => ({ exists: !!disk[path], isDir: false, size: 0 }),
    };
  };
  const diskText = (app) => app.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(globalThis.__disk).map(([k, v]) => [k, new TextDecoder().decode(v)]))));
  const link = async (app) => {
    await app.addInitScript(fakeFolder);
    await app.reload();
    await app.waitForSelector('body[data-ready="1"]');
    await app.click('#files-btn');
    await app.click('#phone-link');
    await expect(app.locator('#phone-name')).toHaveText(/Projects/);
    await app.click('#files-sheet [data-close]');
  };

  test('Review acts like Auto: changes are saved at once, no review sheet', async ({ app }) => {
    await link(app);
    await expect(app.locator('#mode-btn')).toContainText('Review');
    await turnOnBypass(app);
    await app.fill('#input', 'PHONEW do it');
    await app.click('#send-btn');
    await expect.poll(() => diskText(app)).toBe(JSON.stringify({ 'a.txt': 'hello v2', 'new/c.txt': 'brand new' }));
    await finished(app);
    await expect(app.locator('#review-sheet')).not.toHaveClass(/open/);
  });

  test('Read-only stays read-only', async ({ app }) => {
    await link(app);
    await app.click('#mode-btn');
    await app.click('#mode-options [data-mode="readonly"]');
    await app.click('#mode-btn');
    await app.locator('#perm-options .menu-item[data-perm="bypass"]').click();
    await app.locator('#choose-list .menu-item', { hasText: 'Turn on Bypass' }).click();
    await expect(app.locator('#mode-btn')).toHaveText('⚡ Bypass · 👁 Read-only');
    await app.fill('#input', 'PHONEW do it');
    await app.click('#send-btn');
    await finished(app);
    expect(JSON.parse(await diskText(app))).toEqual({ 'a.txt': 'hello' });
  });
});
