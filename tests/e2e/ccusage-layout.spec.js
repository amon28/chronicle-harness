import { test, expect } from './helpers.js';

// The Claude usage sheet's rows (decision 165) at the largest text size on a small phone: the window's name stays on
// one line; when the reset time does not fit beside it, it moves under it instead of squeezing both into narrow columns.
test.use({ viewport: { width: 360, height: 640 }, appSettings: { prefs: { textSize: 'xl' } } });
test('usage rows keep their label on one line at the largest text size', async ({ app }) => {
  const r = await app.evaluate(() => {
    const box = document.getElementById('ccu-list');
    box.innerHTML = '';
    for (const [label, rest] of [['5-hour limit', '32% · resets Sat, Nov 14, 3:00 PM'], ['Weekly · all models', '61% · resets Wed, Nov 18, 9:00 AM'], ['Weekly · Opus', '12% · resets Wed, Nov 18, 9:00 AM']]) {
      box.insertAdjacentHTML('beforeend', `<div class="meter"><div class="meter-top"><span>${label}</span><span class="dim">${rest}</span></div><div class="meter-bar"><i style="width:40%"></i></div></div>`);
    }
    document.getElementById('cc-usage-sheet').classList.add('open');
    return [...box.querySelectorAll('.meter-top')].map((t) => {
      const [a, b] = t.children;
      const lh = parseFloat(getComputedStyle(a).lineHeight) || parseFloat(getComputedStyle(a).fontSize) * 1.55;
      return { label: a.textContent, labelLines: Math.round(a.getBoundingClientRect().height / lh), restLines: Math.round(b.getBoundingClientRect().height / (parseFloat(getComputedStyle(b).lineHeight) || lh)) };
    });
  });
  for (const x of r) {
    expect(x.labelLines, x.label).toBe(1);
    expect(x.restLines, x.label).toBe(1);
  }
});
