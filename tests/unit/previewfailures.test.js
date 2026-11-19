import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeBrowser, explainFailure } from '../../src/browsercontrol.js';
import { runTool } from '../../src/tools.js';

// Every preview_page / browser failure says WHAT broke and on WHICH SIDE (bad input, the network or site, the page's
// own JavaScript, a timeout, the phone's WebView), and what got through before it – never a bare "failed", an empty
// message or a raw exception. The first line is what the tool card shows (display.error, else the result's first line).
const enc = (s) => new TextEncoder().encode(s);
const ws = () => ({ files: { 'site/login.html': { data: enc('<html><head></head><body>hi</body></html>') } } });
const card = (r) => String(r.display?.error || r.result).replace(/^Error:\s*/, '').split('\n')[0];
let status, hooks;
beforeEach(async () => {
  status = { url: '', title: '', error: null, httpStatus: 200 };
  hooks = {};
  globalThis.__ocmServe = async (w, convId) => '/data/shell/work/' + convId;
  globalThis.__ocmTiles = async () => ['data:image/jpeg;base64,AA=='];
  globalThis.__ocmSoFarMs = 300;
  globalThis.__ocmBrowser = {
    open: async (a) => {
      status.url = a.url;
      status.title = 'Sign in';
      if (hooks.open) await hooks.open(a);
    },
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js === 'window.__ocmPaint||0') return { value: '1' };
      if (js.startsWith('JSON.stringify(window.__ocmErr')) return { value: JSON.stringify(JSON.stringify(['TypeError: app.init is not a function (app.js:3)'])) };
      if (js.includes('JSON.stringify({u:location.href')) return { value: JSON.stringify(JSON.stringify({ u: status.url, t: status.title, e: ['TypeError: app.init is not a function (app.js:3)'], l: ['console.error: boot failed'] })) };
      if (hooks.eval) {
        const v = hooks.eval(js);
        if (v !== undefined) return v;
      }
      return { value: JSON.stringify({ url: status.url, title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) };
    },
    status: async () => ({ ...status }),
    screenshot: async () => (hooks.screenshot ? hooks.screenshot() : { base64: btoa('jpg'), width: 390, height: 844 }),
    close: async () => {},
  };
  await closeBrowser('f1');
  await closeBrowser('preview-f1');
});
afterEach(() => {
  delete globalThis.__ocmServe;
  delete globalThis.__ocmTiles;
  delete globalThis.__ocmSoFarMs;
});
const preview = (args) => runTool({ name: 'preview_page', arguments: JSON.stringify(args) }, { convId: 'f1', workspace: ws(), vision: true });
const browser = (args) => runTool({ name: 'browser', arguments: JSON.stringify(args) }, { convId: 'f1', workspace: ws(), settings: {}, vision: true });

describe('preview_page says what failed and on whose side', () => {
  it("a load the WebView reports as net::ERR_FAILED is explained, not just 'failed'", async () => {
    hooks.open = async () => {
      throw new Error('Could not open the page: net::ERR_FAILED');
    };
    const r = await preview({ path: 'site/login.html', view: 'mobile', steps: [{ action: 'click', selector: '#go' }] });
    expect(r.ok).toBe(false);
    expect(card(r)).toMatch(/could not be opened as a served site/);
    expect(card(r)).toMatch(/open failed \(the phone's WebView\): loading this workspace page failed without a specific reason/);
    expect(r.result).toContain('net::ERR_FAILED');
  });
  it('a failed step names the step and its cause on the first line, and the card shows it', async () => {
    hooks.eval = (js) => (js.includes('window.__ocmB.aim(') || js.includes('window.__ocmB.click(') ? { value: JSON.stringify({ __error: 'No element matches "text=Sign in"' }) } : undefined);
    const r = await preview({ path: 'site/login.html', view: 'mobile', steps: [{ action: 'click', selector: 'text=Sign in' }] });
    expect(r.ok).toBe(false);
    expect(r.result.split('\n')[0]).toMatch(/PREVIEW FAILED for 1 view – mobile: step #1 click text=Sign in failed – click failed \(bad input\): No element matches "text=Sign in"/);
    expect(card(r)).toMatch(/step #1 click text=Sign in failed.*bad input.*No element matches/);
  });
  it('a screenshot the native side refuses is a failure of that stage, with what got through – not a raw exception', async () => {
    hooks.screenshot = async () => {
      throw new Error('Screenshot failed: null');
    };
    const r = await preview({ path: 'site/login.html', view: 'mobile' });
    expect(r.ok).toBe(false);
    expect(r.result).not.toMatch(/renderHtml is not a function|could not be served/);
    expect(card(r)).toMatch(/mobile: taking the mobile screenshot failed \(the phone's WebView\): Screenshot failed/);
    expect(r.result).toMatch(/What got through: the page reached https:\/\/[^ ]+\/site\/login\.html \(title "Sign in"\)/);
    expect(r.result).toContain('app.init is not a function'); // the page's own errors, collected before the failure
  });
  it('bad input is said as bad input: a path outside /workspace, a bad view', async () => {
    const out = await preview({ path: '/sdcard/Download/page.html' });
    expect(card(out)).toMatch(/^Bad input: \/sdcard\/Download\/page\.html is not in this chat's \/workspace/);
    const v = await preview({ path: 'site/login.html', view: 'tablet' });
    expect(card(v)).toMatch(/^Bad input: view must be "mobile", "desktop" or "both"/);
    const nf = await preview({ path: 'site/nope.html' });
    expect(card(nf)).toMatch(/^File not found \(bad input\)/);
  });
});

describe('browser failures say what and which side, and what got through', () => {
  it('a native reject without a message is not an empty "Error:"', async () => {
    hooks.open = async () => {
      throw new Error('');
    };
    const r = await browser({ action: 'open', url: 'https://example.com/' });
    expect(r.ok).toBe(false);
    expect(card(r)).toMatch(/^open failed \(the phone's WebView\): the native browser failed without giving a reason/);
  });
  it('a page that does not answer the page script is said so, not "Cannot read properties of null"', async () => {
    await browser({ action: 'open', url: 'https://example.com/' });
    hooks.eval = (js) => (js.includes('window.__ocmB.snapshot(') ? { value: 'null' } : undefined);
    const r = await browser({ action: 'read' });
    expect(r.ok).toBe(false);
    expect(r.result).not.toMatch(/Cannot read propert/);
    expect(card(r)).toMatch(/^read failed \(no answer from the page\): the page did not answer Chronicle's page script/);
    expect(r.result).toMatch(/What got through before it failed: the page was at https:\/\/example\.com\/ \(title "Sign in"\)/);
    expect(r.result).toMatch(/app\.init is not a function[\s\S]*console\.error: boot failed/);
  });
  it('a network error says it is the network, with what the code means', async () => {
    hooks.open = async () => {
      throw new Error('Could not open the page: net::ERR_NAME_NOT_RESOLVED');
    };
    const r = await browser({ action: 'open', url: 'https://no-such-host.example/' });
    expect(card(r)).toMatch(/^open failed \(network\): the host name in the address could not be found/);
    expect(r.result).toContain('net::ERR_NAME_NOT_RESOLVED');
  });
  it('explainFailure: every kind of message gets a side', () => {
    expect(explainFailure('failed').side).toBe("the phone's WebView");
    expect(explainFailure('net::ERR_CONNECTION_REFUSED', { loopback: true })).toMatchObject({ side: 'your server' });
    expect(explainFailure('Drawing the page did not respond within 30 s').side).toBe('timeout');
    expect(explainFailure('No element matches "#x"').side).toBe('bad input');
    expect(explainFailure("Cannot read properties of null (reading 'covered')").side).toBe('no answer from the page');
  });
});
