import { describe, it, expect, beforeEach } from 'vitest';
import { closeBrowser, runBrowser } from '../../src/browsercontrol.js';

// A run of steps used to carry the page (its element list and text) at every step – the start of it at each earlier
// step, all of it at the last: one failed 9-step run repeated the same page text over and over.
const ID = 'steps-b1';
const TEXT = 'Article start. ' + 'Lorem ipsum dolor sit amet. '.repeat(110); // ~3 KB
beforeEach(async () => {
  globalThis.__ocmBrowser = {
    open: async () => {},
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js.includes('try{window.__ocmB.check_(')) return { value: 'false' };
      return { value: JSON.stringify({ url: 'https://example.com/a', title: 'An article', text: TEXT, textFrom: 0, textLen: TEXT.length, elements: ['[1] link "Home"', '[2] button "Menu"'], scrollY: 0, pageHeight: 4000, viewHeight: 800 }) };
    },
    close: async () => {},
  };
  await closeBrowser(ID);
});
const count = (s, x) => s.split(x).length - 1;

describe('steps', () => {
  it('a failed run shows the page once, and earlier steps keep their address and notes', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/a' }, { convId: ID });
    const steps = [{ action: 'read' }, { action: 'scroll', y: 800 }, { action: 'read' }, { action: 'scroll', y: 1600 }, { action: 'click', selector: 'text=Home' }, { action: 'scroll', y: 0 }, { action: 'read' }, { action: 'read' }, { action: 'wait_for', text_present: 'never there', timeout_ms: 300 }];
    const r = await runBrowser({ steps }, { convId: ID });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/#9 wait_for: FAILED – Timed out waiting for text never there/);
    expect(count(r.result, 'Article start.')).toBe(1);
    expect(count(r.result, '[2] button "Menu"')).toBe(1);
    // each earlier step still says where the page is, and the click keeps its note
    expect(count(r.result, 'URL: https://example.com/a')).toBe(9);
    expect(r.result).toMatch(/#5 click text=Home: Clicked by script[^\n]*\nPage: An article · URL: https:\/\/example\.com\/a/);
    expect(r.result).toMatch(/The page as step #8 left it:\nPage: An article/);
    expect(r.result.length).toBeLessThan(TEXT.length + 3000);
  });
  it('a run that ends on a page shows it in full there, once', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/a' }, { convId: ID });
    const r = await runBrowser({ steps: [{ action: 'read' }, { action: 'scroll', y: 800 }, { action: 'read' }] }, { convId: ID });
    expect(r.ok).toBe(true);
    expect(count(r.result, 'Article start.')).toBe(1);
    expect(r.result.split('\n\n#3 read: ')[1]).toContain(TEXT);
  });
});
