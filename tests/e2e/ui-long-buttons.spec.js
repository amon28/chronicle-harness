import { test, expect } from './helpers.js';

// Two long-labelled buttons ran out of their sheet on a phone: the label was cut off at the right edge.
test('long standalone buttons wrap inside their sheet', async ({ app }) => {
  await app.setViewportSize({ width: 360, height: 640 });
  const inside = async (btn, card) => {
    const b = await app.locator(btn).evaluate((el) => (el.scrollIntoView({ block: 'center' }), el.getBoundingClientRect().right));
    const c = await app.locator(card).evaluate((el) => el.getBoundingClientRect().right);
    expect(b, btn).toBeLessThanOrEqual(c);
  };
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-new');
  await inside('#pe-to-card', '#persona-editor .sheet-card');
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  await app.evaluate(() => document.getElementById('open-settings').click());
  await app.click('.set-item[data-page="shortcuts"]');
  await app.click('#settings-packs');
  await inside('#pk-make', '#packs-sheet .sheet-card');
});
