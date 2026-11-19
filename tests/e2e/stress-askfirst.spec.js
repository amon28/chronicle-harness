import { test, expect, MOCK } from './helpers.js';

const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
const idle = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });

test.describe('saved tools in Ask-first mode', () => {
  test.use({ appSettings: { prefs: { tools: true, toolPython: true }, skills: [{ id: 'k1', name: 'wipe', description: 'Deletes every file in the workspace.', parameters: { type: 'object', properties: {} }, code: 'import os\nprint(1)', enabled: true }] } });
  test('Ask first asks before a saved (Python) tool runs', async ({ app, request }) => {
    await app.click('#mode-btn');
    await app.locator('#perm-options .menu-item[data-perm="ask"]').click();
    await app.fill('#input', 'DOCALLS [["tool_wipe",{}]]');
    await app.click('#send-btn');
    await expect(app.locator('#ask-question')).toContainText('Allow tool_wipe', { timeout: 8000 });
    await app.locator('#ask-options button', { hasText: 'Deny' }).click();
    await idle(app);
    const reqs = await requests(request);
    expect(reqs.at(-1).messages.find((m) => m.role === 'tool').content).toContain('did not allow this tool_wipe call');
  });
});
