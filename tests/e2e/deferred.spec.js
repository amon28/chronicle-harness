import { test, expect, MOCK } from './helpers.js';

const skills = Array.from({ length: 20 }, (_, i) => ({ id: 'k' + i, name: 't' + i, description: `Saved tool number ${i}. It does something useful with a long explanation.`, parameters: { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(200) } } }, code: 'print(1)', enabled: true }));
test.use({ appSettings: { prefs: { tools: true, toolPython: true }, skills } });

test('many saved tools are sent by name only; load_tools brings in the one the agent needs', async ({ app, request }) => {
  await app.fill('#input', 'LOADTOOLS please');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  const reqs = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.tools?.length);
  const first = reqs[0].tools.map((t) => t.function.name);
  expect(first).toContain('load_tools');
  expect(first.filter((n) => n.startsWith('tool_'))).toEqual([]);
  expect(reqs[0].tools.find((t) => t.function.name === 'load_tools').function.description).toContain('- tool_t5: Saved tool number 5.');
  await expect(app.locator('.msg.assistant').last()).toContainText('now: tool_t5 | load_tools offered: true');
});
