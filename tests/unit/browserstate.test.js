import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeBrowser } from '../../src/browsercontrol.js';
import { runTool } from '../../src/tools.js';

const ID = 'state1';
let status, opened;
const snap = () => ({ url: status.url, title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 });
beforeEach(async () => {
  status = { url: '', title: '', error: null, httpStatus: 200 };
  opened = [];
  globalThis.__ocmServe = async (w, convId) => '/data/shell/work/' + convId;
  globalThis.__ocmBrowser = {
    open: async (a) => { opened.push(a); status.url = a.url; },
    eval: async ({ js }) => (js === 'document.readyState' ? { value: '"complete"' } : { value: JSON.stringify(snap()) }),
    status: async () => ({ ...status }),
    close: async () => { status.url = ''; },
  };
  await closeBrowser(ID);
});
afterEach(() => { delete globalThis.__ocmServe; });
const ctx = () => ({ convId: ID, workspace: { id: ID, files: {} }, settings: {}, vision: true });
const call = (args, c = ctx()) => runTool({ name: 'browser', arguments: JSON.stringify(args) }, c);

describe('an open that is refused leaves the page that is open alone', () => {
  it('a workspace page stays usable after open with an address that is not allowed', async () => {
    const first = await call({ action: 'open', url: '/workspace/site/index.html' });
    expect(first.ok).toBe(true);
    const site = status.url;
    const no = await call({ action: 'open', url: 'http://192.168.1.10/admin' });
    expect(no.ok).toBe(false);
    expect(no.result).toMatch(/Won't open that address/);
    const r = await call({ action: 'read' });
    expect(r.result).not.toMatch(/moved to an address that is not allowed/);
    expect(r.ok).toBe(true);
    expect(status.url).toBe(site); // not closed
  });
  it('a server on this phone stays usable too, and is reopened with its permission', async () => {
    await call({ action: 'open', url: 'http://127.0.0.1:8099/' });
    await call({ action: 'open', url: 'file:///etc/passwd' });
    const r = await call({ action: 'read' });
    expect(r.ok).toBe(true);
    await closeBrowser(ID);
    await call({ action: 'read' });
    expect(opened.at(-1)).toMatchObject({ url: 'http://127.0.0.1:8099/', loopback: true });
  });
});
