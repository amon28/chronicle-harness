import { test, expect } from './helpers.js';

test('!command runs in the chat’s shell without the model, and the output stays in the chat', async ({ app, request }) => {
  await app.addInitScript(() => {
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true }),
      addListener: async () => ({ remove() {} }),
      kill: async () => {},
      // each command comes after a line that marks its start (for the timeout's reaper): the command is what follows it
      exec: async ({ cmd }) => (/^ls -la$/.test(cmd.replace(/^\{ read -r ocm_up[^\n]*\n/, '').trim()) ? { output: 'total 0\nREADME.md\n', exit: 0 } : { output: '', exit: 0 }),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await app.fill('#input', '!ls -la');
  await app.click('#send-btn');
  await expect(app.locator('.msg.user').last()).toContainText('!ls -la');
  await expect(app.locator('.msg.assistant').last()).toContainText('README.md', { timeout: 15000 });
  const reqs = (await (await request.get(`${globalThis.__MOCK}/__requests`)).json()).filter((r) => r.messages);
  expect(reqs.length).toBe(0); // the model was not asked
});
