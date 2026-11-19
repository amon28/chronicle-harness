import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeBrowser, runBrowser, downloadFileName } from '../../src/browsercontrol.js';
import { runTool } from '../../src/tools.js';

// Leftovers of the round-6 browser hunt: pictures in steps, download and PDF names, scroll y as text, the reopen note.
const ID = 'leftover-b1';
let shots, status, evals;
beforeEach(async () => {
  status = { url: '', title: '', error: null, httpStatus: 200 };
  shots = [];
  evals = [];
  globalThis.__ocmTiles = async (s) => Array.from({ length: s.bytes.length > 4 ? 4 : 1 }, () => 'data:image/jpeg;base64,AA==');
  globalThis.__ocmBrowser = {
    open: async (a) => { status.url = a.url; },
    eval: async ({ js }) => {
      evals.push(js);
      if (js === 'document.readyState') return { value: '"complete"' };
      if (js === 'window.__ocmPaint||0') return { value: '1' };
      return { value: JSON.stringify({ url: status.url, title: status.title || 'T', text: 'hello', textFrom: 0, textLen: 5, elements: [], scrollY: 0, pageHeight: 800, viewHeight: 800 }) };
    },
    status: async () => ({ ...status }),
    screenshot: async () => shots.shift(),
    fetchFile: async (a) => { return { status: 200, url: a.url, mime: 'application/octet-stream', base64: btoa('xyz') }; },
    pdf: async () => ({ base64: btoa('%PDF-1.4'), pages: 1 }),
    close: async () => {},
  };
  await closeBrowser(ID);
});
afterEach(() => { delete globalThis.__ocmTiles; });

const ctxOf = (files = {}) => ({ convId: ID, workspace: { id: ID, files }, settings: {}, vision: true });
const call = (args, ctx) => runTool({ name: 'browser', arguments: JSON.stringify(args) }, ctx);

describe('steps with several tall screenshots', () => {
  it('a picture that is not sent is not announced as shown, and every part has its own label', async () => {
    const ctx = ctxOf();
    await call({ action: 'open', url: 'https://example.com/' }, ctx);
    shots = [{ base64: btoa('aaaaaaaa'), width: 390, height: 7000, tall: true }, { base64: btoa('bbbbbbbbb'), width: 390, height: 7618, tall: true }];
    const r = await call({ steps: [{ action: 'screenshot', full_page: true }, { action: 'screenshot', full_page: true }] }, ctx);
    expect(r.images.length).toBeLessThanOrEqual(4);
    const labels = r.images.map((x) => x.path);
    expect(new Set(labels).size).toBe(labels.length);
    const [p1, p2] = r.result.split(/\n\n(?=#2 )/);
    expect(p1).not.toMatch(/shown in the next message/);
    expect(p1).toMatch(/not shown/i);
    expect(p2).toMatch(/shown in the next message/);
    expect(labels.every((l) => l.startsWith('#2 '))).toBe(true);
  });
  it('two short screenshots both fit and are both shown', async () => {
    const ctx = ctxOf();
    await call({ action: 'open', url: 'https://example.com/' }, ctx);
    shots = [{ base64: btoa('a'), width: 390, height: 300, tall: true }, { base64: btoa('b'), width: 390, height: 300, tall: true }];
    const r = await call({ steps: [{ action: 'screenshot' }, { action: 'screenshot' }] }, ctx);
    expect(r.images.map((x) => x.path)).toEqual(['#1 browser', '#2 browser']);
    expect(r.result).not.toMatch(/not shown/i);
  });
});

describe('download names', () => {
  it('a name over 80 characters keeps its extension', () => {
    const n = downloadFileName('a'.repeat(120) + '.tar.gz');
    expect(n.length).toBeLessThanOrEqual(80);
    expect(n).toMatch(/\.gz$/);
    expect(downloadFileName('Отчёт.pdf')).toBe('Отчёт.pdf');
    expect(downloadFileName('../..')).toBe('download');
  });
  it('a percent-encoded name from the address is decoded', async () => {
    const files = {};
    const ctx = ctxOf(files);
    await call({ action: 'open', url: 'https://example.com/' }, ctx);
    const r = await call({ action: 'download', url: 'https://example.com/files/Rapport%20%C3%A9t%C3%A9%202.xlsx?x=1' }, ctx);
    expect(r.ok).toBe(true);
    expect(Object.keys(files)).toContain('downloads/Rapport été 2.xlsx');
  });
  it('a broken escape in the address does not fail the download', async () => {
    const files = {};
    const ctx = ctxOf(files);
    await call({ action: 'open', url: 'https://example.com/' }, ctx);
    const r = await call({ action: 'download', url: 'https://example.com/a%E0%A4%A.bin' }, ctx);
    expect(r.ok).toBe(true);
    expect(Object.keys(files).some((k) => k.startsWith('downloads/') && k.endsWith('.bin'))).toBe(true);
  });
  it('a PDF from a page with a non-ASCII title keeps the title', async () => {
    const files = {};
    const ctx = ctxOf(files);
    await call({ action: 'open', url: 'https://example.com/' }, ctx);
    status.title = 'Отчёт за 2025: итоги/план';
    const r = await call({ action: 'pdf', full: false }, ctx);
    expect(r.ok).toBe(true);
    expect(Object.keys(files)).toContain('output/pdf/Отчёт-за-2025-итоги-план.pdf');
  });
});

describe('scroll and reopen', () => {
  it('scroll with y given as text jumps there', async () => {
    const ctx = ctxOf();
    await call({ action: 'open', url: 'https://example.com/' }, ctx);
    await call({ action: 'scroll', y: '1200' }, ctx);
    expect(evals.some((j) => j.includes('window.__ocmB.scroll("down",1200,0)'))).toBe(true);
  });
  it('a page the phone closed during the reply is not said to be closed after the last reply', async () => {
    const ctx = ctxOf();
    await call({ action: 'open', url: 'https://example.com/' }, ctx);
    status.url = ''; // another chat opened a fifth page: this one was closed to make room
    const r = await runBrowser({ action: 'read' }, ctx);
    expect(r.result).toMatch(/opened again/);
    expect(r.result).not.toMatch(/after the last reply/);
    await closeBrowser(ID); // the end of a reply
    const r2 = await runBrowser({ action: 'read' }, ctx);
    expect(r2.result).toMatch(/closed after the last reply/);
  });
});
