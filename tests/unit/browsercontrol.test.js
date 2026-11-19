import { describe, it, expect, beforeEach } from 'vitest';
import { runBrowser, closeBrowser } from '../../src/browsercontrol.js';
import { runTool } from '../../src/tools.js';

const snapJson = (o = {}) => ({ url: 'https://example.com/', title: 'Ex', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800, ...o });
let opened, evals, cur;
beforeEach(async () => {
  opened = []; evals = [];
  globalThis.__ocmBrowser = {
    open: async (a) => { opened.push(a.url); cur = a.url; },
    eval: async ({ js }) => { evals.push(js); return { value: js === 'document.readyState' ? '"complete"' : JSON.stringify(snapJson({ url: cur || 'https://example.com/' })) }; },
    screenshot: async () => ({ base64: '' }),
    close: async () => {},
  };
  await closeBrowser();
});

describe('browser tool robustness', () => {
  it('a tool error comes back as a result instead of stopping the reply', async () => {
    const r = await runTool({ function: { name: 'browser', arguments: '{"action":"read"}' }, name: 'browser', arguments: '{"action":"read"}' }, {});
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/No page is open/);
  });
  it('reopens the last page after the browser was closed, and says so', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, {});
    await closeBrowser();
    const r = await runBrowser({ action: 'read' }, {});
    expect(opened).toEqual(['https://example.com/', 'https://example.com/']);
    expect(r.result).toMatch(/opened again/);
  });
  it('does not blindly click on a reopened page', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, {});
    await closeBrowser();
    const r = await runBrowser({ action: 'click', id: 3 }, {});
    expect(r.result).toMatch(/was not done/);
    expect(evals.some((j) => j.includes('window.__ocmB.click('))).toBe(false);
  });
  it('read passes offset and max_chars; key is sent to the page', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, {});
    await runBrowser({ action: 'read', offset: 4000, max_chars: 9000 }, {});
    expect(evals.at(-1)).toContain('snapshot(4000,9000)');
    await runBrowser({ action: 'key', key: 'PageDown' }, {});
    expect(evals.some((j) => j.includes('.key("PageDown")'))).toBe(true);
  });
  it('steps run several actions in one call and stop at the first failure', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, {});
    const r = await runBrowser({ action: 'read', steps: [{ action: 'scroll', y: 500 }, { action: 'read', max_chars: 50 }, { action: 'close' }] }, {});
    expect(r.ok).toBe(true);
    expect(r.result).toMatch(/#1 scroll/);
    expect(r.result).toMatch(/#3 close: Browser closed/);
    const bad = await runBrowser({ steps: [{ action: 'drag', selector: 'x' }, { action: 'read' }] }, {});
    expect(bad.ok).toBe(false);
    expect(bad.result).not.toMatch(/#2/);
  });
  it('type into an editable block is refused unless forced (checked in the page script)', async () => {
    const { PAGE_SCRIPT } = await import('../../src/browsercontrol.js');
    expect(PAGE_SCRIPT).toMatch(/isContentEditable&&!force/);
  });
  it('eval wraps an expression, waits for the async result and returns it', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, {});
    const base = globalThis.__ocmBrowser.eval;
    let sent = '';
    globalThis.__ocmBrowser.eval = async (a) => {
      if (a.js.includes('__ocmE={done:false}')) { sent = a.js; return { value: '"started"' }; }
      if (a.js.includes('window.__ocmE||')) return { value: JSON.stringify({ done: true, v: '["Ada","Bob"]' }) };
      return base(a);
    };
    const r = await runBrowser({ action: 'eval', script: 'document.title' }, {});
    expect(sent).toContain('return (document.title)');
    expect(r.ok).toBe(true);
    expect(r.result).toContain('["Ada","Bob"]');
    await runBrowser({ action: 'eval', script: 'const a=1;\nreturn a' }, {});
    expect(sent).toContain('const a=1;\nreturn a');
  });
  it('a script error comes back as a failed result', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, {});
    const base = globalThis.__ocmBrowser.eval;
    globalThis.__ocmBrowser.eval = async (a) => (a.js.includes('window.__ocmE||') ? { value: JSON.stringify({ done: true, err: 'x is not defined' }) } : a.js.includes('__ocmE={done:false}') ? { value: '"s"' } : base(a));
    const r = await runBrowser({ action: 'eval', script: 'x' }, {});
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/x is not defined/);
  });
  it('each chat gets its own browser; closing one leaves the other', async () => {
    const seen = [];
    const raw = globalThis.__ocmBrowser;
    for (const m of ['open', 'close']) {
      const f = raw[m];
      raw[m] = async (a) => (seen.push(`${m}:${a.id}`), f(a));
    }
    const { browserOpen } = await import('../../src/browsercontrol.js');
    await runBrowser({ action: 'open', url: 'https://a.example/' }, { convId: 'A' });
    await runBrowser({ action: 'open', url: 'https://b.example/' }, { convId: 'B' });
    expect(seen).toEqual(['open:A', 'open:B']);
    expect(browserOpen('A') && browserOpen('B')).toBe(true);
    await closeBrowser('A');
    expect(browserOpen('A')).toBe(false);
    expect(browserOpen('B')).toBe(true);
    expect(seen.at(-1)).toBe('close:A');
    // chat A's next action reopens ITS page, not B's
    await runBrowser({ action: 'read' }, { convId: 'A' });
    expect(opened.at(-1)).toBe('https://a.example/');
    await closeBrowser('A');
    await closeBrowser('B');
  });
});

describe('download with the browser session', () => {
  const b64 = (s) => btoa(s);
  it('saves the file, returns the start of a text file, and works without an open page', async () => {
    const asked = [];
    globalThis.__ocmBrowser.fetchFile = async (a) => { asked.push(a); return { status: 200, url: 'https://raw.example.com/x/CHANGELOG.md?token=1', mime: 'text/plain; charset=utf-8', name: 'CHANGELOG.md', base64: b64('# Changes\n- one') }; };
    const saved = [];
    const r = await runBrowser({ action: 'download', url: 'https://example.com/o/r/raw/main/CHANGELOG.md' }, { saveDownload: (n, bytes) => { saved.push([n, bytes.length]); return '/workspace/downloads/' + n; } });
    expect(r.ok).toBe(true);
    expect(saved).toEqual([['CHANGELOG.md', 15]]);
    expect(r.result).toMatch(/saved as \/workspace\/downloads\/CHANGELOG\.md/);
    expect(r.result).toMatch(/# Changes\n- one/);
    expect(r.result).not.toMatch(/token=1/);
    expect(asked[0].url).toBe('https://example.com/o/r/raw/main/CHANGELOG.md');
  });
  it('a relative url is resolved against the open page; an error status explains itself; private addresses are refused', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/o/r' }, {});
    let got;
    globalThis.__ocmBrowser.fetchFile = async (a) => { got = a; return { status: 404, url: a.url, mime: 'text/plain', base64: b64('Not Found') }; };
    const r = await runBrowser({ action: 'download', url: '/o/r/archive/refs/heads/main.zip' }, {});
    expect(got.url).toBe('https://example.com/o/r/archive/refs/heads/main.zip');
    expect(got.referer).toBe('https://example.com/o/r');
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/HTTP 404/);
    expect(r.result).toMatch(/handoff/);
    const p = await runTool({ function: { name: 'browser', arguments: '{"action":"download","url":"http://192.168.1.1/x"}' }, name: 'browser', arguments: '{"action":"download","url":"http://192.168.1.1/x"}' }, {});
    expect(p.ok).toBe(false);
  });
  it('a zip gets an unpack hint and a sign-in page is called out', async () => {
    globalThis.__ocmBrowser.fetchFile = async () => ({ status: 200, url: 'https://codeload.example.com/r.zip', mime: 'application/zip', name: 'r-main.zip', base64: b64('PK\u0003\u0004') });
    const z = await runBrowser({ action: 'download', url: 'https://example.com/r.zip' }, { saveDownload: (n) => '/workspace/downloads/' + n });
    expect(z.result).toMatch(/unzip -q "r-main\.zip"/);
    globalThis.__ocmBrowser.fetchFile = async () => ({ status: 200, url: 'https://example.com/login', mime: 'text/html', name: 'notes.txt', base64: b64('<form action="/session"><input type="password"></form>') });
    const h = await runBrowser({ action: 'download', url: 'https://example.com/notes.txt' }, { saveDownload: (n) => '/workspace/downloads/' + n });
    expect(h.result).toMatch(/sign-in page, not the file/);
  });
});

describe('where a page ends', () => {
  // runs the real page script against a tiny fake page: a 390×844 screen, a heading ending at 60px
  const measure = async (fixedBox) => {
    const { contentBottom } = await import('../../src/browsercontrol.js');
    const els = [
      { r: { left: 0, top: 0, right: 390, bottom: 60, width: 390, height: 60 }, pos: 'static' },
      { r: { left: 0, top: fixedBox[0], right: 390, bottom: fixedBox[1], width: 390, height: fixedBox[1] - fixedBox[0] }, pos: 'fixed' },
    ];
    const document = { documentElement: { scrollHeight: 844 }, body: { firstElementChild: {}, scrollHeight: 844, getBoundingClientRect: () => els[0].r, pos: 'static', querySelectorAll: () => els.map((e) => ({ getBoundingClientRect: () => e.r, pos: e.pos })) } };
    const getComputedStyle = (e) => ({ position: e.pos, visibility: 'visible' });
    const api = { eval: async ({ js }) => ({ value: JSON.stringify(new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', 'scrollY', 'return ' + js)(document, getComputedStyle, 390, 844, 0)) }) };
    return (await contentBottom(api)).b;
  };
  it('a fixed stage that fills the screen is the content: the whole screen is kept', async () => {
    expect(await measure([0, 844])).toBe(844);
  });
  it('a fixed cookie bar does not count: a short page is still cut where its content ends', async () => {
    expect(await measure([784, 844])).toBe(60);
  });
});
