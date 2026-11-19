import { test, expect, MOCK } from './helpers.js';

// A failed agent reply goes on from the tool steps it finished (decision 199): they are not run again
test.use({ appSettings: { prefs: { tools: true, agentMode: 'auto' } } });

test('Resume keeps the finished steps and goes on; Retry would start over', async ({ app, request }) => {
  await app.fill('#input', 'RESUMEME list my files');
  await app.click('#send-btn');
  const reply = app.locator('.msg.assistant').last();
  await expect(reply.locator('.msg-error')).toContainText('refused this one', { timeout: 20000 });
  const resume = reply.locator('.msg-resume-row button', { hasText: 'Resume' });
  await expect(reply.locator('.msg-resume-row')).toContainText('from its 1 finished step');
  const before = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages).length;
  await resume.click();
  await expect(reply).toContainText('Went on with 1 tool result from before.', { timeout: 20000 });
  await expect(reply.locator('.msg-error')).toHaveCount(0);
  await expect(app.locator('.msg.assistant')).toHaveCount(1); // the same reply, not a new one
  const reqs = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
  expect(reqs.length - before).toBe(1); // one request: the step was not run again
});
