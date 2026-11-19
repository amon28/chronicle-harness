import { test, expect } from './helpers.js';

test.use({ appSettings: { prefs: { tools: true } } });

test('git history: a reply that changes files becomes a commit, and Restore brings the old files back', async ({ app }) => {
  // first reply: writes app.py etc. – then switch history on (the files now = the first commit)
  await app.fill('#input', 'PATCHME please');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await app.click('#files-btn');
  await app.click('#git-box summary');
  await app.check('#git-auto');
  await expect(app.locator('#git-log .git-row')).toHaveCount(1);
  await expect(app.locator('#git-log')).toContainText('Start of the history');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  // second reply changes files again: one more commit, named after the request
  await app.fill('#input', 'PATCHME again');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await app.click('#files-btn');
  await expect(app.locator('#git-log .git-row')).toHaveCount(2, { timeout: 5000 }).catch(async () => {
    await app.click('#git-box summary');
    await app.click('#git-box summary');
    await expect(app.locator('#git-log .git-row')).toHaveCount(2);
  });
  await expect(app.locator('#git-log .git-row').first()).toContainText('PATCHME again');
  // restore the first: recorded as a third commit
  app.once('dialog', (d) => d.accept());
  await app.locator('#git-log .git-row').nth(1).locator('.act').click();
  await expect(app.locator('#git-log .git-row')).toHaveCount(3);
  await expect(app.locator('#git-log .git-row').first()).toContainText('Restore');
});

test('"What this chat changed" shows one diff of everything since the chat started', async ({ app }) => {
  await app.fill('#input', 'PATCHME please');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });
  await app.click('#files-btn');
  await app.click('#ws-changes');
  await expect(app.locator('#ws-changes-box .changes-card > summary').first()).toContainText('2 files changed');
  await expect(app.locator('#ws-changes-box')).toContainText('app.py');
});
