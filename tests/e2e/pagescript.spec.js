import { test, expect } from '@playwright/test';
import { PAGE_SCRIPT } from '../../src/pagescript.js';

// The in-page half of the browser tool, run in a real page (no app, no model).
const HTML = `<title>Wiki</title><nav><a href="#x">Home</a></nav><h1>Veyrath</h1><table class=infobox><tr><th>Born</th><td>1204</td></tr><tr><th>Realm</th><td>Astral</td></tr></table>
<label for=q>Search</label><input id=q placeholder="Find…"><button id=go onclick="document.getElementById('out').textContent='Found '+document.getElementById('q').value">Go</button>
<label><input type=checkbox id=cb> Remember me</label><select id=sel><option>One</option><option>Two</option></select>
<div id=hov onmouseover="this.dataset.h='1'">hover me</div><button onclick="alert('hi');console.log('clicked')">Alert</button><div id=out></div>
<div contenteditable=true id=ce>doc text</div><div id=src draggable=true>drag</div><div id=dst ondrop="this.textContent='dropped'" ondragover="event.preventDefault()">zone</div>`;

test.beforeEach(async ({ page }) => {
  await page.route('https://wiki.test/', (r) => r.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto('https://wiki.test/');
  await page.evaluate(PAGE_SCRIPT);
});
const ev = (page, code) => page.evaluate((c) => { const r = (0, eval)(c); return typeof r === 'string' && /^[\[{"]/.test(r) ? r : JSON.stringify(r); }, code);

test('locators: css, text, role, label, placeholder, xpath', async ({ page }) => {
  const q = async (sel) => JSON.parse(await ev(page, `window.__ocmB.queryAll(${JSON.stringify(sel)},10)`)).total;
  expect(await q('.infobox td')).toBe(2);
  expect(await q('text=Remember me')).toBe(1);
  expect(await q('role=button[name="Go"]')).toBe(1);
  expect(await q('label=Search')).toBe(1);
  expect(await q('placeholder=Find')).toBe(1);
  expect(await q('//h1')).toBe(1);
  expect(await q('role=link[name=Home]')).toBe(1);
});

test('fill, click, check, select, hover, press, drag, get', async ({ page }) => {
  const T = (o) => JSON.stringify(o);
  await ev(page, `window.__ocmB.type(${T({ selector: 'label=Search' })},"Ada",false,false)`);
  await ev(page, `window.__ocmB.click(${T({ selector: 'role=button[name="Go"]' })},{})`);
  expect(await page.textContent('#out')).toBe('Found Ada');
  await ev(page, `window.__ocmB.check(${T({ selector: '#cb' })},true)`);
  expect(await page.isChecked('#cb')).toBe(true);
  await ev(page, `window.__ocmB.type(${T({ selector: '#sel' })},"Two",false,false)`);
  expect(await page.inputValue('#sel')).toBe('Two');
  await ev(page, `window.__ocmB.hover(${T({ selector: '#hov' })})`);
  expect(await page.getAttribute('#hov', 'data-h')).toBe('1');
  await ev(page, `window.__ocmB.drag(${T({ selector: '#src' })},${T({ selector: '#dst' })})`);
  expect(await page.textContent('#dst')).toBe('dropped');
  expect(JSON.parse(await ev(page, `window.__ocmB.get("text",${T({ selector: 'text=Astral' })},"")`))).toBe('Astral');
  expect(JSON.parse(await ev(page, `window.__ocmB.get("count",${T({ selector: '.infobox th' })},"")`))).toBe(2);
});

test('editing the page itself needs force; console, dialogs and storage are captured', async ({ page }) => {
  const T = (o) => JSON.stringify(o);
  const err = await page.evaluate((e) => { try { (0, eval)(e); return 'no error'; } catch (x) { return x.message; } }, `window.__ocmB.type(${T({ selector: '#ce' })},"x",false,false)`);
  expect(err).toMatch(/editable block/);
  await ev(page, `window.__ocmB.click(${T({ selector: 'text=Alert' })},{})`);
  expect(JSON.parse(await ev(page, 'JSON.stringify(window.__ocmLog)')).some((l) => l.m === 'clicked')).toBe(true);
  expect(JSON.parse(await ev(page, 'JSON.stringify(window.__ocmDialogs)'))[0]).toMatchObject({ type: 'alert', message: 'hi' });
  await ev(page, 'window.__ocmB.storage("local","set","k","v")');
  expect(JSON.parse(await ev(page, 'JSON.stringify(window.__ocmB.storage("local","get","k"))'))).toBe('v');
  expect(JSON.parse(await ev(page, 'JSON.stringify(window.__ocmB.cookies("get"))'))).toEqual([]);
});

test('a bad selector gives a clear error', async ({ page }) => {
  const err = await page.evaluate(() => { try { window.__ocmB.click({ selector: 'text=Nope' }, {}); return ''; } catch (x) { return x.message; } });
  expect(err).toMatch(/No element matches/);
});
