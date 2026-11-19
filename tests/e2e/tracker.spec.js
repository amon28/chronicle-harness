import { test, expect, send, MOCK } from './helpers.js';
import { fileURLToPath } from 'node:url';

test.use({ appSettings: { prefs: { tracker: true, storyMemory: false, learn: false } } });
const card = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url));

test('scene tracker: fills in after a reply and is sent with the next message', async ({ app, request }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  await app.click('#cv-chat');
  await send(app, 'Where am I?');
  await expect
    .poll(async () => (await (await request.get(MOCK + '/__requests')).json()).some((r) => r.messages && String(r.messages[0].content).startsWith('You keep the scene state')))
    .toBe(true);
  await app.click('#persona-name-btn');
  await app.click('#tracker-box summary');
  await expect(app.locator('#tracker-text')).toHaveValue(/Location: the old mill/);
  await expect(app.locator('#tracker-on')).toBeChecked();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await send(app, 'Look around.');
  const reqs = (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages && !String(r.messages[0].content).startsWith('You keep'));
  const last = reqs.pop().messages;
  // the scene sheet changes with every reply, so it is sent after the history (the start of the prompt stays cacheable)
  expect(String(last[0].content)).not.toContain('[Current scene');
  const sys = last.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  expect(sys).toContain('[Current scene');
  expect(sys).toContain('Location: the old mill');
});
