import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeBrowser } from '../../src/browsercontrol.js';
import { runTool } from '../../src/tools.js';

let shots, status;
beforeEach(async () => {
  status = { url: '', title: '', error: null, httpStatus: 200 };
  shots = [];
  globalThis.__ocmServe = async (w, convId) => '/data/shell/work/' + convId;
  // a tall capture is cut into parts for the model (in memory): 1 part for 317 px, 4 parts for 7618 px
  globalThis.__ocmTiles = async (s) => Array.from({ length: s.bytes.length > 4 ? 4 : 1 }, () => 'data:image/jpeg;base64,AA==');
  globalThis.__ocmBrowser = {
    open: async (a) => { status.url = a.url; },
    eval: async ({ js }) => {
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js === 'window.__ocmPaint||0') return { value: '1' };
      return { value: JSON.stringify({ url: status.url, title: 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) };
    },
    status: async () => ({ ...status }),
    screenshot: async () => shots.shift(),
    close: async () => {},
  };
  await closeBrowser('abf34b15-b42c-4c1e');
});
afterEach(() => { delete globalThis.__ocmServe; delete globalThis.__ocmTiles; });

describe('browser screenshot names', () => {
  it('two full_page captures in one session get two files', async () => {
    const files = {};
    const ctx = { convId: 'abf34b15-b42c-4c1e', workspace: { id: 'abf34b15-b42c-4c1e', files }, settings: {}, vision: true };
    await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'open', url: 'https://example.com/' }) }, ctx);
    shots = [{ base64: btoa('a'), width: 390, height: 317, tall: true }];
    const r1 = await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'screenshot', full_page: true }) }, ctx);
    shots = [{ base64: btoa('bbbbbbbbb'), width: 390, height: 7618, tall: true }];
    const r2 = await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'screenshot', full_page: true }) }, ctx);
    const n1 = /Saved as (\S+?\.jpg)/.exec(r1.result)?.[1];
    const n2 = /Saved as (\S+?\.jpg)/.exec(r2.result)?.[1];
    expect(n1).toBeTruthy();
    expect(n2).toBeTruthy();
    expect(n1).not.toBe(n2);
    expect(new TextDecoder().decode(files[n1.replace('/workspace/', '')].data)).toBe('a');
    expect(new TextDecoder().decode(files[n2.replace('/workspace/', '')].data)).toBe('bbbbbbbbb');
  });
  it('steps mode: two screenshots in one batch get two files', async () => {
    const files = {};
    const ctx = { convId: 'abf34b15-b42c-4c1e', workspace: { id: 'abf34b15-b42c-4c1e', files }, settings: {}, vision: true };
    await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'open', url: 'https://example.com/' }) }, ctx);
    shots = [{ base64: btoa('a'), width: 390, height: 317, tall: true }, { base64: btoa('bbbbbbbbb'), width: 390, height: 7618, tall: true }];
    await runTool({ name: 'browser', arguments: JSON.stringify({ steps: [{ action: 'screenshot', full_page: true }, { action: 'screenshot', full_page: true }] }) }, ctx);
    expect(Object.keys(files).filter((k) => k.startsWith('output/screenshots/')).length).toBe(2);
  });
  it('two calls in parallel (one model step) get two files', async () => {
    const files = {};
    const ctx = { convId: 'abf34b15-b42c-4c1e', workspace: { id: 'abf34b15-b42c-4c1e', files }, settings: {}, vision: true };
    await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'open', url: 'https://example.com/' }) }, ctx);
    shots = [{ base64: btoa('a'), width: 390, height: 317, tall: true }, { base64: btoa('bbbbbbbbb'), width: 390, height: 7618, tall: true }];
    await Promise.all([1, 2].map(() => runTool({ name: 'browser', arguments: JSON.stringify({ action: 'screenshot', full_page: true }) }, ctx)));
    expect(Object.keys(files).filter((k) => k.startsWith('output/screenshots/')).length).toBe(2);
  });
  it('a name is reused once the earlier capture is gone (moved, deleted, undone)', async () => {
    const files = {};
    const ctx = { convId: 'abf34b15-b42c-4c1e', workspace: { id: 'abf34b15-b42c-4c1e', files }, settings: {}, vision: true };
    await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'open', url: 'https://example.com/' }) }, ctx);
    shots = [{ base64: btoa('a'), width: 390, height: 317, tall: true }];
    const r1 = await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'screenshot', full_page: true }) }, ctx);
    // the agent moved it away / the user undid that reply's files
    files['keep/first.jpg'] = files['output/screenshots/browser-abf34b15-b42-1.jpg'];
    delete files['output/screenshots/browser-abf34b15-b42-1.jpg'];
    shots = [{ base64: btoa('bbbbbbbbb'), width: 390, height: 7618, tall: true }];
    const r2 = await runTool({ name: 'browser', arguments: JSON.stringify({ action: 'screenshot', full_page: true }) }, ctx);
    const n1 = /Saved as (\S+?\.jpg)/.exec(r1.result)?.[1];
    const n2 = /Saved as (\S+?\.jpg)/.exec(r2.result)?.[1];
    expect(n2).not.toBe(n1);
  });
});

import { shotName } from '../../src/sandbox.js';
describe('shotName', () => {
  it('only goes up, starts above what is there, and keeps the bare first name where asked', () => {
    const w = { id: 'x', files: {} };
    expect(shotName(w, 'output/screenshots/preview-a.html-mobile', 'jpg', { bare: true })).toBe('output/screenshots/preview-a.html-mobile.jpg');
    w.files['output/screenshots/preview-a.html-mobile.jpg'] = {};
    expect(shotName(w, 'output/screenshots/preview-a.html-mobile', 'jpg', { bare: true })).toBe('output/screenshots/preview-a.html-mobile-2.jpg');
    delete w.files['output/screenshots/preview-a.html-mobile.jpg']; // undone / moved: its name is not handed out again
    expect(shotName(w, 'output/screenshots/preview-a.html-mobile', 'jpg', { bare: true })).toBe('output/screenshots/preview-a.html-mobile-3.jpg');
    // a workspace restored from a backup (no counter): numbering continues above the files there
    const r = { id: 'y', files: { 'output/screenshots/browser-c1-1.jpg': {}, 'output/screenshots/browser-c1-7.jpg': {}, 'output/screenshots/browser-c1-1-9.jpg': {} } };
    expect(shotName(r, 'output/screenshots/browser-c1')).toBe('output/screenshots/browser-c1-8.jpg');
    // regex characters in a host or path are literal
    const h = { id: 'z', files: { 'output/screenshots/aXb-mobile-5.png': {} } };
    expect(shotName(h, 'output/screenshots/a.b-mobile', 'png', { bare: true })).toBe('output/screenshots/a.b-mobile.png');
  });
});
