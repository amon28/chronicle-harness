import { test, expect } from './helpers.js';

test('long-press a character on the start screen and drag it to another place; the order is kept', async ({ app }) => {
  await app.setViewportSize({ width: 390, height: 800 });
  await app.evaluate(() => { const d = document.createElement('div'); d.style.height = '2400px'; document.getElementById('messages').append(d); }); // the start page scrolls, so it must be locked while dragging
  const names = () => app.locator('.empty .persona-pick[data-pid] span').allInnerTexts();
  const before = await names();
  expect(before.length).toBeGreaterThan(2);
  const first = app.locator('.empty .persona-pick[data-pid]').nth(1); // (drag within one row: the path to a neighbour does not cross other items)
  const last = app.locator('.empty .persona-pick[data-pid]').nth(2); // its right-hand neighbour
  const a = await first.boundingBox();
  const b = await last.boundingBox();
  await app.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await app.mouse.down();
  await app.waitForTimeout(500); // the long press
  await app.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  // while an item is held the page cannot scroll (every scrollable parent is locked)...
  expect(await app.evaluate(() => document.getElementById('messages').style.overflow)).toBe('hidden');
  await app.mouse.up();
  // ...and everything is released again after the drop
  expect(await app.evaluate(() => document.getElementById('messages').style.overflow)).toBe('');
  await expect(app.locator('.sort-ghost')).toHaveCount(0);
  const after = await names();
  expect(after[2]).toBe(before[1]);
  expect(after).toHaveLength(before.length);
  // still on the start screen (the drop was not a tap that picked someone), and it survives a reload
  await expect(app.locator('.empty')).toBeVisible();
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  expect((await names())[2]).toBe(before[1]);
});

test('a quick tap on a character still picks it', async ({ app }) => {
  const second = app.locator('.empty .persona-pick[data-pid]').nth(1);
  const name = await second.locator('span').innerText();
  await second.click();
  await expect(app.locator('.empty-name')).toHaveText(name);
});
