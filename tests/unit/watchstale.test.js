import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeBrowser, viewBrowser, runBrowser } from '../../src/browsercontrol.js';

const ID = 'stale1';
let url, shown;
beforeEach(async () => {
  url = '';
  shown = null;
  globalThis.__ocmBrowserIdleMs = 60;
  globalThis.__ocmBrowser = {
    open: async (a) => { url = a.url; },
    eval: async ({ js }) => (js === 'document.readyState' ? { value: '"complete"' } : { value: JSON.stringify({ url, title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) }),
    show: (o) => new Promise((res) => (shown = { o, res })),
    // closing a page that is on screen ends the watch (BrowserPlugin.destroySess → endShow)
    close: async () => { url = ''; shown?.res({ done: false, touched: true, url: 'https://old.example/checkout' }); },
  };
  await closeBrowser(ID);
});
afterEach(() => { delete globalThis.__ocmBrowserIdleMs; });

describe('"the user used the page" belongs to the page it was about', () => {
  it('is not carried over to another page opened after that one was closed', async () => {
    await runBrowser({ action: 'open', url: 'https://old.example/' }, { convId: ID });
    await viewBrowser(ID);
    await runBrowser({ action: 'close' }, { convId: ID });
    await new Promise((r) => setTimeout(r, 0));
    const r = await runBrowser({ action: 'open', url: 'https://new.example/' }, { convId: ID });
    expect(r.result).not.toMatch(/The user had this page on screen/);
    expect(r.result).not.toMatch(/old\.example/);
  });
  it('a page the user is watching is not closed as idle under their finger', async () => {
    await runBrowser({ action: 'open', url: 'https://old.example/' }, { convId: ID });
    await viewBrowser(ID);
    await new Promise((r) => setTimeout(r, 200)); // well past the idle limit
    expect(url).toBe('https://old.example/');
    shown.res({ done: false, touched: false }); // they closed the watch screen: the idle clock starts again
    await new Promise((r) => setTimeout(r, 200));
    expect(url).toBe('');
  });
});
