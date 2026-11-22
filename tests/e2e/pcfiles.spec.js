import { test, expect, send, lastRequest, offeredTools, closeSheets } from './helpers.js';

// Files on my PC (decision 223): Settings › Connections › Files on my PC checks the computer before keeping it, and the
// assistant gets the pc_* tools while it is connected and not paused. The computer is a stand-in (pc-files.py itself
// is tested in tests/unit/pcfiles.test.js).
test.use({ appSettings: { prefs: { tools: true, lazyTools: false } } });

const fakePc = () => {
  globalThis.__pcCalls = [];
  globalThis.__ocmPcHttp = async (url, o) => {
    globalThis.__pcCalls.push({ url, auth: o.headers.Authorization });
    if (o.headers.Authorization !== 'Bearer s3cret') return { status: 401, body: '{"error":"wrong secret"}' };
    if (url.endsWith('/health')) return { status: 200, body: JSON.stringify({ app: 'pc-files', version: 1, write: false, host: 'laptop', folders: [{ name: 'game' }, { name: 'Documents' }] }) };
    return { status: 404, body: '{"error":"not found"}' };
  };
};

const openCard = async (app) => {
  await app.evaluate(() => document.querySelector('#open-settings').click());
  await app.click('.set-item[data-page="connect"]');
  if (!(await app.locator('#pcf-box').evaluate((d) => d.open))) await app.click('#pcf-box > summary');
};

test('connect a PC: checked first, then the assistant has its files; paused, it does not', async ({ app, request }) => {
  await app.addInitScript(fakePc);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await openCard(app);
  await expect(app.locator('#pcf-list')).toContainText('No computer connected yet.');

  // a wrong secret is said at once, and nothing is kept
  await app.fill('#pcf-name', 'My laptop');
  await app.fill('#pcf-url', 'http://192.168.1.20:8766');
  await app.fill('#pcf-secret', 'wrong');
  await app.click('#pcf-add');
  await expect(app.locator('#pcf-status')).toContainText('refused the secret');
  await expect(app.locator('#pcf-list')).toContainText('No computer connected yet.');

  await app.fill('#pcf-secret', 's3cret');
  await app.click('#pcf-add');
  await expect(app.locator('#pcf-status')).toContainText('✓ My laptop (laptop) shares game, Documents – read-only');
  await expect(app.locator('#pcf-list .pcf-item')).toContainText('http://192.168.1.20:8766 · shares game, Documents · read-only');
  expect(await app.evaluate(() => globalThis.__pcCalls.map((c) => c.url))).toEqual(['http://192.168.1.20:8766/health', 'http://192.168.1.20:8766/health']);

  await closeSheets(app);
  await send(app, 'what is on my laptop?');
  let req = await lastRequest(request);
  expect(offeredTools(req)).toEqual(expect.arrayContaining(['pc_list', 'pc_search', 'pc_read', 'pc_import', 'pc_write']));
  expect(JSON.stringify(req.messages[0])).toContain('Files on the user\'s computer: \\"My laptop\\" (shares game, Documents; read-only)');

  // paused: kept, but the assistant does not get it
  await openCard(app);
  await app.locator('#pcf-list .pcf-item button', { hasText: 'Pause' }).click();
  await expect(app.locator('#pcf-list .pcf-item')).toContainText('⏸ My laptop');
  await closeSheets(app);
  await send(app, 'and now?');
  req = await lastRequest(request);
  expect(offeredTools(req)).not.toContain('pc_list');
});

test('a pasted pairing link connects the PC; one with full control says so and the assistant can run commands there', async ({ app, request }) => {
  await app.addInitScript(() => {
    globalThis.__ocmPcHttp = async (url, o) => {
      if (o.headers.Authorization !== 'Bearer k3y') return { status: 401, body: '{"error":"wrong secret"}' };
      if (url.endsWith('/health')) return { status: 200, body: JSON.stringify({ app: 'pc-files', version: 2, write: true, full: true, os: 'Windows 11', host: 'desk', folders: [{ name: 'home' }] }) };
      return { status: 404, body: '{}' };
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await openCard(app);
  await app.fill('#pcf-url', 'chronicle://pc?u=http%3A%2F%2F100.64.1.2%3A8766&s=k3y&n=DESK');
  await app.click('#pcf-add');
  await expect(app.locator('#pcf-status')).toContainText('gives FULL CONTROL');
  await expect(app.locator('#pcf-list .pcf-item')).toContainText('DESK');
  await expect(app.locator('#pcf-list .pcf-item')).toContainText('http://100.64.1.2:8766 · ⚠ FULL CONTROL (any file, runs commands) · Windows 11');
  await closeSheets(app);
  await send(app, 'list my desktop');
  const req = await lastRequest(request);
  expect(offeredTools(req)).toEqual(expect.arrayContaining(['pc_list', 'pc_shell']));
  const shell = req.tools.find((t) => t.function.name === 'pc_shell');
  expect(shell.function.description).toContain('Windows cmd');
  expect(JSON.stringify(req.messages[0])).toContain('FULL CONTROL, Windows 11');
});
