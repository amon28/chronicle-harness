import { describe, it, expect, beforeEach } from 'vitest';
import { closeBrowser, runBrowser } from '../../src/browsercontrol.js';

// A real tap that misses its element: the browser finds out why, scrolls it into view, waits for it to hold still and
// taps once more – a copy button needs the real tap (user activation) – and only then clicks it from script, saying why.
const ID = 'tap1';
let page, taps, scripted;
const box = (o) => ({ x: 100, y: 300, vw: 390, vh: 844, l: 50, t: 280, w: 100, h: 40, zero: false, off: false, hidden: '', covered: '', ...o });
beforeEach(async () => {
  taps = [];
  scripted = 0;
  // page.looks: what aim()/where() answer, one after another (the last one repeats); page.hits: what each tap does
  page = { looks: [box()], hits: [{ hit: true, trusted: true, active: true }] };
  const next = () => (page.looks.length > 1 ? page.looks.shift() : page.looks[0]);
  globalThis.__ocmBrowser = {
    open: async () => {},
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js.includes('try{window.__ocmB.aim(') || js.includes('try{window.__ocmB.where(')) return { value: JSON.stringify(JSON.stringify(next())) };
      if (js.includes('try{window.__ocmAim?window.__ocmB.aimed()')) return { value: JSON.stringify(JSON.stringify(page.hits[Math.min(taps.length, page.hits.length) - 1] || { hit: false })) };
      if (js.includes('try{window.__ocmB.click(')) return (scripted++, { value: '"clicked"' });
      return { value: JSON.stringify({ url: 'https://example.com/', title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) };
    },
    tap: async (a) => {
      taps.push(a);
    },
    close: async () => {},
  };
  await closeBrowser(ID);
  await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
});
const click = () => runBrowser({ action: 'click', selector: '#copy' }, { convId: ID });

describe('a real tap that misses its element', () => {
  it('an element that was still moving: waits until it holds still, then taps where it is', async () => {
    page.looks = [box({ t: 600, y: 620 }), box({ t: 420, y: 440 }), box({ t: 300, y: 320 }), box({ t: 300, y: 320 })];
    const r = await click();
    expect(taps).toHaveLength(1);
    expect(taps[0]).toMatchObject({ x: 100, y: 320 });
    expect(r.result).toMatch(/Tapped with a real touch after waiting for it to stop moving \(activation:true/);
    expect(scripted).toBe(0);
  });
  it('a first tap that misses because the layout shifted: tapped again, and the copy button gets its real tap', async () => {
    // held still before the tap, then a banner above it pushed it down as it was tapped
    page.looks = [box(), box(), box({ t: 380, y: 400 }), box({ t: 380, y: 400 })];
    page.hits = [{ hit: false }, { hit: true, trusted: true, active: true, copied: 'npm i chronicle' }];
    const r = await click();
    expect(taps).toHaveLength(2);
    expect(taps[1]).toMatchObject({ y: 400 });
    expect(scripted).toBe(0);
    expect(r.result).toMatch(/Tapped with a real touch after waiting for it to stop moving \(the first tap missed: it was still moving \(animating, or the layout shifted\) when it was tapped\)/);
    expect(r.result).toMatch(/The page copied "npm i chronicle"/);
  });
  it('covered by another element: names it, does not tap it, clicks from script and says a copy button may not work that way', async () => {
    page.looks = [box({ covered: 'div.cookie-banner "We use cookies OK"' })];
    const r = await click();
    expect(taps).toHaveLength(0); // a tap would have hit the banner
    expect(scripted).toBe(1);
    expect(r.result).toMatch(/The real tap did not reach this element: div\.cookie-banner "We use cookies OK" is on top of it/);
    expect(r.result).toMatch(/clicked from script instead \(activation:false – a copy-to-clipboard button may not work that way/);
  });
  it('a cover that goes away (a toast fading out): the second look finds it free and taps it for real', async () => {
    page.looks = [box({ covered: 'div.toast "Saved"' }), box({ covered: 'div.toast "Saved"' }), box(), box()];
    const r = await click();
    expect(taps).toHaveLength(1);
    expect(scripted).toBe(0);
    expect(r.result).toMatch(/Tapped with a real touch after trying again \(at first it could not be tapped: covered by div\.toast "Saved"\)/);
  });
  it('off screen even after scrolling, no size, hidden: each is said, and none is tapped', async () => {
    for (const [o, re] of [
      [{ off: true, y: 1900, x: 100 }, /it is off screen \(its middle is at 100,1900 in a 390×844 view, even after scrolling\)/],
      [{ zero: true, w: 0, h: 0 }, /it has no size \(0×0 px/],
      [{ hidden: 'visibility:hidden' }, /it is hidden \(visibility:hidden\)/],
    ]) {
      taps.length = 0;
      page.looks = [box(o)];
      const r = await click();
      expect(taps).toHaveLength(0);
      expect(r.result).toMatch(re);
      expect(r.result).toMatch(/It was not tapped .*so it was clicked from script instead/);
    }
  });
  it('two taps that both miss for no visible reason: says so, then the script click', async () => {
    page.hits = [{ hit: false }, { hit: false }];
    const r = await click();
    expect(taps).toHaveLength(2);
    expect(scripted).toBe(1);
    expect(r.result).toMatch(/the touch landed on its middle but the element did not get the click.*It was tapped twice/);
  });
});
