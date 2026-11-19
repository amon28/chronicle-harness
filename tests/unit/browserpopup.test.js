import { describe, it, expect, beforeEach } from 'vitest';
import { closeBrowser, runBrowser } from '../../src/browsercontrol.js';

const ID = 'popup1';
let overlay, covered, tapped;
const snap = () => ({ overlay, url: 'https://example.com/', title: 'News', text: 'hello', textFrom: 0, textLen: 5, elements: ['[1] button "Accept all" (in the popup)', '[2] link "Story 0"'], scrollY: 0, pageHeight: 800, viewHeight: 800 });
beforeEach(async () => {
  overlay = null;
  covered = '';
  tapped = 0;
  globalThis.__ocmBrowser = {
    open: async () => {},
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js.includes('try{window.__ocmB.aim(') || js.includes('try{window.__ocmB.where(')) return { value: JSON.stringify({ x: 10, y: 10, vw: 390, covered }) };
      if (js.includes('try{window.__ocmB.click(')) return { value: '"clicked"' };
      return { value: JSON.stringify(snap()) };
    },
    tap: async () => { tapped++; },
    close: async () => {},
  };
  await closeBrowser(ID);
});

describe('a popup over the page', () => {
  it('is named in what the assistant reads, with where its buttons are', async () => {
    overlay = { what: 'div#cmp.cookie-wall "We value your privacy Accept all Reject"', pct: 100, frame: false, n: 2 };
    const r = await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    expect(r.result).toMatch(/On top of the page: div#cmp\.cookie-wall "We value your privacy Accept all Reject" – it covers 100% of the screen/);
    expect(r.result).toMatch(/its 2 controls are first in the list below, marked \(in the popup\)/);
    expect(r.result.indexOf('On top of the page')).toBeLessThan(r.result.indexOf('Things you can use'));
  });
  it('a frame from another site: the buttons are not in the list, so a tap at x/y is the way', async () => {
    overlay = { what: 'iframe#consent "Privacy choices" from cmp.example', pct: 100, frame: true, n: 0 };
    const r = await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    expect(r.result).toMatch(/frame from another site, so its buttons are NOT in the list/);
    expect(r.result).toMatch(/mouse kind click/);
  });
  it('no popup: nothing is added', async () => {
    const r = await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    expect(r.result).not.toMatch(/On top of the page/);
  });
  it('a click on something covered says what covers it and what to do about it', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    covered = 'div#cmp.cookie-wall "We value your privacy"';
    const r = await runBrowser({ action: 'click', id: 2 }, { convId: ID });
    expect(tapped).toBe(0);
    expect(r.result).toMatch(/div#cmp\.cookie-wall "We value your privacy" is on top of it – if this click changed nothing, close that first/);
  });
});
