import { test, expect, send, MOCK } from './helpers.js';
import { fileURLToPath } from 'node:url';

// roleplay with the story memory updating after every exchange
test.use({ appSettings: { prefs: { storyEvery: 2, learn: false } } });
const card = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url));

const storyRequests = async (request) =>
  (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages && String(r.messages[0].content).startsWith('You keep the "story memory"'));
const storedStory = (app) =>
  app.evaluate(
    () =>
      new Promise((resolve) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => {
          const g = q.result.transaction('conversations').objectStore('conversations').getAll();
          g.onsuccess = () => resolve(g.result[0]?.story?.text || null);
        };
      }),
  );

async function startRoleplay(app) {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
}

test('deleting the turn that updated the story memory undoes that update', async ({ app }) => {
  await startRoleplay(app);
  await send(app, 'I look around.');
  await expect(app.locator('.story-note')).toBeVisible(); // "📜 Story memory updated"
  await expect.poll(() => storedStory(app)).toContain('(update 1)');

  await app.locator('.msg.assistant').last().locator('.act-more').click();
  app.once('dialog', (d) => d.accept());
  await app.click('#mm-delete');
  await expect.poll(() => storedStory(app)).toBeNull(); // the story no longer contains what that reply added
});

test('retrying an earlier reply rolls the story memory back before it is rebuilt', async ({ app, request }) => {
  await startRoleplay(app);
  await send(app, 'First.');
  await expect.poll(async () => (await storyRequests(request)).length).toBe(1);
  await send(app, 'Second.');
  await expect.poll(async () => (await storyRequests(request)).length).toBe(2);
  await expect.poll(() => storedStory(app)).toContain('(update 2)');

  // retry the first reply: the later messages (and the story updates they caused) are set aside
  await app.locator('.msg.assistant').nth(1).locator('.act-more').click(); // nth(0) is the greeting
  await app.click('#mm-retry');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'));
  await expect.poll(async () => (await storyRequests(request)).length).toBe(3);
  const rebuilt = (await storyRequests(request)).at(-1).messages[1].content;
  expect(rebuilt).toContain('(empty – this is the start)'); // it starts from scratch, not from the stale story
  expect(rebuilt).not.toContain('(update 2)');
});
