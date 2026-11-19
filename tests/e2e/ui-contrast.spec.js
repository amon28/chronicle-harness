import { test, expect, send } from './helpers.js';

test.use({ appSettings: { prefs: { theme: 'light' } } });

// The red of the dark theme (#ff6b6b) was also used on the light one: "Delete" was 2.5:1 on the menu's background.
test('light theme: the red of Delete is readable (WCAG AA, 4.5:1)', async ({ app }) => {
  await send(app, 'hello');
  await app.click('#chat-more-btn');
  await app.click('#cm-more');
  const ratio = await app.locator('#cm-delete .cm-label').evaluate((el) => {
    const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = (c) => {
      const [r, g, b] = rgb(c).map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    let bgEl = el;
    while (bgEl && /rgba?\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(bgEl).backgroundColor)) bgEl = bgEl.parentElement;
    const [a, b] = [lum(getComputedStyle(el).color), lum(getComputedStyle(bgEl).backgroundColor)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});
