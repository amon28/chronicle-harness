import { test, expect } from './helpers.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { writePngText } from '../../src/cards.js';

const card = fileURLToPath(new URL('./fixtures/seraphina.png', import.meta.url));

/** The same card with a new description and one more greeting – "the creator updated it on Chub". */
function newerCard() {
  const png = new Uint8Array(fs.readFileSync(card));
  const text = new TextDecoder('latin1').decode(png);
  const m = /chara\0([A-Za-z0-9+/=]+)/.exec(text);
  const j = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  j.data.description = 'UPDATED: Seraphina now guards the whole forest.';
  j.data.alternate_greetings = [...(j.data.alternate_greetings || []), 'A brand new greeting.'];
  return Buffer.from(writePngText(png, { chara: Buffer.from(JSON.stringify(j), 'utf8').toString('base64') }));
}

test('a character imported from a chub link can be re-imported: changes are listed, and Undo puts it back', async ({ app }) => {
  let version = 1;
  await app.route('https://avatars.charhub.io/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: version === 1 ? fs.readFileSync(card) : newerCard() }));
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-tabs [data-ptab="rp"]');
  await app.fill('#chub-url', 'https://chub.ai/characters/someone/seraphina-1234');
  await app.click('#chub-go');
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  // nothing new on chub yet: it says so, and there is nothing to tap
  await expect(app.locator('.cv-reimport button').first()).toHaveText('✓ Same as on chub.ai');
  await expect(app.locator('.cv-reimport button').first()).toBeDisabled();
  // …but it can be taken again anyway (it asks about the picture)
  await app.click('.cv-reimport button:has-text("Re-import anyway")');
  await app.click('#choose-list .menu-item:has-text("Keep my picture")');
  await expect(app.locator('#toast')).toContainText('Re-imported Seraphina from chub.ai (nothing had changed)');
  // the creator updates it: the page lists what changed; the picture is the same, so no question about it
  version = 2;
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.evaluate(() => globalThis.__ocmClearReimportChecks());
  await app.click('.persona-pick:has-text("Seraphina")');
  const btn = app.locator('.cv-reimport button', { hasText: 'Update from chub.ai' });
  await expect(btn).toBeVisible();
  await expect(app.locator('.cv-reimport')).toContainText('Changed there: description, +1 greeting');
  await btn.click();
  await expect(app.locator('#toast')).toContainText('Updated Seraphina: description, +1 greeting');
  await expect(app.locator('#choose-sheet')).not.toHaveClass(/open/);
  await expect(app.locator('#cv-body')).toContainText('UPDATED: Seraphina now guards');
  await app.click('.cv-reimport button:has-text("Undo the last update")');
  await expect(app.locator('#toast')).toContainText('back to how it was');
  await expect(app.locator('#cv-body')).not.toContainText('UPDATED: Seraphina');
});

test('export a character from its page, as PNG or JSON', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.setInputFiles('#card-file', card);
  await expect(app.locator('#persona-list .persona-title', { hasText: 'Seraphina' })).toBeVisible();
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.click('.persona-pick:has-text("Seraphina")');
  for (const [choice, ext] of [['JSON', '.json'], ['PNG', '.png']]) {
    await app.click('#cv-body button:has-text("Export")');
    const got = app.waitForEvent('download');
    await app.click(`#choose-list .menu-item:has-text("${choice}")`);
    const d = await got;
    expect(d.suggestedFilename()).toBe('Seraphina' + ext);
    const bytes = fs.readFileSync(await d.path());
    if (ext === '.json') {
      const j = JSON.parse(bytes.toString('utf8'));
      expect(j.spec).toBe('chara_card_v2');
      expect(j.data.name).toBe('Seraphina');
      expect(j.data.character_book?.entries?.length).toBeGreaterThan(0);
    } else expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  }
});
