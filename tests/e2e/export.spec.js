import { test, expect, send } from './helpers.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

test.use({ acceptDownloads: true });

async function exportAs(app, button) {
  await app.click('#chat-more-btn');
  await app.click('#cm-more');
  await app.click('#cm-export');
  const [dl] = await Promise.all([app.waitForEvent('download'), app.click(button)]);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
}

test('export a chat as Markdown, text and a SillyTavern chat', async ({ app }) => {
  await send(app, 'Hello there');
  const md = await exportAs(app, '#cm-export-md');
  expect(md.name).toMatch(/\.md$/);
  expect(md.text).toContain('**Rich**');
  expect(md.text).toContain('Hello there');
  expect(md.text).toContain('**Assistant**');

  const txt = await exportAs(app, '#cm-export-txt');
  expect(txt.name).toMatch(/\.txt$/);
  expect(txt.text).toContain('Rich');

  const st = await exportAs(app, '#cm-export-st');
  expect(st.name).toMatch(/\.jsonl$/);
  const lines = st.text.trim().split('\n').map((l) => JSON.parse(l));
  expect(lines[0]).toMatchObject({ user_name: 'Rich', character_name: 'Assistant' });
  expect(lines[1]).toMatchObject({ name: 'Rich', is_user: true, mes: 'Hello there' });
  expect(lines[2]).toMatchObject({ name: 'Assistant', is_user: false });
});

test('import a SillyTavern chat: matches the character by name, keeps swipes', async ({ app }, testInfo) => {
  // the character exists (imported card) …
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url)));
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  // … and an ST chat with her
  const file = testInfo.outputPath('seraphina-chat.jsonl');
  fs.writeFileSync(
    file,
    [
      { user_name: 'Rich', character_name: 'Seraphina', create_date: '2025-03-01@10h20m30s', chat_metadata: {} },
      { name: 'Seraphina', is_user: false, send_date: 'March 1, 2025 10:20am', mes: 'Easy now.', swipes: ['Easy now.', 'Who goes there?'], swipe_id: 0 },
      { name: 'Rich', is_user: true, send_date: 'March 1, 2025 10:21am', mes: 'Where am I?' },
      { name: 'Seraphina', is_user: false, send_date: 'March 1, 2025 10:22am', mes: 'In my glade, traveller.' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="data"]');
  await app.setInputFiles('#st-file', file);
  await expect(app.locator('#persona-name')).toHaveText('Seraphina');
  await expect(app.locator('.msg.assistant')).toHaveCount(2);
  await expect(app.locator('.msg.user')).toContainText('Where am I?');
  const first = app.locator('.msg.assistant').first();
  await expect(first.locator('.msg-model b')).toHaveText('Seraphina');
  await expect(first.locator('.pager-num')).toHaveText('1/2');
  await app.click('#menu-btn');
  await expect(app.locator('.conv-item', { hasText: 'Seraphina (imported)' })).toBeVisible();
});

test('import an ST chat whose character is missing: a placeholder is made', async ({ app }, testInfo) => {
  const file = testInfo.outputPath('ghost.jsonl');
  fs.writeFileSync(file, [{ user_name: 'Rich', character_name: 'Ghost' }, { name: 'Ghost', is_user: false, mes: 'Boo.' }].map((r) => JSON.stringify(r)).join('\n'));
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="data"]');
  await app.setInputFiles('#st-file', file);
  await expect(app.locator('#persona-name')).toHaveText('Ghost');
  await expect(app.locator('.msg.assistant')).toContainText('Boo.');
});
