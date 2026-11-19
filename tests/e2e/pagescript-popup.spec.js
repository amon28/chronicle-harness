import { test, expect } from '@playwright/test';
import { PAGE_SCRIPT } from '../../src/pagescript.js';

// The page half of the browser tool, run in a real page (no app needed): what the assistant is told about a popup.
const run = async (page, expr) => {
  const v = await page.evaluate(`${PAGE_SCRIPT};try{${expr}}catch(e){JSON.stringify({__error:String(e&&e.message||e)})}`);
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const links = (n) => Array.from({ length: n }, (_, i) => `<a href="/a${i}" style="display:block;height:20px">Story ${i}</a>`).join('');
const WALL = `<div id="cmp" class="cookie-wall" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99"><div style="margin:200px 40px;background:#fff;padding:20px">We value your privacy <button id="acc" onclick="document.getElementById('cmp').remove()">Accept all</button><button>Reject</button></div></div>`;

test('a cookie wall on a page with many links: its buttons are in the list, first, and the wall is named', async ({ page }) => {
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0">${links(120)}${WALL}`);
  const s = await run(page, 'window.__ocmB.snapshot()');
  expect(s.elements[0]).toBe('[1] button "Accept all" (in the popup)');
  expect(s.elements[1]).toContain('Reject');
  expect(s.elements[2]).toContain('Story 0');
  expect(s.overlay).toMatchObject({ pct: 100, frame: false, n: 2 });
  expect(s.overlay.what).toContain('div#cmp.cookie-wall "We value your privacy');
  // the number works
  await run(page, 'window.__ocmB.click({"id":1,"selector":null,"nth":0},{})');
  expect(await page.locator('#cmp').count()).toBe(0);
  const after = await run(page, 'window.__ocmB.snapshot()');
  expect(after.overlay).toBeNull();
  expect(after.elements[0]).toContain('Story 0');
});

test('a bottom cookie bar on a page with many links: its button is in the list although it is last in the document', async ({ page }) => {
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0">${links(120)}<div style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#222;color:#fff">Cookies? <button>OK, got it</button></div>`);
  const s = await run(page, 'window.__ocmB.snapshot()');
  expect(s.elements.some((l) => l.includes('OK, got it'))).toBe(true);
  expect(s.overlay).toBeNull(); // a bar is not "on top of the page"
});

test('what covers a click target is named so it can be recognised', async ({ page }) => {
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0">${links(5)}${WALL}`);
  const aim = await run(page, 'window.__ocmB.aim({"id":null,"selector":"text=Story 2","nth":0})');
  expect(aim.covered).toContain('div#cmp.cookie-wall "We value your privacy');
});

test('a consent frame from another site over the page is reported, with what to do', async ({ page }) => {
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0"><p>${'Article text. '.repeat(30)}</p><button>Buy</button><iframe id="consent" title="Privacy choices" src="data:text/html,<button>Agree</button>" style="position:fixed;inset:0;width:100%;height:100%;border:0;z-index:9"></iframe>`);
  await page.waitForTimeout(200);
  const s = await run(page, 'window.__ocmB.snapshot()');
  expect(s.overlay).toMatchObject({ pct: 100, frame: true, n: 0 });
  expect(s.overlay.what).toContain('iframe#consent "Privacy choices"');
});

test('an app that lives in one fixed box, a pinned header and a plain page are not called a popup', async ({ page }) => {
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0"><header style="position:fixed;top:0;left:0;right:0;height:56px">Site name and menu</header><div id="app" style="position:fixed;inset:56px 0 0 0;overflow:auto">${links(30)}<p>${'Lots of app text. '.repeat(40)}</p></div>`);
  expect((await run(page, 'window.__ocmB.snapshot()')).overlay).toBeNull();
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0"><header style="position:fixed;top:0;left:0;right:0;height:56px">Site</header>${links(30)}`);
  expect((await run(page, 'window.__ocmB.snapshot()')).overlay).toBeNull();
});

test('a modal dialog inside such an app is reported', async ({ page }) => {
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0"><div id="app" style="position:fixed;inset:0;overflow:auto">${links(30)}<p>${'Lots of app text. '.repeat(40)}</p><div role="dialog" aria-modal="true" aria-label="Sign up for our newsletter" style="position:fixed;left:20px;right:20px;top:200px;height:400px;background:#fff"><button aria-label="Close">×</button></div></div>`);
  const s = await run(page, 'window.__ocmB.snapshot()');
  expect(s.overlay.what).toContain('"Sign up for our newsletter"');
  expect(s.elements[0]).toBe('[1] button "Close" (in the popup)');
});
