import { test, expect } from './helpers.js';

// The model picker's Claude Code section (decision 166) in the app's own styles: its header like every other section
// header (small capitals, the quiet text colour) and its clay "claude" chip readable on the light theme too.
const contrast = (a, b) => {
  const lum = (c) => {
    const [r, g, b2] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map((v) => {
      const x = Number(v) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// the chip's colours as painted: its text, and its translucent background laid over the sheet
const chipColours = (app) =>
  app.evaluate(() => {
    const list = document.createElement('div');
    list.id = 'model-list';
    list.innerHTML = '<div class="cc-models-head"><span class="cc-models-title">Claude Code (your subscription)</span></div><div class="model-item cc-model"><span class="badge claude">claude</span></div>';
    document.querySelector('#model-sheet .sheet-card').append(list);
    const chip = list.querySelector('.badge.claude');
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const g = c.getContext('2d');
    g.fillStyle = getComputedStyle(document.querySelector('#model-sheet .sheet-card')).backgroundColor;
    g.fillRect(0, 0, 1, 1);
    g.fillStyle = getComputedStyle(chip).backgroundColor;
    g.fillRect(0, 0, 1, 1);
    const bg = g.getImageData(0, 0, 1, 1).data;
    const head = getComputedStyle(list.querySelector('.cc-models-head'));
    const label = getComputedStyle(document.querySelector('.empty-label') || document.querySelector('.section') || document.body);
    return { fg: getComputedStyle(chip).color, bg: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`, headCase: head.textTransform, headSpacing: head.letterSpacing, headColor: head.color, text3: label.color };
  });

for (const theme of ['light', 'dark']) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme, appSettings: { prefs: { theme } } });
    test(`the claude chip is readable and the section header is a section header (${theme})`, async ({ app }) => {
      const s = await chipColours(app);
      expect(contrast(s.fg, s.bg), `${s.fg} on ${s.bg}`).toBeGreaterThanOrEqual(4.5);
      expect(s.headCase).toBe('uppercase');
      expect(s.headColor).toBe(s.text3);
    });
  });
}
