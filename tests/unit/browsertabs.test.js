import { describe, it, expect, beforeEach } from 'vitest';
import { closeBrowser, runBrowser } from '../../src/browsercontrol.js';

// Decision 211: a window the page opens is a tab of its own (said in the result, listed / switched / closed with action
// tabs); press uses a real key when it reaches the page, and does the key's work by hand when it does not; route
// answers requests, HTTP sign-ins are asked for by handoff.
const ID = 'tabs1';
let st, tabs, keys, keySeen, pressed, routeCalls, cred, url;
const snap = () => ({ url, title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 });
beforeEach(async () => {
  st = { url: 'https://example.com/', title: 'T', httpStatus: 200, tabs: 1, tab: 0, tabSeq: 0 };
  tabs = [{ index: 0, url: 'https://example.com/', title: 'Home', active: true }];
  keys = [];
  keySeen = 0;
  pressed = [];
  routeCalls = [];
  cred = null;
  url = 'https://example.com/';
  globalThis.__ocmBrowser = {
    open: async () => {},
    status: async () => ({ ...st }),
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js.includes('window.__ocmKeyTok=') && js.includes('window.__ocmKeySeen|0)')) return { value: String(keySeen) };
      if (js.includes('JSON.stringify([window.__ocmKeyTok===')) return { value: JSON.stringify(JSON.stringify([true, keySeen, false])) };
      const m = /window\.__ocmB\.press\(("[^"]*")/.exec(js);
      if (m) return (pressed.push(JSON.parse(m[1])), { value: JSON.stringify('pressed – done by hand, as the browser would: the focus moved to input#b') });
      return { value: JSON.stringify(snap()) };
    },
    key: async (a) => {
      keys.push(a);
    },
    tabs: async () => ({ tabs }),
    switchTab: async ({ index }) => ({ tabs: tabs.map((t) => ({ ...t, active: t.index === index })) }),
    closeTab: async () => ({ tabs: tabs.slice(0, 1).map((t) => ({ ...t, active: true })) }),
    route: async (a) => (routeCalls.push(a), { routes: (a.routes || []).map((r) => ({ pattern: r.pattern, status: r.status, hits: 0 })), offline: !!a.offline }),
    httpCredentials: async (a) => {
      cred = a;
    },
    close: async () => {},
  };
  await closeBrowser(ID);
  await runBrowser({ action: 'open', url: 'https://example.com/' }, { convId: ID });
});
const call = (a) => runBrowser(a, { convId: ID });

describe('tabs', () => {
  it('a popup the page opens is said, with where you are now and how to go back', async () => {
    // the click opens a window: the phone makes it a tab and puts it in use
    globalThis.__ocmBrowser.eval = ((orig) => async (o) => {
      if (o.js.includes('__ocmB.click(')) Object.assign(st, { tabs: 2, tab: 1, tabSeq: 1, tabEvent: 'opened' });
      return orig(o);
    })(globalThis.__ocmBrowser.eval);
    const r = await call({ action: 'click', selector: '#signin' });
    expect(r.result).toMatch(/The page opened a new tab .* you are on tab 1 of 2 open/);
    expect(r.result).toMatch(/action tabs/);
    // the next look does not say it again
    const r2 = await call({ action: 'read' });
    expect(r2.result).not.toMatch(/opened a new tab/);
  });
  it('a popup that closes itself (a sign-in finishing) says you are back', async () => {
    Object.assign(st, { tabs: 1, tab: 0, tabSeq: 2, tabEvent: 'closed itself' });
    const r = await call({ action: 'read' });
    expect(r.result).toMatch(/A tab closed itself \(a popup that finished\) – you are on tab 0 of 1/);
  });
  it('a request the app refused because it goes to the local network is said once, as not loaded (decision 268)', async () => {
    st.refused = ['frame or file http://router.lan/admin (router.lan points to 192.168.1.1, a local address)'];
    const r = await call({ action: 'read' });
    expect(r.result).toMatch(/\[Not loaded – the app blocks local-network addresses, so nothing was sent to them: frame or file http:\/\/router\.lan\/admin \(router\.lan points to 192\.168\.1\.1/);
    expect(r.result).toMatch(/nothing inside to read or click/);
    delete st.refused; // the phone clears it once said
    const r2 = await call({ action: 'read' });
    expect(r2.result).not.toMatch(/Not loaded/);
  });
  it('list, switch and close', async () => {
    tabs = [{ index: 0, url: 'https://example.com/', title: 'Home', active: false }, { index: 1, url: 'https://accounts.example/', title: 'Sign in', active: true }];
    const l = await call({ action: 'tabs' });
    expect(l.result).toMatch(/2 tabs/);
    expect(l.result).toMatch(/→ \[1\] Sign in – https:\/\/accounts\.example\//);
    const s = await call({ action: 'tabs', op: 'switch', index: 0 });
    expect(s.result).toMatch(/→ \[0\] Home/);
    expect(s.result).toMatch(/Page: T/); // then the page of that tab
    const c = await call({ action: 'tabs', op: 'close', index: 1 });
    expect(c.result).toMatch(/Tabs now/);
  });
  it('a tab the page opened empty (about:blank) is not taken for a forbidden address while other tabs are open', async () => {
    Object.assign(st, { tabs: 2, tab: 1, tabSeq: 1, tabEvent: 'opened' });
    url = 'about:blank';
    const r = await call({ action: 'read' });
    expect(r.ok).toBe(true);
    expect(r.result).not.toMatch(/not allowed/);
  });
});

describe('press', () => {
  it('a real key when it reaches the page', async () => {
    globalThis.__ocmBrowser.key = async (a) => {
      keys.push(a);
      keySeen++;
    };
    const r = await call({ action: 'press', key: 'Shift+Tab' });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ key: 'Tab', shift: true });
    expect(pressed).toEqual([]);
    expect(r.result).toMatch(/Pressed Shift\+Tab with a real key/);
  });
  it('a key that did not reach the hidden page: made by script and its work done by hand, and said', async () => {
    const r = await call({ action: 'press', key: 'Tab' });
    expect(keys).toHaveLength(1);
    expect(pressed).toEqual(['Tab']);
    expect(r.result).toMatch(/done by hand, as the browser would: the focus moved to input#b/);
  });
  it('Escape stays the script key (it closes the popover on top and says which)', async () => {
    await call({ action: 'press', key: 'Escape' });
    expect(keys).toEqual([]);
    expect(pressed).toEqual(['Escape']);
  });
});

describe('route and HTTP sign-ins', () => {
  it('routes go to the phone, a JSON body is sent as JSON, and the result says what is answered', async () => {
    const r = await call({ action: 'route', routes: [{ pattern: '/api/user', body: { name: 'Ada' } }] });
    expect(routeCalls[0].routes[0]).toEqual({ pattern: '/api/user', status: 200, body: '{"name":"Ada"}', type: 'application/json', headers: {} });
    expect(r.result).toMatch(/address with "\/api\/user" → HTTP 200/);
    expect(r.result).toMatch(/Online\./);
  });
  it('offline', async () => {
    const r = await call({ action: 'route', offline: true });
    expect(routeCalls[0]).toMatchObject({ offline: true });
    expect(routeCalls[0].routes).toBeUndefined();
    expect(r.result).toMatch(/OFFLINE: every request fails/);
  });
  it('a sign-in box nobody could answer is said, with handoff as the way', async () => {
    st.auth = 'intranet.example – "Staff"';
    const r = await call({ action: 'read' });
    expect(r.result).toMatch(/asks for an HTTP sign-in \(intranet\.example – "Staff"\).*Use handoff/s);
  });
  it('http_auth is for the page\'s host only', async () => {
    await call({ action: 'http_auth', user: 'ada', password: 'pw' });
    expect(cred).toMatchObject({ host: 'example.com', user: 'ada', password: 'pw' });
    await call({ action: 'http_auth' });
    expect(cred.user).toBeUndefined();
  });
});

describe('state', () => {
  it('save writes the site\'s storage and its cookies to /workspace/browser-state/, load puts them back and reloads', async () => {
    const files = {};
    const jar = [];
    let ran = '';
    globalThis.__ocmBrowser.cookieJar = async (a) => (a.set && jar.push(...a.set), { cookies: 'sid=1; theme=dark' });
    globalThis.__ocmBrowser.eval = ((orig) => async (o) => {
      if (o.js.includes('window.__ocmE={done:false}')) return (ran = o.js), { value: '"started"' };
      if (o.js.includes('JSON.stringify(window.__ocmE||{})')) return { value: JSON.stringify(JSON.stringify({ done: true, v: ran.includes('localStorage.setItem(k') ? '0' : JSON.stringify({ origin: 'https://example.com', local: { token: 'abc' }, session: {}, idb: [] }) })) };
      return orig(o);
    })(globalThis.__ocmBrowser.eval);
    const ctx = { convId: ID, putFile: (p, b) => ((files[p] = b), '/workspace/' + p), workspace: { files: {} }, ask: async () => 'Save it' };
    const s = await runBrowser({ action: 'state', op: 'save', name: 'my site' }, ctx);
    expect(s.result).toMatch(/Saved https:\/\/example\.com: 2 cookies, 1 localStorage .* → \/workspace\/browser-state\/my-site\.json. It holds this site's sign-in: do not commit/);
    const saved = JSON.parse(new TextDecoder().decode(files['browser-state/my-site.json']));
    expect(saved).toMatchObject({ cookies: 'sid=1; theme=dark', local: { token: 'abc' } });
    ctx.workspace.files['browser-state/my-site.json'] = { data: files['browser-state/my-site.json'] };
    const l = await runBrowser({ action: 'state', op: 'load', name: 'my site' }, ctx);
    expect(l.result).toMatch(/Loaded \/workspace\/browser-state\/my-site\.json .*2 cookies/);
    expect(ran).toContain('"token":"abc"');
    expect(jar).toEqual(['sid=1; Path=/; Max-Age=2592000; Secure', 'theme=dark; Path=/; Max-Age=2592000; Secure']);
    // another site's state is not put into this one
    ctx.workspace.files['browser-state/other.json'] = { data: new TextEncoder().encode(JSON.stringify({ origin: 'https://bank.example', local: {} })) };
    await expect(runBrowser({ action: 'state', op: 'load', name: 'other' }, ctx)).rejects.toThrow(/That state is for https:\/\/bank\.example, but the page is on https:\/\/example\.com/);
  });
});
