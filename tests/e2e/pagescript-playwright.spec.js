import { test, expect } from '@playwright/test';
import { PAGE_SCRIPT } from '../../src/pagescript.js';
import { STATE_DUMP, STATE_LOAD } from '../../src/pagestate.js';

// The page half of the browser tool, run in a real Chromium page (decision 211): Playwright-style selector chains and
// filters, what a key does when only a script-made key reaches the page, frames from other sites in the element
// list, dispatch_event, extra request headers and offline mode, and a site's storage saved and put back.
const SITE = 'https://site.test/';
const HTML = `<!doctype html><title>Shop</title><h1>Top</h1><h2 id=h2>Second</h2>
<div class=card><span>Alpha</span><button>Buy</button></div>
<div class=card><span>Beta</span><button>Buy</button></div>
<label for=a>Name</label><input id=a value="hello">
<input id=b><span id=lb>Email box</span><input aria-labelledby=lb id=c>
<input type=checkbox id=cb checked aria-label="Agree">
<select id=s><option>one<option>two<option>three</select>
<div id=ed contenteditable=true>abc</div>
<a id=lnk href="#went">Go</a>
<button id=last onclick="this.dataset.n=(+this.dataset.n||0)+1">Save changes</button>
<iframe src="https://ads.other.test/frame" style="width:300px;height:100px" title="Ad"></iframe>
<iframe src="http://192.168.1.1/admin" style="width:100px;height:50px" title="Router"></iframe>`;

test.beforeEach(async ({ page }) => {
  await page.route('https://site.test/**', (r) => (r.request().url().endsWith('/api') ? r.fulfill({ body: JSON.stringify({ auth: r.request().headers()['x-test'] || null }), contentType: 'application/json' }) : r.fulfill({ body: HTML, contentType: 'text/html' })));
  await page.route('https://ads.other.test/**', (r) => r.fulfill({ body: '<p>ad</p>', contentType: 'text/html' }));
  await page.route('http://192.168.1.1/**', (r) => r.abort());
  await page.goto(SITE);
  await page.evaluate(PAGE_SCRIPT);
});
const all = (page, sel) => page.evaluate((sel) => JSON.parse(window.__ocmB.queryAll(sel, 10)), sel);

test('selector chains and filters like Playwright', async ({ page }) => {
  const n = async (sel) => (await all(page, sel)).total;
  expect(await n('.card >> text=Buy')).toBe(2);
  expect((await all(page, '.card >> has-text=Beta >> button')).items[0].text).toBe('Buy');
  expect((await all(page, '.card >> nth=-1')).items[0].text).toBe('BetaBuy');
  expect((await all(page, 'button:has-text("Save")')).items[0].id).toBe('last');
  expect((await all(page, 'text=/sec.nd/i')).items[0].id).toBe('h2');
  expect((await all(page, 'role=heading[level=2]')).items[0].id).toBe('h2');
  expect(await n('role=heading[name="top"i]')).toBe(1);
  expect(await n('role=button[name="Buy"s]')).toBe(2);
  expect(await n('role=button[name="buy"s]')).toBe(0); // s: exact, case too
  expect((await all(page, 'role=button[name=/save/i]')).items[0].id).toBe('last');
  expect((await all(page, 'role=textbox[name="Email box"]')).items[0].id).toBe('c'); // aria-labelledby
  expect(await n('role=checkbox[checked=true]')).toBe(1);
  expect(await n('role=checkbox[checked=false]')).toBe(0);
  expect(await n('span:text-is("Alpha")')).toBe(1);
  // has_text on a click (locator.filter({hasText}))
  expect(await page.evaluate(() => window.__ocmB.click({ selector: 'button', has_text: 'save' }))).toBeTruthy();
  expect(await page.locator('#last').getAttribute('data-n')).toBe('1');
});

test('a script-made key does what the key would: Tab, Backspace, arrows, a dropdown, an editable block, Enter on a link', async ({ page }) => {
  const press = (k, t, m = {}) => page.evaluate(([k, t, m]) => window.__ocmB.press(k, t, m), [k, t, m]);
  expect(await press('Tab', { selector: '#a' })).toMatch(/done by hand.*focus moved to input#b/);
  expect(await page.evaluate(() => document.activeElement.id)).toBe('b');
  expect(await press('Tab', null, { shift: true })).toMatch(/input#a/);
  await page.evaluate(() => document.querySelector('#a').setSelectionRange(5, 5));
  await press('Backspace', null);
  expect(await page.inputValue('#a')).toBe('hell');
  await press('ArrowLeft', null);
  await press('ArrowLeft', null);
  expect(await page.evaluate(() => document.querySelector('#a').selectionStart)).toBe(2);
  await press('Delete', null);
  expect(await page.inputValue('#a')).toBe('hel');
  await press('Home', null, { shift: true });
  expect(await page.evaluate(() => [document.querySelector('#a').selectionStart, document.querySelector('#a').selectionEnd])).toEqual([0, 2]);
  expect(await press('ArrowDown', { selector: '#s' })).toMatch(/picked "two"/);
  expect(await page.inputValue('#s')).toBe('two');
  await page.evaluate(() => { const e = document.querySelector('#ed'); e.focus(); const r = document.createRange(); r.setStart(e.firstChild, 3); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await press('Backspace', null);
  expect(await page.textContent('#ed')).toBe('ab');
  await press('Enter', { selector: '#lnk' });
  expect(await page.evaluate(() => location.hash)).toBe('#went');
  // a key the page itself handles (preventDefault) is left to the page
  await page.evaluate(() => document.querySelector('#b').addEventListener('keydown', (e) => e.preventDefault()));
  expect(await press('Tab', { selector: '#b' })).toBe('pressed');
});

test('a frame from another site is listed with where it is; dispatch_event; a real key is counted', async ({ page }) => {
  const s = JSON.parse(await page.evaluate(() => window.__ocmB.snapshot()));
  expect(s.elements.find((l) => l.startsWith('[frame]'))).toMatch(/^\[frame\] from ads\.other\.test "Ad" at x \d+–\d+, y \d+–\d+ – another site/);
  // a frame from the user's own network was never loaded (decision 268): not offered as a box to click into
  const lan = s.elements.find((l) => l.includes('192.168.1.1'));
  expect(lan).toMatch(/^\[frame\] to 192\.168\.1\.1 – NOT LOADED: the app blocks local-network addresses/);
  expect(lan).not.toMatch(/mouse kind click/);
  expect(await page.evaluate(() => window.__ocmB.dispatch({ selector: '#last' }, 'click', {}))).toMatch(/sent click to button#last/);
  expect(await page.locator('#last').getAttribute('data-n')).toBe('1');
  await page.evaluate(() => document.querySelector('#last').addEventListener('hello', (e) => (document.title = 'got ' + e.detail.x)));
  await page.evaluate(() => window.__ocmB.dispatch({ selector: '#last' }, 'hello', { detail: { x: 7 } }));
  expect(await page.title()).toBe('got 7');
  await page.focus('#b');
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => window.__ocmKeySeen)).toBe(1);
});

test('extra headers go on fetch / XHR; offline makes fetch fail; window.open is the browser\'s own again', async ({ page }) => {
  await page.evaluate(() => (window.__ocmHdr = { 'x-test': 'yes' }));
  expect(await page.evaluate(() => fetch('/api').then((r) => r.json()))).toEqual({ auth: 'yes' });
  expect(await page.evaluate(() => new Promise((ok) => { const x = new XMLHttpRequest(); x.open('GET', '/api'); x.onload = () => ok(JSON.parse(x.responseText)); x.send(); }))).toEqual({ auth: 'yes' });
  await page.evaluate(() => (window.__ocmOff = true));
  expect(await page.evaluate(() => fetch('/api').then(() => 'ok', (e) => e.message))).toBe('Failed to fetch');
  const net = await page.evaluate(() => window.__ocmNet.at(-1));
  expect(net).toMatchObject({ s: 'offline' });
  expect(typeof net.t).toBe('number');
  expect(await page.evaluate(() => /\[native code\]/.test(String(window.open)))).toBe(true);
});

test('state: storage and IndexedDB saved, then put back after they were wiped', async ({ page }) => {
  await page.evaluate(async () => {
    localStorage.setItem('token', 'abc');
    sessionStorage.setItem('tab', '2');
    await new Promise((ok) => {
      const r = indexedDB.open('firebaseLocalStorageDb', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
      r.onsuccess = () => { const tx = r.result.transaction('firebaseLocalStorage', 'readwrite'); tx.objectStore('firebaseLocalStorage').put({ fbase_key: 'user', value: { uid: 'ada' } }); tx.oncomplete = () => (r.result.close(), ok()); };
    });
  });
  const run = (body) => page.evaluate((body) => new (Object.getPrototypeOf(async () => {}).constructor)(body)(), body);
  const st = await run(STATE_DUMP);
  expect(st.local).toEqual({ token: 'abc' });
  expect(st.session).toEqual({ tab: '2' });
  expect(st.idb[0]).toMatchObject({ name: 'firebaseLocalStorageDb', stores: [{ name: 'firebaseLocalStorage', keyPath: 'fbase_key', records: [[null, { fbase_key: 'user', value: { uid: 'ada' } }]] }] });
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await new Promise((ok) => { const r = indexedDB.open('firebaseLocalStorageDb'); r.onsuccess = () => { const tx = r.result.transaction('firebaseLocalStorage', 'readwrite'); tx.objectStore('firebaseLocalStorage').clear(); tx.oncomplete = () => (r.result.close(), ok()); }; });
  });
  expect(await run(STATE_LOAD(st))).toBe(0);
  const back = await run(STATE_DUMP);
  expect(back.local).toEqual(st.local);
  expect(back.idb[0].stores[0].records).toEqual(st.idb[0].stores[0].records);
  // a database the page does not have is made
  await page.evaluate(() => new Promise((ok) => { const r = indexedDB.deleteDatabase('firebaseLocalStorageDb'); r.onsuccess = ok; }));
  expect(await run(STATE_LOAD(st))).toBe(0);
  expect((await run(STATE_DUMP)).idb[0].stores[0].records).toHaveLength(1);
});
