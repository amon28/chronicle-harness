import { describe, it, expect, beforeEach } from 'vitest';
import { closeBrowser, viewBrowser } from '../../src/browsercontrol.js';
import { runTool } from '../../src/tools.js';

let status, shown;
beforeEach(async () => {
  status = { url: '', title: '', error: null, httpStatus: 200 };
  shown = null;
  globalThis.__ocmBrowser = {
    open: async (a) => {
      status.url = a.url;
    },
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js === 'window.__ocmPaint||0') return { value: '1' };
      return { value: JSON.stringify({ url: status.url, title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) };
    },
    status: async () => ({ ...status }),
    show: (o) => new Promise((res) => (shown = { o, res })),
    close: async () => {},
  };
  await closeBrowser('w1');
});

describe('watching the browser', () => {
  it('after the user used the page on screen, the next browser result says so (once)', async () => {
    const ctx = { convId: 'w1', settings: {}, vision: true };
    await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'open', url: 'https://example.com/' }) }, ctx);
    expect(await viewBrowser('w1')).toBe(true);
    expect(shown.o.view).toBe(true);
    shown.res({ done: false, touched: true, url: 'https://example.com/after' });
    await new Promise((r) => setTimeout(r, 0));
    const r = await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'read' }) }, ctx);
    expect(r.result).toMatch(/^\[The user had this page on screen and used it/);
    expect(r.result).toContain('https://example.com/after');
    const again = await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'read' }) }, ctx);
    expect(again.result).not.toMatch(/The user had this page/);
  });

  it('just watching (no touch) adds nothing', async () => {
    const ctx = { convId: 'w1', settings: {}, vision: true };
    await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'open', url: 'https://example.com/' }) }, ctx);
    await viewBrowser('w1');
    shown.res({ done: false, touched: false });
    await new Promise((r) => setTimeout(r, 0));
    const r = await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'read' }) }, ctx);
    expect(r.result).not.toMatch(/The user had this page/);
  });
});
