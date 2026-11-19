import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeBrowser, viewBrowser } from '../../src/browsercontrol.js';
import { runTool } from '../../src/tools.js';

// What the assistant must be told whatever action it asks for next: the page was opened again (it started over),
// or the user used it. A result without that is read as the state of the page it was working on.
const ID = 'notes1';
let status, shown, evicted;
const snap = () => ({ url: status.url, title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 });
beforeEach(async () => {
  status = { url: '', title: '', error: null, httpStatus: 200 };
  shown = null;
  evicted = false;
  globalThis.__ocmTiles = async () => ['data:image/jpeg;base64,AA=='];
  globalThis.__ocmBrowser = {
    open: async (a) => { status.url = a.url; evicted = false; },
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js === 'window.__ocmPaint||0') return { value: '1' };
      if (js.includes('try{JSON.stringify(window.__ocmLog||[])}')) return { value: '[]' };
      if (js.includes('window.__ocmB.storage(')) return { value: '{}' };
      if (js.includes('window.__ocmB.click(') || js.includes('window.__ocmB.aim(')) return { value: JSON.stringify({ __error: 'No element matches "text=Next"' }) };
      return { value: JSON.stringify(snap()) };
    },
    // the phone closed this page to make room for another chat's: status says there is none
    status: async () => (evicted ? { url: '', title: '', error: null, httpStatus: 0 } : { ...status }),
    screenshot: async () => ({ base64: btoa('x'), width: 390, height: 844 }),
    show: (o) => new Promise((res) => (shown = { o, res })),
    close: async () => {},
  };
  await closeBrowser(ID);
});
afterEach(() => { delete globalThis.__ocmTiles; });
const call = (args, ctx = { convId: ID, settings: {}, vision: true }) => runTool({ name: 'browser', arguments: JSON.stringify(args) }, ctx);

describe('a reopened page is always announced', () => {
  for (const args of [{ action: 'console' }, { action: 'storage', op: 'get' }, { action: 'screenshot' }, { action: 'content' }, { action: 'dialog' }]) {
    it(`${args.action} after the phone closed the page says it was opened again`, async () => {
      await call({ action: 'open', url: 'https://example.com/wizard?step=3' });
      evicted = true;
      const r = await call(args);
      expect(r.ok).toBe(true);
      expect(r.result).toMatch(/was opened again/);
      expect(r.result).toMatch(/started over/);
    });
  }
  it('a click that fails on the reopened page says the page started over, not only "no element"', async () => {
    await call({ action: 'open', url: 'https://example.com/wizard?step=3' });
    evicted = true;
    const r = await call({ action: 'click', selector: 'text=Next' });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/No element matches/);
    expect(r.result).toMatch(/was opened again/);
  });
  it('"the user used the page" is not swallowed by an action that returns data', async () => {
    await call({ action: 'open', url: 'https://example.com/' });
    await viewBrowser(ID);
    shown.res({ done: false, touched: true, url: 'https://example.com/after' });
    await new Promise((r) => setTimeout(r, 0));
    const r = await call({ action: 'console' });
    expect(r.result).toMatch(/The user had this page on screen and used it/);
    const again = await call({ action: 'read' });
    expect(again.result).not.toMatch(/The user had this page/);
  });
});

describe('"the user used the page" only when they used THIS page', () => {
  it('opening another page does not carry the note about the one before (the user never saw the new one)', async () => {
    await call({ action: 'open', url: 'https://example.com/' });
    await viewBrowser(ID);
    shown.res({ done: false, touched: true, url: 'https://example.com/after' });
    await new Promise((r) => setTimeout(r, 0));
    const r = await call({ action: 'open', url: 'https://example.org/fresh' });
    expect(r.ok).toBe(true);
    expect(r.result).not.toMatch(/The user had this page on screen/);
    // …and it is gone for good, not held for the action after
    const next = await call({ action: 'read' });
    expect(next.result).not.toMatch(/The user had this page on screen/);
  });
  it('a watch the user closed without touching the page adds nothing', async () => {
    await call({ action: 'open', url: 'https://example.com/' });
    await viewBrowser(ID);
    shown.res({ done: false, touched: false, url: 'https://example.com/' });
    await new Promise((r) => setTimeout(r, 0));
    const r = await call({ action: 'read' });
    expect(r.result).not.toMatch(/The user had this page on screen/);
  });
});
