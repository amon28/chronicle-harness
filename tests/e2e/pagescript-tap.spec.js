import { test, expect } from '@playwright/test';
import { PAGE_SCRIPT } from '../../src/pagescript.js';

// The page half of a real tap, in a real page (no app needed): where the tap goes must be where the element IS, and
// when a tap cannot reach it the page says why (off screen, covered – by what –, no size, hidden).
const run = async (page, expr) => {
  const v = await page.evaluate(`${PAGE_SCRIPT};try{${expr}}catch(e){JSON.stringify({__error:String(e&&e.message||e)})}`);
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const T = (selector) => JSON.stringify({ id: null, selector, nth: 0 });
const tall = (inner) => `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0"><div style="height:3000px">top</div>${inner}<div style="height:3000px">bottom</div>`;

test('a page that scrolls smoothly: the tap point is where the button is once it is in view, not where it was', async ({ page }) => {
  await page.setContent(`<style>html{scroll-behavior:smooth}</style>${tall('<button id="copy" style="height:40px">Copy</button>')}`);
  const a = await run(page, `window.__ocmB.aim(${T('#copy')})`);
  // what is under that point right now is the button itself (it used to be measured mid-scroll, ~3000px below)
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [a.x, a.y])).toBe('copy');
  expect(a.y).toBeLessThan(await page.evaluate(() => innerHeight));
  expect(a.off).toBe(false);
});

test('what keeps a tap from reaching an element is named: covered (by what), no size, hidden', async ({ page }) => {
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0">
    <button id="copy" style="margin-top:300px;height:40px">Copy</button>
    <div id="cb" class="cookie-banner" style="position:fixed;left:0;right:0;top:250px;height:200px;background:#333;color:#fff">We use cookies <button>OK</button></div>
    <button id="zero" style="width:0;height:0;padding:0;border:0"></button>
    <button id="ghost" style="visibility:hidden">Ghost</button>`);
  const c = await run(page, `window.__ocmB.aim(${T('#copy')})`);
  expect(c.covered).toMatch(/^div#cb\.cookie-banner "We use cookies OK"/);
  const z = await run(page, `window.__ocmB.where(${T('#zero')})`);
  expect(z.zero).toBe(true);
  const g = await run(page, `window.__ocmB.where(${T('#ghost')})`);
  expect(g.hidden).toBe('visibility:hidden');
  // where only looks: it does not scroll
  await page.evaluate(() => scrollTo(0, 0));
  await run(page, `window.__ocmB.where(${T('#copy')})`);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test('aiming twice arms one click check, and the click on the element is seen', async ({ page }) => {
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><body><button id="b">B</button>`);
  await run(page, `window.__ocmB.aim(${T('#b')})`);
  await run(page, `window.__ocmB.aim(${T('#b')})`);
  await page.click('#b');
  const got = await run(page, 'window.__ocmB.aimed()');
  expect(got.hit).toBe(true);
  expect(got.trusted).toBe(true);
});
