import { describe, it, expect, beforeEach } from 'vitest';
import { closeBrowser, runBrowser } from '../../src/browsercontrol.js';

// A click on a link to a slow server: like a WebView, the old document stays there, scriptable and "complete", until
// the new one commits. The page script marks a navigation it saw start (window.__ocmNav); the stand-in plays that
// part. The browser tool used to settle on the old document – the click, wait_for load and the next step all read
// the page from before. check_ and navState are answered as the page script the tool injected would answer them.
const ID = 'nav1';
const PAGES = { 'https://example.com/': 'Example Domain', 'https://www.iana.org/help/example-domains': 'Example Domains' };
let doc, nav;
const tick = () => {
  if (nav && Date.now() >= nav.at) (doc = { url: nav.url, title: PAGES[nav.url] }), (nav = null);
};
const go = (url, ms = 2500) => {
  nav = { url, at: Date.now() + ms };
};
beforeEach(async () => {
  await closeBrowser(ID);
  nav = null;
  globalThis.__ocmBrowser = {
    open: async ({ url }) => {
      doc = { url, title: PAGES[url] };
      nav = null;
    },
    eval: async ({ js }) => {
      tick();
      const v = (x) => ({ value: JSON.stringify(x) });
      if (js === 'document.readyState') return v('complete');
      const marks = js.includes('navigation.addEventListener(\'navigate\''); // the script sees navigations start
      if (js.includes('try{window.__ocmB.navState()}')) return v(js.includes('navState:function') ? JSON.stringify({ pending: marks && nav ? nav.url : null, ms: 0, rs: 'complete', url: doc.url }) : JSON.stringify({ __error: 'window.__ocmB.navState is not a function' }));
      if (js.includes('try{window.__ocmB.check_("load"')) return v(js.includes("readyState==='complete'&&!window.__ocmNav") ? !(marks && nav) : true);
      if (js.includes('try{window.__ocmB.click(')) return go('https://www.iana.org/help/example-domains'), v('clicked');
      if (js.includes('window.__ocmE={done:false}')) {
        if (js.includes('location.href = ')) go('https://www.iana.org/help/example-domains');
        return v('started');
      }
      if (js.includes('try{JSON.stringify(window.__ocmE||{})}')) return v(JSON.stringify({ done: true, v: '1' }));
      if (js.includes('try{window.__ocmB.get("text"')) return v(JSON.stringify(doc.title));
      if (js.includes('window.__ocmB.snapshot(')) return v(JSON.stringify({ url: doc.url, title: doc.title, text: doc.title, textFrom: 0, textLen: doc.title.length, elements: ['[1] link "Learn more"'], scrollY: 0, pageHeight: 800, viewHeight: 800 }));
      return v('ok');
    },
    close: async () => {},
  };
});

describe('an action that loads another page', () => {
  it('a click reports the page it led to, and the next step runs there', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    const r = await runBrowser({ steps: [{ action: 'click', selector: 'text="Learn more"' }, { action: 'wait_for', load: true }, { action: 'get', selector: 'h1' }] }, { convId: ID });
    expect(r.ok).toBe(true);
    const parts = r.result.split(/\n\n(?=#\d+ )/);
    expect(parts[0]).toMatch(/^#1 click text="Learn more": [\s\S]*URL: https:\/\/www\.iana\.org\/help\/example-domains/);
    expect(parts[2]).toMatch(/^#3 get h1: [\s\S]*"Example Domains"/);
  }, 20000);
  it('wait_for load waits for a navigation on its way', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
    // eval does not wait for what its script starts: the old document is still there, and "complete"
    await runBrowser({ action: 'eval', script: 'location.href = "https://www.iana.org/help/example-domains"; return 1' }, { convId: ID });
    const w = await runBrowser({ action: 'wait_for', load: true }, { convId: ID });
    expect(w.ok).toBe(true);
    expect(w.result).toMatch(/URL: https:\/\/www\.iana\.org\/help\/example-domains/);
  }, 20000);
  it('a navigation that does not arrive in time is said, not passed off as the new page', async () => {
    globalThis.__ocmNavWaitMs = 1000;
    try {
      await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
      const r = await runBrowser({ action: 'click', selector: 'text="Learn more"' }, { convId: ID });
      expect(r.result).toMatch(/A navigation to https:\/\/www\.iana\.org\/help\/example-domains started but the new page had not arrived/);
      nav.at = Date.now() + 60000;
      const w = await runBrowser({ action: 'wait_for', load: true, timeout_ms: 600 }, { convId: ID });
      expect(w.ok).toBe(false);
      expect(w.result).toMatch(/navigation to https:\/\/www\.iana\.org\/help\/example-domains started but the new page has not arrived/);
    } finally {
      delete globalThis.__ocmNavWaitMs;
    }
  }, 20000);
});
