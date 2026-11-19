import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeBrowser } from '../../src/browsercontrol.js';
import { runTool } from '../../src/tools.js';

// download url=sample.txt on a workspace page (https://<chat>.workspace.localhost/) was refused as a "local address",
// while a click on the page's own <a download> link for the same file worked. The page's own origin – the workspace
// site, or the server on this phone it was opened from – is allowed now; every other local address stays refused.
const ID = 'dl-local1';
let status, fetched, pageFetched;
beforeEach(async () => {
  status = { url: '', title: '', error: null, httpStatus: 200 };
  fetched = [];
  pageFetched = [];
  let ff = null;
  globalThis.__ocmServe = async (w, convId) => '/data/shell/work/' + convId;
  globalThis.__ocmBrowser = {
    open: async (a) => { status.url = a.url; },
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      const m = /window\.__ocmFF=\{state:'fetching'\};fetch\(("[^"]*")\)/.exec(js);
      if (m) {
        pageFetched.push(JSON.parse(m[1]));
        ff = { state: 'done', status: 200, mime: 'text/plain', url: JSON.parse(m[1]), base64: btoa('hello from the workspace') };
        return { value: '"ok"' };
      }
      if (js.includes('try{JSON.stringify(window.__ocmFF||{})}')) return { value: JSON.stringify(JSON.stringify(ff || {})) };
      return { value: JSON.stringify({ url: status.url, title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) };
    },
    status: async () => ({ ...status }),
    fetchFile: async (a) => { fetched.push(a.url); return { status: 200, url: a.url, mime: 'text/csv', base64: btoa('a,b') }; },
    close: async () => { status.url = ''; },
  };
  await closeBrowser(ID);
});
afterEach(() => { delete globalThis.__ocmServe; });
const saved = [];
const ctx = () => ({ convId: ID, workspace: { id: ID, files: {} }, settings: {}, vision: true, saveDownload: (n) => (saved.push(n), '/workspace/downloads/' + n) });
const call = (args) => runTool({ name: 'browser', arguments: JSON.stringify(args) }, ctx());

describe('download from the page\'s own origin', () => {
  it('a relative url on a workspace page is fetched by the page and saved', async () => {
    await call({ action: 'open', url: '/workspace/site/index.html' });
    const origin = new URL(status.url).origin;
    const r = await call({ action: 'download', url: 'sample.txt' });
    expect(r.ok).toBe(true);
    expect(pageFetched).toEqual([`${origin}/site/sample.txt`]);
    expect(fetched).toEqual([]); // not sent out through the native fetch
    expect(r.result).toMatch(/saved as \/workspace\/downloads\/sample\.txt/);
    expect(r.result).toMatch(/hello from the workspace/);
  });
  it('other local addresses stay refused, and the refusal says why and what to do', async () => {
    await call({ action: 'open', url: '/workspace/site/index.html' });
    const r = await call({ action: 'download', url: 'http://127.0.0.1:8080/secret' });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/not allowed \(local address\)/);
    expect(r.result).toMatch(/click its link/);
    const other = await call({ action: 'download', url: 'https://cother.workspace.localhost/x.txt' }); // another chat's site
    expect(other.ok).toBe(false);
    await call({ action: 'open', url: 'https://example.com/' });
    const lan = await call({ action: 'download', url: 'http://192.168.1.1/x' });
    expect(lan.ok).toBe(false);
    expect(fetched).toEqual([]);
    expect(pageFetched).toEqual([]);
  });
  it('a server on this phone the page was opened from: its own files only', async () => {
    await call({ action: 'open', url: 'http://127.0.0.1:8099/' });
    const r = await call({ action: 'download', url: 'data.csv' });
    expect(r.ok).toBe(true);
    expect(fetched).toEqual(['http://127.0.0.1:8099/data.csv']);
    const no = await call({ action: 'download', url: 'http://127.0.0.1:9000/admin' });
    expect(no.ok).toBe(false);
    expect(fetched.length).toBe(1);
  });
});
