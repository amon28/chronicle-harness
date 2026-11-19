import { describe, it, expect, beforeEach } from 'vitest';
import { closeBrowser, runBrowser } from '../../src/browsercontrol.js';

const ID = 'reopen1';
let opened, url, gone;
beforeEach(async () => {
  opened = [];
  url = '';
  gone = false;
  globalThis.__ocmBrowser = {
    open: async (a) => { opened.push(a); url = a.url; gone = false; },
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js.startsWith('JSON.stringify([innerWidth')) return { value: JSON.stringify([opened.at(-1).width, opened.at(-1).height, opened.at(-1).width]) };
      return { value: JSON.stringify({ url, title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) };
    },
    status: async () => ({ url: gone ? '' : url, title: 'T', error: null, httpStatus: 200 }),
    close: async () => {},
  };
  await closeBrowser(ID);
});

describe('a page opened again keeps the window it had', () => {
  it('the size set with viewport is used again after the phone closed the page', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    const v = await runBrowser({ action: 'viewport', width: 1024, height: 768 }, { convId: ID });
    expect(v.result).toMatch(/Viewport asked 1024×768/);
    gone = true; // a fifth chat opened a page: this one was closed to make room
    const r = await runBrowser({ action: 'read' }, { convId: ID });
    expect(r.result).toMatch(/opened again/);
    expect(opened.at(-1)).toMatchObject({ url: 'https://example.com/', width: 1024, height: 768, mobile: false });
  });
  it('a new open starts from the view asked for, not from an older viewport', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    await runBrowser({ action: 'viewport', width: 1024, height: 768 }, { convId: ID });
    await runBrowser({ action: 'open', url: 'https://example.com/b' }, { convId: ID });
    await closeBrowser(ID);
    await runBrowser({ action: 'read' }, { convId: ID });
    expect(opened.at(-1)).toMatchObject({ url: 'https://example.com/b', width: 390, height: 844, mobile: true });
  });
});
