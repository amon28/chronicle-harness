import { test, expect, lastRequest } from './helpers.js';

// the patch is only read back, never run: the done check (decision 146) would send it back once – not what this tests
test.use({ appSettings: { prefs: { tools: true, checkWork: false } } });

test('apply_patch changes and adds files in one go; the reads after it run together and see the new text; repo_map outlines the code', async ({ app, request }) => {
  await app.fill('#input', 'PATCHME please');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await expect(app.locator('.msg.assistant:last-child .md')).toContainText('Done: Patch applied (2 files)');
  const req = await lastRequest(request);
  const tools = req.messages.filter((m) => m.role === 'tool');
  // results come back in the order the calls were made, each with its own answer
  expect(tools[1].content).toContain('updated app.py');
  expect(tools[2].content).toContain('return 10');
  expect(tools[3].content).toContain('patched');
  expect(tools[4].content).toMatch(/app\.py \(\d+ lines\)[\s\S]*def a\(\):/);
});
