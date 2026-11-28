// Mods and run_script stay in their own page (decision 273): the app talks to a sandboxed frame only through the
// MessagePort it handed to the frame's own page, so a page the frame was navigated to can neither call the app nor
// receive what the app sends; a frame that leaves its page stops the mod. And a mod's request is checked on every
// redirect hop (host permission, private addresses), dropping credentials when the origin changes.
import { describe, it, expect, afterEach } from 'vitest';
import vm from 'node:vm';
import { ModInstance, modFetch } from '../../src/mods.js';
import { scriptDocument } from '../../src/runscript.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for the app window and one sandboxed frame running the page's script in a VM. */
function fakeDom() {
  const atHost = [];
  const frames = [];
  const win = {
    addEventListener: (t, f) => t === 'message' && atHost.push(f),
    removeEventListener: (t, f) => atHost.includes(f) && atHost.splice(atHost.indexOf(f), 1),
  };
  const toHost = (data, source) => atHost.slice().forEach((f) => f({ data, source }));
  const document = {
    createElement: () => {
      const inFrame = { message: [], pagehide: [] };
      const windowMessages = [];
      const contentWindow = {
        postMessage: (m, _o, ports) => {
          windowMessages.push(m);
          setTimeout(() => inFrame.message.slice().forEach((f) => f({ data: m, source: parent, ports: ports || [] })), 0);
        },
      };
      const parent = { postMessage: (m) => setTimeout(() => toHost(m, contentWindow), 0) };
      const frame = {
        contentWindow,
        windowMessages,
        style: {},
        setAttribute() {},
        remove() {},
        run(doc) {
          const js = /<script>([\s\S]*)<\/script>/.exec(doc)[1];
          const sb = { parent, setTimeout, clearTimeout, Promise, JSON, String, Map, Object, Error };
          sb.addEventListener = (t, f) => inFrame[t]?.push(f);
          sb.removeEventListener = (t, f) => inFrame[t]?.includes(f) && inFrame[t].splice(inFrame[t].indexOf(f), 1);
          sb.window = sb;
          vm.createContext(sb);
          vm.runInContext(js, sb);
        },
        // the frame's page goes away (it navigated): its pagehide listeners run, then it is gone
        navigateAway() {
          inFrame.pagehide.forEach((f) => f({}));
          inFrame.message.length = 0;
        },
        // what a page loaded into the frame could do: post to the app through the same window
        postAsFrame: (m) => toHost(m, contentWindow),
      };
      frames.push(frame);
      return frame;
    },
    body: { append: (f) => f.run(f.srcdoc) },
  };
  return { win, document, frames };
}

const saved = {};
function install(dom) {
  saved.window = globalThis.window;
  saved.document = globalThis.document;
  globalThis.window = dom.win;
  globalThis.document = dom.document;
}
afterEach(() => {
  globalThis.window = saved.window;
  globalThis.document = saved.document;
});

const host = () => ({ changed() {}, toast() {}, data: () => ({}), setData() {} });
const manifest = { id: 'dice', name: 'Dice', version: '1', permissions: ['tools'] };
const code = `mod.tool({ name: 'roll', description: 'roll', run: async (a) => 'rolled ' + a.n });`;

describe('a mod talks to the app only through its port (decision 273)', () => {
  it('starts, runs a tool through the port, and sends the app nothing through the window after the hello', async () => {
    const dom = fakeDom();
    install(dom);
    const m = new ModInstance(manifest, code, host());
    const r = await m.start();
    expect(r).toMatchObject({ ok: true, tools: 1 });
    expect(await m.invoke('tool', 'roll', { args: { n: 4 } }, 2000)).toBe('rolled 4');
    // only the port hand-over went through the frame's window – nothing a navigated page could pick up
    expect(dom.frames[0].windowMessages.map((x) => x.type)).toEqual(['port']);
    m.stop();
  });

  it('ignores window messages carrying the token (a page the frame navigated to), and stops a mod whose page left', async () => {
    const dom = fakeDom();
    install(dom);
    let storageCalls = 0;
    const h = { ...host(), data: () => (storageCalls++, {}) };
    const m = new ModInstance({ ...manifest, permissions: ['tools', 'storage'] }, code, h);
    await m.start();
    const frame = dom.frames[0];
    frame.postAsFrame({ __mod: m.token, type: 'storage.get', id: 99, k: 'x' });
    frame.postAsFrame({ __mod: m.token, type: 'hello' });
    await tick();
    expect(storageCalls).toBe(0);
    expect(frame.windowMessages.map((x) => x.type)).toEqual(['port']); // no second port for a second hello
    frame.navigateAway();
    await tick();
    expect(m.ready).toBe(false);
    expect(m.error).toMatch(/loaded another page into its frame/);
    await expect(m.invoke('tool', 'roll', { args: { n: 1 } }, 500)).rejects.toThrow(/another page/);
  });

  it('cancels a navigation where the Navigation API exists', () => {
    const doc = scriptDocument('t', 'print(1)');
    const js = /<script>([\s\S]*)<\/script>/.exec(doc)[1];
    const navigate = [];
    const sb = { parent: { postMessage() {} }, setTimeout, Promise, JSON, String, Map, Object, Proxy, addEventListener() {}, removeEventListener() {}, navigation: { addEventListener: (t, f) => t === 'navigate' && navigate.push(f) } };
    vm.createContext(sb);
    vm.runInContext(js, sb);
    let prevented = false;
    navigate.forEach((f) => f({ cancelable: true, preventDefault: () => (prevented = true), destination: { url: 'https://evil.example/?d=1' } }));
    expect(prevented).toBe(true);
  });
});

describe("a mod's request is checked on every redirect hop (decision 273)", () => {
  const redirects = (map) => {
    const seen = [];
    const send = async (url, method, headers, body) => {
      seen.push({ url, method, headers, body });
      const to = map[url];
      return to ? { status: to[0], headers: { Location: to[1] }, text: '' } : { status: 200, headers: {}, text: 'ok:' + url };
    };
    return { seen, send };
  };
  const only = (...hosts) => (h) => hosts.includes(h);

  it('refuses a hop to a host outside the permission, to a local address, or to plain http', async () => {
    let n = redirects({ 'https://api.alex.dev/a': [302, 'https://other.example/b'] });
    await expect(modFetch('https://api.alex.dev/a', {}, { allowed: only('api.alex.dev'), send: n.send, isPublic: null })).rejects.toThrow(/redirects to other\.example, which this mod may not connect to/);
    expect(n.seen).toHaveLength(1);
    n = redirects({ 'https://api.alex.dev/a': [307, 'https://192.168.1.10/admin'] });
    await expect(modFetch('https://api.alex.dev/a', {}, { allowed: () => true, send: n.send, isPublic: null })).rejects.toThrow(/local address/);
    expect(n.seen).toHaveLength(1);
    n = redirects({ 'https://api.alex.dev/a': [301, 'http://api.alex.dev/b'] });
    await expect(modFetch('https://api.alex.dev/a', {}, { allowed: () => true, send: n.send, isPublic: null })).rejects.toThrow(/only https/);
  });

  it('asks the phone whether each hop resolves to a private address', async () => {
    const n = redirects({ 'https://api.alex.dev/a': [302, 'https://rebind.example/x'] });
    const asked = [];
    const isPublic = async (u) => {
      asked.push(u);
      if (u.includes('rebind')) throw new Error('That address is on a private network, so it is not opened');
    };
    await expect(modFetch('https://api.alex.dev/a', {}, { allowed: () => true, send: n.send, isPublic })).rejects.toThrow(/private network/);
    expect(asked).toEqual(['https://api.alex.dev/a', 'https://rebind.example/x']);
    expect(n.seen).toHaveLength(1);
  });

  it('follows allowed hops, drops credentials when the origin changes, and turns a 303 into a GET', async () => {
    const n = redirects({ 'https://api.alex.dev/a': [308, 'https://api.alex.dev/b'], 'https://api.alex.dev/b': [303, 'https://cdn.alex.dev/c'] });
    const r = await modFetch('https://api.alex.dev/a', { method: 'POST', body: { x: 1 }, headers: { Authorization: 'Bearer k', Cookie: 's=1', 'Content-Type': 'application/json', 'X-Mod': 'y' } }, { allowed: only('api.alex.dev', 'cdn.alex.dev'), send: n.send, isPublic: null });
    expect(r).toEqual({ status: 200, ok: true, body: 'ok:https://cdn.alex.dev/c' });
    expect(n.seen[1]).toMatchObject({ url: 'https://api.alex.dev/b', method: 'POST', body: '{"x":1}' });
    expect(n.seen[1].headers.Authorization).toBe('Bearer k'); // same origin: kept
    expect(n.seen[2]).toMatchObject({ url: 'https://cdn.alex.dev/c', method: 'GET', body: undefined, headers: { 'X-Mod': 'y' } });
    expect(Object.keys(n.seen[2].headers)).toEqual(['X-Mod']);
  });

  it('stops after five redirects', async () => {
    const map = {};
    for (let i = 0; i < 8; i++) map[`https://api.alex.dev/${i}`] = [302, `/${i + 1}`];
    const n = redirects(map);
    await expect(modFetch('https://api.alex.dev/0', {}, { allowed: () => true, send: n.send, isPublic: null })).rejects.toThrow(/too many/);
  });
});
