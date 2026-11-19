import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
let microlink = null;
vi.mock('../../src/api.js', () => ({
  httpGet: vi.fn(async (url, headers) => {
    calls.push({ url, headers });
    return microlink();
  }),
  fetchBytes: vi.fn(async (url) => {
    calls.push({ url });
    if (url.startsWith('https://image.thum.io/')) return new Uint8Array(2000).fill(1);
    return new Uint8Array(1000).fill(2);
  }),
}));
const { takeScreenshot } = await import('../../src/screenshot.js');

beforeEach(() => {
  calls.length = 0;
  delete globalThis.__ocmScreenshot;
});

describe('screenshots', () => {
  it('asks for a phone-sized window and returns the image', async () => {
    microlink = () => ({ status: 200, body: JSON.stringify({ status: 'success', data: { screenshot: { url: 'https://iad.microlink.io/x.jpeg', size: 1000, width: 780, height: 1688 } } }) });
    const r = await takeScreenshot('https://app.web.app/#/playlists', { view: 'mobile', key: 'K' });
    expect(r).toMatchObject({ via: 'microlink', width: 780, height: 1688, mime: 'image/jpeg' });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('viewport.width')).toBe('390');
    expect(u.searchParams.get('viewport.isMobile')).toBe('true');
    expect(u.searchParams.get('url')).toBe('https://app.web.app/#/playlists');
    expect(calls[0].headers['x-api-key']).toBe('K');
  });
  it('desktop is 1280 wide and not mobile; full page is passed on', async () => {
    microlink = () => ({ status: 200, body: JSON.stringify({ status: 'success', data: { screenshot: { url: 'https://iad.microlink.io/y.jpeg', size: 1000, width: 1280, height: 3000 } } }) });
    await takeScreenshot('https://a.com/', { view: 'desktop', fullPage: true });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('viewport.width')).toBe('1280');
    expect(u.searchParams.get('viewport.isMobile')).toBe('false');
    expect(u.searchParams.get('fullPage')).toBe('true');
  });
  it('falls back to thum.io when the free daily limit is used up', async () => {
    microlink = () => ({ status: 429, body: JSON.stringify({ status: 'fail', code: 'ERATE', message: 'limit' }) });
    const r = await takeScreenshot('https://a.com/', { view: 'mobile' });
    expect(r.via).toBe('thum.io');
    expect(calls.some((c) => c.url.startsWith('https://image.thum.io/get/viewportWidth/390/'))).toBe(true);
  });
  it('reports both reasons when everything fails, and never opens local addresses', async () => {
    microlink = () => ({ status: 500, body: 'oops' });
    const { fetchBytes } = await import('../../src/api.js');
    fetchBytes.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await expect(takeScreenshot('https://a.com/')).rejects.toThrow(/Could not take a screenshot/);
    await expect(takeScreenshot('http://192.168.0.1/')).rejects.toThrow(/Won't open/);
  });
  it('uses a test hook when installed', async () => {
    globalThis.__ocmScreenshot = async () => ({ bytes: new Uint8Array(3), width: 1, height: 2 });
    expect((await takeScreenshot('https://a.com/')).via).toBe('test');
  });
});
