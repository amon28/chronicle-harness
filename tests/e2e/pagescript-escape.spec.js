import { test, expect } from '@playwright/test';
import { PAGE_SCRIPT } from '../../src/pagescript.js';

// "press Escape" is what the browser tool tells the assistant to do with a popup. A key event made by script is not
// a real key: the browser's own handling (closing a modal <dialog> or a popover) does not happen unless the tool does it.
const run = async (page, expr) => {
  const v = await page.evaluate(`${PAGE_SCRIPT};try{${expr}}catch(e){JSON.stringify({__error:String(e&&e.message||e)})}`);
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const HEAD = '<!doctype html><meta name="viewport" content="width=device-width">';

test('Escape closes a modal <dialog>, as a real key press would, and says so', async ({ page }) => {
  await page.setContent(`${HEAD}<button id="o">under</button><dialog id="d" aria-label="Subscribe"><p>Subscribe!</p><button>No thanks</button></dialog><script>d.showModal();d.addEventListener('close',()=>document.title='closed')</script>`);
  const r = await run(page, 'window.__ocmB.press("Escape",null,{})');
  expect(await page.evaluate('d.open')).toBe(false);
  await expect(page).toHaveTitle('closed'); // the close event comes a task later
  expect(r).toMatch(/^Escape closed the dialog dialog#d "Subscribe"/);
});

test('a dialog that refuses to be cancelled stays open, and a page that handles Escape itself is left to it', async ({ page }) => {
  await page.setContent(`${HEAD}<dialog id="d"><button>Must choose</button></dialog><script>d.showModal();d.addEventListener('cancel',e=>e.preventDefault())</script>`);
  expect(await run(page, 'window.__ocmB.press("Escape",null,{})')).toBe('pressed');
  expect(await page.evaluate('d.open')).toBe(true);
  await page.setContent(`${HEAD}<dialog id="d"><button>x</button></dialog><script>d.showModal();addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();document.title='mine'}})</script>`);
  expect(await run(page, 'window.__ocmB.press("Escape",null,{})')).toBe('pressed');
  expect(await page.evaluate('d.open')).toBe(true);
  expect(await page.title()).toBe('mine');
});

test('Escape closes an open popover', async ({ page }) => {
  await page.setContent(`${HEAD}<button id="o">under</button><div popover id="p">Pop <button>Close</button></div><script>p.showPopover()</script>`);
  const r = await run(page, 'window.__ocmB.press("Escape",null,{})');
  expect(await page.evaluate('p.matches(":popover-open")')).toBe(false);
  expect(r).toMatch(/^Escape closed the popover div#p/);
});

test('other keys and a page without a dialog are unchanged', async ({ page }) => {
  await page.setContent(`${HEAD}<dialog id="d"><button>x</button></dialog><script>d.showModal()</script>`);
  // Enter on the focused button clicks it, as a real key would (decision 211) – the dialog is not closed by it
  expect(await run(page, 'window.__ocmB.press("Enter",null,{})')).toMatch(/^pressed/);
  expect(await page.evaluate('d.open')).toBe(true);
  await page.setContent(`${HEAD}<p>plain</p>`);
  expect(await run(page, 'window.__ocmB.press("Escape",null,{})')).toBe('pressed');
});

test('a click on a disabled button is refused with the reason, not reported as clicked', async ({ page }) => {
  await page.setContent(`${HEAD}<input id="agree" type="checkbox"><button id="next" disabled onclick="document.title='went'">Next</button>`);
  const r = await run(page, 'window.__ocmB.click({"id":null,"selector":"#next","nth":0},{})');
  expect(r.__error).toMatch(/disabled/);
  await page.evaluate('next.disabled=false');
  expect(await run(page, 'window.__ocmB.click({"id":null,"selector":"#next","nth":0},{})')).toBe('clicked');
  expect(await page.title()).toBe('went');
});
