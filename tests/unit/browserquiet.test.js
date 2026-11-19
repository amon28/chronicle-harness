import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeBrowser, runBrowser } from '../../src/browsercontrol.js';

// After an action the browser waits until the page is done – loaded, no request in flight, no change for 0.3 s –
// instead of a fixed 0.9 s; a page that never holds still or a request that never ends still lets it go on.
const ID = 'quiet1';
let quiet, t0;
const snap = { url: 'https://example.com/', title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 };
beforeEach(async () => {
  quiet = () => ({ rs: 'complete', inflight: 0, sinceMut: 5000, nav: false, anim: 0 });
  globalThis.__ocmBrowser = {
    open: async () => {},
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js.includes('__ocmB.quiet()')) {
        const q = quiet(Date.now() - t0);
        if (q === 'hang') return new Promise(() => {});
        return { value: JSON.stringify(JSON.stringify(q)) };
      }
      if (js.includes('try{window.__ocmB.navState()')) return { value: JSON.stringify(JSON.stringify({ pending: null, ms: 0, rs: 'complete', url: snap.url })) };
      if (js.includes('try{window.__ocmB.click(')) return { value: '"clicked"' };
      return { value: JSON.stringify(snap) };
    },
    close: async () => {},
  };
  await closeBrowser(ID);
  await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
});
afterEach(() => {
  delete globalThis.__ocmSettleExtraMs;
});
const click = async () => {
  t0 = Date.now();
  const r = await runBrowser({ action: 'click', selector: '#b' }, { convId: ID });
  return { r, ms: Date.now() - t0 };
};

describe('the wait after an action', () => {
  it('a quiet page: goes on after about 0.3 s, not 0.9 s', async () => {
    const { r, ms } = await click();
    expect(r.ok).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(280);
    expect(ms).toBeLessThan(700);
  });
  it('a request in flight is waited for, then 0.3 s of quiet', async () => {
    quiet = (t) => (t < 1200 ? { rs: 'complete', inflight: 1, sinceMut: 5000, nav: false } : { rs: 'complete', inflight: 0, sinceMut: t - 1200, nav: false });
    const { ms } = await click();
    expect(ms).toBeGreaterThanOrEqual(1400);
    expect(ms).toBeLessThan(2200);
  });
  it('a transition about to end is waited for', async () => {
    quiet = (t) => ({ rs: 'complete', inflight: 0, sinceMut: 5000, nav: false, anim: t < 700 ? 1 : 0 });
    const { ms } = await click();
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(ms).toBeLessThan(1300);
  });
  it('a page that never stops changing (a clock, a ticker): taken as it is after 0.9 s', async () => {
    quiet = () => ({ rs: 'complete', inflight: 0, sinceMut: 10, nav: false });
    const { ms } = await click();
    expect(ms).toBeGreaterThanOrEqual(880);
    expect(ms).toBeLessThan(1500);
  });
  it('a request that never ends: given up on after the extra time', async () => {
    globalThis.__ocmSettleExtraMs = 600;
    quiet = () => ({ rs: 'complete', inflight: 1, sinceMut: 5000, nav: false });
    const { r, ms } = await click();
    expect(r.ok).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(1450);
    expect(ms).toBeLessThan(2300);
  });
  it('a page that does not answer (changing document, the reply dropped): the wait still ends', async () => {
    globalThis.__ocmSettleExtraMs = 0;
    quiet = () => 'hang';
    const { r, ms } = await click();
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(4000);
  }, 8000);
});
