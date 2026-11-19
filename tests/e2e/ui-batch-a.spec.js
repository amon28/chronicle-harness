import { test, expect, send } from './helpers.js';

test('dropdowns open our own picker sheet, not the system list', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="look"]');
  const sel = app.locator('#pref-theme');
  await sel.scrollIntoViewIfNeeded();
  await sel.click();
  await expect(app.locator('#pick-sheet')).toHaveClass(/open/);
  await expect(app.locator('#pick-list .pick-item').first()).toBeVisible();
  await app.locator('#pick-list .pick-item', { hasText: 'Dark' }).click();
  await expect(app.locator('#pick-sheet')).not.toHaveClass(/open/);
  await expect(sel).toHaveValue('dark');
});

test('message actions are icons, retry is on every reply, and there is no + in the header', async ({ app }) => {
  await expect(app.locator('#new-btn')).toHaveCount(0);
  await send(app, 'one');
  await send(app, 'two');
  const replies = app.locator('#messages > .msg.assistant');
  await expect(replies).toHaveCount(2);
  for (const i of [0, 1]) {
    const r = replies.nth(i);
    await expect(r.locator('.act-icon svg').first()).toBeVisible();
    await expect(r.locator('.act[aria-label="Retry"]')).toBeVisible(); // not buried in ⋯
    await expect(r.locator('.act[aria-label="Copy"]')).toBeVisible();
  }
  // retrying the FIRST reply retries that one
  await replies.nth(0).locator('.act[aria-label="Retry"]').click();
  await app.waitForFunction(() => !document.body.classList.contains('streaming'));
  await expect(app.locator('#messages > .msg.assistant').first().locator('.pager-num')).toHaveText('2/2');
});

test('a persona editor for a chat assistant has no greeting field', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-personas');
  await app.click('#persona-new');
  await expect(app.locator('#pe-greeting-box')).toBeHidden();
  await app.check('#pe-rp');
  await expect(app.locator('#pe-greeting-box')).toBeVisible();
});

test('opening a dropdown never cancels the touch events (that would swallow the tap on a phone)', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="look"]');
  const prevented = await app.locator('#pref-theme').evaluate((el) => {
    const out = {};
    for (const type of ['touchstart', 'touchend', 'pointerdown']) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      out[type] = ev.defaultPrevented;
    }
    return out;
  });
  expect(prevented).toEqual({ touchstart: false, touchend: false, pointerdown: false });
  // the tap's synthesized mouse-down is what is cancelled, and the click then opens our sheet
  await app.locator('#pref-theme').click();
  await expect(app.locator('#pick-sheet')).toHaveClass(/open/);
});

test('the chat menu is a short popover with a More section, and the message-box menu has quick actions', async ({ app }) => {
  await send(app, 'hello');
  await app.click('#chat-more-btn');
  const items = app.locator('#cm-actions > .cm-item:visible');
  expect(await items.count()).toBeLessThanOrEqual(8);
  await expect(app.locator('#cm-more-list')).toBeHidden();
  const box = await app.locator('#chat-menu .sheet-card').boundingBox();
  expect(box.width).toBeLessThan(300); // a popover, not a full-width sheet
  await app.click('#cm-more');
  await expect(app.locator('#cm-more-list')).toBeVisible();
  await expect(app.locator('#cm-more-list .cm-item:visible').first()).toBeVisible();
  // "Chat settings" opens the chat's own page
  await app.click('#cm-settings');
  await expect(app.locator('#chat-sheet')).toHaveClass(/open/);
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  // the paperclip menu
  await app.click('#attach-btn');
  await expect(app.locator('#compose-menu')).toHaveClass(/open/);
  await expect(app.locator('#compose-menu .cm-item:visible')).toHaveCount(5);
});

test('the menu in the side list only has what you do to a chat in the list', async ({ app }) => {
  await send(app, 'hello');
  await app.click('#menu-btn');
  await app.click('.conv-item.active .conv-more');
  const shown = await app.locator('#chat-menu .cm-item:visible').evaluateAll((els) => els.map((e) => e.id));
  expect(shown.sort()).toEqual(['cm-archive', 'cm-delete', 'cm-export', 'cm-folder', 'cm-fork', 'cm-pin', 'cm-rename']); // export: a chat can be saved without opening it
  await app.evaluate(() => document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click()));
  // the chat's own ⋮ in the header still has the full menu
  await app.evaluate(() => document.getElementById('scrim').click());
  await app.click('#chat-more-btn');
  await expect(app.locator('#cm-settings')).toBeVisible();
  await expect(app.locator('#cm-more')).toBeVisible();
});
