import { test, expect, send } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

const wsFiles = (app) =>
  app.evaluate(
    () =>
      new Promise((resolve) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => {
          const g = q.result.transaction('workspaces').objectStore('workspaces').getAll();
          g.onsuccess = () => resolve(Object.keys(g.result[0]?.files || {}).sort());
        };
      }),
  );

test('rewind: files only, then conversation and files', async ({ app }) => {
  await send(app, 'first question');
  await app.fill('#input', 'PATCHME please');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await expect.poll(() => wsFiles(app)).toEqual(['app.py', 'notes.md']);
  const patchMsg = app.locator('.msg.user').nth(1);
  // files only: the messages stay, the files go back
  await patchMsg.locator('.act-more').click();
  await app.click('#mm-rewind');
  await app.click('#mm-rewind-files');
  await expect.poll(() => wsFiles(app)).toEqual([]);
  await expect(app.locator('.msg.user')).toHaveCount(2);
  // conversation: back to before that message, with its text in the box again
  await patchMsg.locator('.act-more').click();
  await app.click('#mm-rewind');
  await app.click('#mm-rewind-chat');
  await expect(app.locator('.msg.user')).toHaveCount(1);
  await expect(app.locator('#input')).toHaveValue('PATCHME please');
});
