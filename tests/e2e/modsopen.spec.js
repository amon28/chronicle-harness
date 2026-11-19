import { test, expect, send, MOCK } from './helpers.js';

const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
async function openMods(app) {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="tools"]');
  await app.click('#open-mods');
}
const close = (app) => app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));

test.describe('tool hook', () => {
  test.use({ appSettings: { prefs: { tools: true } } });
  test('the Tool guard example blocks a page on its list and tells the assistant why', async ({ app, request }) => {
    await openMods(app);
    await app.click('#mod-examples .menu-item:has-text("Tool guard")');
    await expect(app.locator('#mi-warn')).toBeVisible(); // toolhook is a sensitive permission
    await app.click('#mi-go');
    await expect(app.locator('#mod-list')).toContainText('hook beforeTool');
    await close(app);
    await send(app, 'FETCHBLOCK please');
    await expect(app.locator('.tool-card').first()).toBeVisible();
    const tool = (await requests(request)).at(-1).messages.find((m) => m.role === 'tool');
    expect(tool.content).toContain('Blocked by a mod');
    expect(tool.content).toContain('reading https://example-bank.com/login is not allowed');
  });
});

test('a mod panel shows up in the chat menu and renders its page', async ({ app }) => {
  await openMods(app);
  await app.click('#mod-examples .menu-item:has-text("Notes panel")');
  await app.click('#mi-go');
  await expect(app.locator('#mod-list')).toContainText('running');
  await close(app);
  await app.fill('#input', '/note buy milk');
  await app.click('#send-btn');
  await expect(app.locator('#toast')).toContainText('Note saved');
  await app.click('#chat-more-btn');
  await app.click('#cm-more');
  await app.click('#cm-panels');
  await expect(app.locator('#panel-list .menu-item', { hasText: 'Notes' })).toBeVisible();
  await app.click('#panel-list .menu-item');
  await expect(app.locator('#panel-body')).toContainText('buy milk');
});

test('a mod can register a search source (it starts, and the list shows it)', async ({ app }) => {
  await openMods(app);
  await app.click('#mod-examples .menu-item:has-text("Wikipedia search")');
  await app.click('#mi-go');
  await expect(app.locator('#mod-list')).toContainText('running');
});
