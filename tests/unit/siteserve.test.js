import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { workspaceTarget, isLoopbackUrl, isSiteUrl, siteOrigin, SITE_PROBE } from '../../src/siteserve.js';
import { runBrowser, closeBrowser, pageProblem, captureFrame } from '../../src/browsercontrol.js';
import { runTool } from '../../src/tools.js';

const enc = (s) => new TextEncoder().encode(s);

describe('workspace pages as a real origin', () => {
  it('maps every way of naming a workspace page to https://workspace.localhost/', () => {
    expect(workspaceTarget('/workspace/site/login.html')).toEqual({ path: 'site/login.html', suffix: '', url: 'https://workspace.localhost/site/login.html' });
    expect(workspaceTarget('site/dashboard.html#demo')).toMatchObject({ path: 'site/dashboard.html', suffix: '#demo', url: 'https://workspace.localhost/site/dashboard.html#demo' });
    expect(workspaceTarget('file:///workspace/login.html?x=1').url).toBe('https://workspace.localhost/login.html?x=1');
    expect(workspaceTarget('https://workspace.localhost/site/').url).toBe('https://workspace.localhost/site/');
    expect(workspaceTarget('/workspace/my site/a b.html').url).toBe('https://workspace.localhost/my%20site/a%20b.html');
    expect(workspaceTarget('/workspace/../etc/passwd').path).not.toContain('..');
    expect(workspaceTarget('https://example.com/a.html')).toBeNull();
    expect(workspaceTarget('/etc/hosts')).toBeNull();
    expect(isSiteUrl('https://workspace.localhost/x')).toBe(true);
  });
  it('gives every chat its own origin, so storage never crosses chats', () => {
    expect(siteOrigin('c1')).toMatch(/^https:\/\/c[0-9a-z]+\.workspace\.localhost$/);
    expect(siteOrigin('c1')).toBe(siteOrigin('c1'));
    expect(siteOrigin('c1')).not.toBe(siteOrigin('c2'));
    expect(siteOrigin('a chat/with odd:chars')).toMatch(/^https:\/\/c[0-9a-z]+\.workspace\.localhost$/);
    expect(workspaceTarget('/workspace/a.html', 'c1').url).toBe(siteOrigin('c1') + '/a.html');
    // an address of this (or any) chat's origin is still a workspace page
    expect(workspaceTarget(siteOrigin('c1') + '/site/x.html?q=1', 'c1')).toMatchObject({ path: 'site/x.html', suffix: '?q=1' });
    expect(isSiteUrl(siteOrigin('c2') + '/x')).toBe(true);
    expect(isSiteUrl('https://evil.com/workspace.localhost/')).toBe(false);
  });
  it('knows a server on this phone from one on the LAN', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8099/')).toBe(true);
    expect(isLoopbackUrl('http://localhost:3000/a')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.1/')).toBe(false);
    expect(isLoopbackUrl('file:///x')).toBe(false);
  });
  it('the probe catches errors and failed loads from the first line', () => {
    expect(SITE_PROBE).toContain('__ocmErr');
    expect(SITE_PROBE).toContain('could not load');
  });
});

let opened, status, shots, served;
beforeEach(async () => {
  opened = [];
  status = { url: '', title: '', error: null, httpStatus: 200 };
  shots = [];
  served = [];
  globalThis.__ocmServe = async (w, convId) => (served.push(convId), '/data/shell/work/' + convId);
  globalThis.__ocmTiles = async () => ['data:image/jpeg;base64,AA=='];
  globalThis.__ocmBrowser = {
    open: async (a) => {
      opened.push(a);
      status.url = a.url;
    },
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js.startsWith('JSON.stringify(window.__ocmErr')) return { value: '"[\\"could not load /app.css\\"]"' };
      if (js === 'window.__ocmPaint||0') return { value: '1' };
      return { value: JSON.stringify({ url: status.url, title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) };
    },
    status: async () => ({ ...status }),
    screenshot: async () => shots.shift() || { base64: btoa('jpg'), width: 390, height: 844 },
    close: async () => {},
  };
  await closeBrowser('c1');
  await closeBrowser('preview-c1');
});
afterEach(() => {
  delete globalThis.__ocmServe;
  delete globalThis.__ocmTiles;
});

describe('browser on workspace pages', () => {
  it('opens a /workspace path on the served origin with the folder and the probe', async () => {
    const r = await runBrowser({ action: 'open', url: '/workspace/site/login.html' }, { convId: 'c1', workspace: { files: {} } });
    expect(r.ok).toBe(true);
    expect(opened[0]).toMatchObject({ url: siteOrigin('c1') + '/site/login.html', root: '/data/shell/work/c1' });
    expect(opened[0].inject).toContain('__ocmErr');
    expect(served).toEqual(['c1']);
  });
  it('allows a server the assistant started on this phone, still refuses the LAN', async () => {
    const r = await runBrowser({ action: 'open', url: 'http://127.0.0.1:8099/' }, { convId: 'c1' });
    expect(r.ok).toBe(true);
    expect(opened[0]).toMatchObject({ url: 'http://127.0.0.1:8099/', loopback: true });
    await expect(runBrowser({ action: 'open', url: 'http://192.168.1.1/' }, { convId: 'c1' })).rejects.toThrow(/local address/);
    await expect(runBrowser({ action: 'open', url: 'file:///sdcard/x.html' }, { convId: 'c1' })).rejects.toThrow(/workspace\.localhost/);
  });
  it('a page that answered 404 or a Chromium error page is ok=0, not ok=1', async () => {
    status.httpStatus = 404;
    const r = await runBrowser({ action: 'open', url: '/workspace/nope.html' }, { convId: 'c1', workspace: { files: {} } });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/HTTP 404.*not in \/workspace/);
    expect(await pageProblem({ status: async () => ({ url: 'chrome-error://chromewebdata/', title: '' }) })).toMatch(/error page/);
    expect(await pageProblem({ status: async () => ({ url: 'https://x.com/', title: 'Webpage not available' }) })).toMatch(/error page/);
    expect(await pageProblem({ status: async () => ({ url: 'https://x.com/', title: 'x', error: 'net::ERR_NAME_NOT_RESOLVED' }) })).toMatch(/ERR_NAME/);
    expect(await pageProblem({ status: async () => ({ url: 'https://x.com/', title: 'Fine', httpStatus: 200 }) })).toBeNull();
  });
  it('a click that navigates to a missing page fails honestly', async () => {
    await runBrowser({ action: 'open', url: '/workspace/login.html' }, { convId: 'c1', workspace: { files: {} } });
    status.httpStatus = 404;
    const r = await runBrowser({ action: 'click', selector: 'text=Sign in' }, { convId: 'c1', workspace: { files: {} } });
    expect(r.ok).toBe(false);
    expect(served.length).toBe(2); // the files were served again before the click
  });
  it('a flat frame is taken again before it is believed', async () => {
    shots = [{ base64: '', blank: true, color: '#000000' }, { base64: btoa('ok'), blank: false, width: 1, height: 1 }];
    const api = globalThis.__ocmBrowser;
    const r = await captureFrame(api);
    expect(r.blank).toBe(false);
    shots = [{ blank: true }, { blank: true }, { blank: true, color: '#000000' }];
    expect((await captureFrame(api)).blank).toBe(true);
  });
  it('tells "only the background came through" from "never painted" from "nothing to draw"', async () => {
    const api = (facts) => ({ ...globalThis.__ocmBrowser, eval: async ({ js }) => (js.includes('innerText||') ? { value: JSON.stringify(JSON.stringify(facts)) } : globalThis.__ocmBrowser.eval({ js })) });
    const flat = (c) => [0, 1, 2].map(() => ({ base64: btoa('x'), blank: true, color: c }));
    const kicks = [];
    const spy = (a) => ({ ...a, screenshot: async (o) => (kicks.push(!!o.kick), shots.shift()) });
    shots = flat('#101418');
    const bg = await captureFrame(spy(api({ text: 15, boxes: 3, bg: 'rgb(16, 20, 24)' })));
    expect(bg).toMatchObject({ blank: false, verdict: 'background' }); // the screenshot is kept, with a warning
    expect(bg.message).toMatch(/background colour \(#101418\).*15 characters/);
    expect(kicks).toEqual([false, true, true]); // the 2nd and 3rd tries make the WebView redraw
    shots = flat('#000000');
    const never = await captureFrame(api({ text: 15, boxes: 3, bg: 'rgb(16, 20, 24)' }));
    expect(never).toMatchObject({ blank: true, verdict: 'unpainted' });
    expect(never.message).toMatch(/never painted.*#000000/);
    shots = flat('#ffffff');
    expect(await captureFrame(api({ text: 0, boxes: 0, bg: 'rgb(255, 255, 255)' }))).toMatchObject({ blank: true, verdict: 'empty' });
  });
  it('clicks with a real tap and reports activation; falls back to a script click when the tap misses', async () => {
    const base = globalThis.__ocmBrowser;
    const taps = [];
    let hit = true;
    const scripted = [];
    globalThis.__ocmBrowser = {
      ...base,
      tap: async (a) => taps.push(a),
      eval: async ({ js }) => {
        if (js.includes('__ocmB.aim(') || js.includes('__ocmB.where(')) return { value: JSON.stringify(JSON.stringify({ x: 100, y: 200, vw: 390, covered: '' })) };
        if (js.includes('__ocmB.aimed()')) return { value: JSON.stringify(JSON.stringify({ hit, trusted: hit, active: hit })) };
        if (js.includes('__ocmB.click(')) scripted.push(js);
        return base.eval({ js });
      },
    };
    const ctx = { convId: 'c1', workspace: { files: {} } };
    await runBrowser({ action: 'open', url: '/workspace/a.html' }, ctx);
    const r = await runBrowser({ action: 'click', selector: '#copy' }, ctx);
    expect(taps[0]).toMatchObject({ x: 100, y: 200, vw: 390, count: 1 });
    expect(r.result).toMatch(/real touch \(activation:true at the moment of the click, the click event was trusted\)/);
    expect(scripted).toHaveLength(0);
    hit = false;
    const r2 = await runBrowser({ action: 'click', selector: '#copy' }, ctx);
    expect(r2.result).toMatch(/did not reach this element.*activation:false/);
    expect(scripted).toHaveLength(1);
    globalThis.__ocmBrowser = base;
  });
  it('without real input a click says activation:false', async () => {
    const ctx = { convId: 'c1', workspace: { files: {} } };
    await runBrowser({ action: 'open', url: '/workspace/a.html' }, ctx);
    const r = await runBrowser({ action: 'click', selector: '#copy' }, ctx);
    expect(r.result).toMatch(/Clicked by script \(activation:false/);
  });
  it('a browser screenshot is saved in output/screenshots and the path is returned', async () => {
    const files = {};
    const ctx = { convId: 'c1', workspace: { id: 'c1', files }, settings: {}, vision: true };
    await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'open', url: '/workspace/a.html' }) }, ctx);
    const r = await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'screenshot' }) }, ctx);
    expect(r.result).toMatch(/Saved as \/workspace\/output\/screenshots\/browser-c1-1\.jpg/);
    expect(files['output/screenshots/browser-c1-1.jpg']).toBeTruthy();
    await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'screenshot' }) }, ctx);
    expect(files['output/screenshots/browser-c1-2.jpg']).toBeTruthy();
  });
  it('a full capture is clipped to the page height and a black bottom is reported, not shown', async () => {
    const asked = [];
    const api = {
      ...globalThis.__ocmBrowser,
      eval: async ({ js }) => (js.includes('scrollHeight') && js.includes('innerWidth') ? { value: JSON.stringify(JSON.stringify({ w: 390, h: 2400 })) } : js.includes('createTreeWalker') ? { value: '420' } : globalThis.__ocmBrowser.eval({ js })),
      screenshot: async (o) => (asked.push(o), { base64: btoa('x'), blank: false, width: 1170, height: 4500, blackTail: 2700, cut: 0, tall: true }),
    };
    const r = await captureFrame(api, { full: true });
    expect(asked[0]).toMatchObject({ full: true, clip: 2400, vw: 390 });
    expect(r.verdict).toBe('ok');
    expect(r.message).toMatch(/bottom 900 px .* black \(never painted\) and were cut off – the page has 420 characters of text there/);
  });
  it('the element list says how many more there are', async () => {
    const base = globalThis.__ocmBrowser;
    globalThis.__ocmBrowser = { ...base, eval: async ({ js }) => (js.includes('snapshot(') ? { value: JSON.stringify({ url: siteOrigin('c1') + '/a.html', title: 'T', text: '', textFrom: 0, textLen: 0, elements: ['[1] button "a"'], moreElements: 37, moreBelow: 30, moreAbove: 7, scrollY: 0, pageHeight: 800, viewHeight: 800 }) } : base.eval({ js })) };
    const ctx = { convId: 'c1', workspace: { files: {} } };
    const r = await runBrowser({ action: 'open', url: '/workspace/a.html' }, ctx);
    expect(r.result).toMatch(/\[1\] button "a"\n… 37 more \(30 further down, 7 above\) – scroll, or use a selector/);
    globalThis.__ocmBrowser = base;
  });
  it('says when a file:// path was served from the workspace origin instead', async () => {
    const r = await runBrowser({ action: 'open', url: 'file:///workspace/site/login.html' }, { convId: 'c1', workspace: { files: {} } });
    expect(r.result).toMatch(/NOT opened as a file:\/\/ page/);
  });
  it('viewport reports the size the page really got and applies it again when it did not stick', async () => {
    await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: 'c1' });
    const base = globalThis.__ocmBrowser.eval;
    const sizes = [[390, 844, 390], [1280, 900, 1280]];
    globalThis.__ocmBrowser.eval = async (a) => (a.js.includes('innerWidth,innerHeight') ? { value: JSON.stringify(JSON.stringify(sizes.shift())) } : base(a));
    const r = await runBrowser({ action: 'viewport', width: 1280, height: 900 }, { convId: 'c1' });
    expect(opened.length).toBe(3); // open + two tries
    expect(r.result).toMatch(/innerWidth 1280/);
    expect(r.result).not.toMatch(/NOT the size/);
  });
});

describe('preview_page as a served site', () => {
  const ws = () => ({ files: { 'site/login.html': { data: enc('<html><head></head><body>hi</body></html>') }, 'site/dashboard.html': { data: enc('<p>d</p>') } } });
  const call = (args) => ({ name: 'preview_page', arguments: JSON.stringify(args) });
  it('accepts a #fragment, serves the page and reports what the page saw', async () => {
    const r = await runTool(call({ path: 'site/dashboard.html#demo', view: 'mobile' }), { convId: 'c1', workspace: ws(), vision: true });
    expect(r.ok).toBe(true);
    expect(opened[0].url).toBe(siteOrigin('c1') + '/site/dashboard.html#demo');
    expect(r.result).toContain('could not load /app.css');
    expect(r.result).toContain('call browser with url "/workspace/site/dashboard.html"');
  });
  it('runs steps (type, click) before the screenshot', async () => {
    const r = await runTool(call({ path: 'site/login.html', view: 'mobile', steps: [{ action: 'click', selector: 'text=Sign in' }] }), { convId: 'c1', workspace: ws(), vision: true });
    expect(r.result).toMatch(/Steps:[\s\S]*#1 click/);
  });
  it('a frame that stays blank is a failure, not ok=1', async () => {
    shots = [{ blank: true, color: '#000000' }, { blank: true }, { blank: true, color: '#000000' }];
    const r = await runTool(call({ path: 'site/login.html', view: 'mobile' }), { convId: 'c1', workspace: ws(), vision: true });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/PREVIEW FAILED[\s\S]*never painted/);
  });
  it('a page that did not load is a failure', async () => {
    status.error = 'net::ERR_FAILED';
    const orig = globalThis.__ocmBrowser.open;
    globalThis.__ocmBrowser.open = async (a) => {
      await orig(a);
      status.error = 'net::ERR_FAILED';
    };
    const r = await runTool(call({ path: 'site/login.html', view: 'mobile' }), { convId: 'c1', workspace: ws(), vision: true });
    expect(r.ok).toBe(false);
    expect(r.result).toContain('ERR_FAILED');
  });
  it('a missing file is said plainly', async () => {
    const r = await runTool(call({ path: 'site/nope.html' }), { convId: 'c1', workspace: ws(), vision: true });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/No such file/);
  });
});
