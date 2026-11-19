import { describe, it, expect, beforeEach } from 'vitest';
import { closeBrowser, runBrowser, abandonBrowser } from '../../src/browsercontrol.js';

const ID = 'stuck1';
let url;
beforeEach(async () => {
  url = '';
  globalThis.__ocmBrowser = {
    open: async (a) => { url = a.url; },
    eval: async ({ js }) => (js === 'document.readyState' ? { value: '"complete"' } : { value: JSON.stringify({ url, title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) }),
    close: async () => {},
  };
  await closeBrowser(ID);
});

describe('a browser action that never comes back', () => {
  it('does not block the chat\'s browser for good once the engine gave up on it', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    const good = globalThis.__ocmBrowser.eval;
    let wake;
    globalThis.__ocmBrowser.eval = () => new Promise((r) => (wake = r)); // the page hangs (a dead renderer, a blocking dialog)
    const stuck = runBrowser({ action: 'read' }, { convId: ID });
    stuck.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    await abandonBrowser(ID); // what the engine does at the tool's time limit, or on Stop
    globalThis.__ocmBrowser.eval = good;
    const next = await Promise.race([runBrowser({ action: 'open', url: 'https://example.com/again' }, { convId: ID }), new Promise((r) => setTimeout(() => r('still waiting'), 3000))]);
    expect(next).not.toBe('still waiting');
    expect(next.ok).toBe(true);
    // the abandoned action wakes up late: it is cut off instead of acting on the new page
    wake({ value: '"complete"' });
    await expect(stuck).rejects.toThrow(/was stopped/);
  });
});
