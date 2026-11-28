// Decision 273: browser state save asks the user every time (the file is their sign-in) and is refused where nobody
// can answer; the console action merges Android's own console log (from the first line of loading) with the page
// script's list.
import { describe, it, expect, beforeEach } from 'vitest';
import { runBrowser, mergeConsole } from '../../src/browsercontrol.js';

const ID = 'consent1';
let nativeLog, pageLog;
const snap = () => ({ url: 'https://shop.alex.dev/', title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 });
beforeEach(async () => {
  nativeLog = [];
  pageLog = [];
  let ran = '';
  globalThis.__ocmBrowser = {
    open: async () => {},
    status: async () => ({ url: 'https://shop.alex.dev/', title: 'T', httpStatus: 200 }),
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js.endsWith('try{JSON.stringify(window.__ocmLog||[])}catch(e){JSON.stringify({__error:String(e&&e.message||e)})}')) return { value: JSON.stringify(JSON.stringify(pageLog)) };
      if (js.includes('window.__ocmE={done:false}')) return (ran = js), { value: '"started"' };
      if (js.includes('JSON.stringify(window.__ocmE||{})')) return { value: JSON.stringify(JSON.stringify({ done: true, v: ran ? JSON.stringify({ origin: 'https://shop.alex.dev', local: { t: '1' }, session: {}, idb: [] }) : '0' })) };
      return { value: JSON.stringify(snap()) };
    },
    cookieJar: async () => ({ cookies: 'sid=secret' }),
    console: async ({ clear }) => {
      const m = nativeLog.slice();
      if (clear) nativeLog.length = 0;
      return { messages: m };
    },
    close: async () => {},
    screenshot: async () => ({ base64: '' }),
  };
  await runBrowser({ action: 'open', url: 'https://shop.alex.dev/' }, { convId: ID });
});

describe('state save asks the user every time (decision 273)', () => {
  const files = () => ({});
  it('asks which site and that it holds the sign-in; saves only on yes', async () => {
    const put = files();
    const asked = [];
    const ctx = { convId: ID, putFile: (p, b) => ((put[p] = b), '/workspace/' + p), workspace: { files: {} }, ask: async (q, opts) => (asked.push({ q, opts }), opts[0]) };
    const r = await runBrowser({ action: 'state', op: 'save' }, ctx);
    expect(r.ok).toBe(true);
    expect(asked[0].q).toMatch(/Save your sign-in for shop\.alex\.dev\?/);
    expect(asked[0].q).toMatch(/signed in to shop\.alex\.dev as you/);
    expect(put['browser-state/session.json']).toBeTruthy();
    // and again the next time
    await runBrowser({ action: 'state', op: 'save' }, ctx);
    expect(asked).toHaveLength(2);
  });
  it('a no saves nothing', async () => {
    const put = files();
    const ctx = { convId: ID, putFile: (p, b) => ((put[p] = b), '/workspace/' + p), workspace: { files: {} }, ask: async () => 'Not now' };
    const r = await runBrowser({ action: 'state', op: 'save' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/Not saved/);
    expect(Object.keys(put)).toEqual([]);
  });
  it('is refused without anyone to ask (a helper, a scheduled run)', async () => {
    const put = files();
    for (const extra of [{}, { ask: async () => 'Save it', unattended: true }]) {
      const ctx = { convId: ID, putFile: (p, b) => ((put[p] = b), '/workspace/' + p), workspace: { files: {} }, ...extra };
      await expect(runBrowser({ action: 'state', op: 'save' }, ctx)).rejects.toThrow(/needs the user's OK each time/);
    }
    expect(Object.keys(put)).toEqual([]);
  });
});

describe('console merges Android\'s log with the page script\'s (decision 273)', () => {
  it('lists load-time errors only Android saw, once each, with file:line', async () => {
    nativeLog.push({ t: 'error', m: 'Uncaught ReferenceError: boot is not defined', at: 'https://shop.alex.dev/app.js:3' }, { t: 'log', m: 'ready', at: 'https://shop.alex.dev/app.js:9' });
    pageLog.push({ t: 'log', m: 'ready' }, { t: 'log', m: '{"a":1}' });
    const r = await runBrowser({ action: 'console' }, { convId: ID });
    expect(r.result).toMatch(/Android's console log from the first line of loading/);
    expect(r.result).toContain('boot is not defined');
    expect(r.result).toContain('app.js:3');
    expect(r.result.match(/"ready"/g)).toHaveLength(1);
    expect(r.result).toContain('{\\"a\\":1}');
  });
  it('merges the same error from both, keeping the page script\'s text', () => {
    const out = mergeConsole(
      [{ t: 'pageerror', m: 'Uncaught TypeError: x is not a function' }, { t: 'pageerror', m: 'Unhandled rejection: nope' }],
      [{ t: 'error', m: 'Uncaught TypeError: x is not a function', at: 'a.js:1' }, { t: 'error', m: 'Uncaught (in promise) Error: nope', at: 'a.js:2' }],
    );
    expect(out).toEqual([
      { t: 'pageerror', m: 'Uncaught TypeError: x is not a function', at: 'a.js:1' },
      { t: 'pageerror', m: 'Unhandled rejection: nope', at: 'a.js:2' },
    ]);
  });
});
