import { test, expect } from './helpers.js';

test.use({ viewport: { width: 360, height: 640 } });

// On a short phone the start screen is taller than the room it has: it opened scrolled to its end, the persona's
// picture cut off under the top bar.
test('the start screen of a new chat opens at its top on a small phone', async ({ app }) => {
  const m = app.locator('#messages');
  expect(await m.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true); // it does not fit: the case in question
  expect(await m.evaluate((el) => el.scrollTop)).toBe(0);
  const top = await app.locator('.empty-avatar').evaluate((el) => el.getBoundingClientRect().top - document.querySelector('.topbar').getBoundingClientRect().bottom);
  expect(top).toBeGreaterThanOrEqual(0);
});
