import { test, expect, send } from './helpers.js';

// At the step limit the assistant gets one last request without tools to say where things stand (decision 199)
test.use({ appSettings: { prefs: { tools: true, maxSteps: 2, agentMode: 'auto' } } });

test('at the step limit the reply says what is done and what is left, then how to go on', async ({ app }) => {
  await send(app, 'STEPLIMIT keep listing files');
  const reply = app.locator('.msg.assistant').last();
  await expect(reply).toContainText('WRAPPED (no tools, as text): listed the files; next: read them.', { timeout: 20000 });
  await expect(reply).toContainText('Stopped after 2 tool steps');
});
