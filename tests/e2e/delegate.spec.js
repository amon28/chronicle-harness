import { test, expect, MOCK } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

test('delegate hands a side job to a helper and returns its answer', async ({ app, request }) => {
  await app.fill('#input', 'DELEGATEME please');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  await expect(app.locator('.tool-card', { hasText: 'Asked a helper' })).toBeVisible();
  const reqs = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
  const helper = reqs.find((r) => JSON.stringify(r.messages).includes('HELPERJOB'));
  expect(helper).toBeTruthy();
  expect(helper.tools || []).toHaveLength(0);
  expect(helper.messages[0].content).toContain('helper');
  const tool = reqs.at(-1).messages.find((m) => m.role === 'tool');
  expect(tool.content).toContain("[helper model: "); // names the model that did the work
  expect(tool.content).toContain("Could not give the helper: notes.txt]");
});
