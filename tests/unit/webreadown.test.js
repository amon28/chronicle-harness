// fetch_url with the caller's headers, or as raw/html, never goes to the outside renderer (decision 273): the origin's
// own status and body are the answer, a 4xx body included.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
let routes = {};
vi.mock('../../src/api.js', () => ({
  httpGet: vi.fn(async (url, headers) => {
    calls.push({ url, headers });
    const hit = Object.entries(routes).find(([k]) => url === k || url.startsWith(k));
    if (!hit) return { status: 404, body: 'not found' };
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  }),
  canFetchAnySite: true,
}));
vi.mock('../../src/websearch.js', async (orig) => ({
  ...(await orig()),
  pageText: (html) => ({ title: (html.match(/<title>([^<]*)/i) || [])[1] || '', text: html.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }),
}));
const { readUrl, formatRead } = await import('../../src/webread.js');

const SHELL = '<!doctype html><html><head><title>App</title><script type="module" src="/a.js"></script></head><body><div id="root"></div></body></html>';
const jina = () => calls.some((c) => c.url.startsWith('https://r.jina.ai/'));

beforeEach(() => {
  calls.length = 0;
  routes = { 'https://r.jina.ai/': { status: 200, body: 'Title: x\n\nMarkdown Content:\n' + 'rendered text '.repeat(10) } };
});

describe('fetch_url keeps a request with headers, or raw/html, at the origin (decision 273)', () => {
  it('a 401 with an API key: the server\'s own status and body, not the renderer', async () => {
    routes['https://api.alex.dev/me'] = { status: 401, body: '{"error":"bad key"}' };
    const r = await readUrl('https://api.alex.dev/me', { headers: { 'X-Api-Key': 'k1' } });
    expect(jina()).toBe(false);
    expect(r).toMatchObject({ ok: false, status: 401, reason: 'blocked', text: '{"error":"bad key"}' });
    expect(formatRead(r)).toContain('{"error":"bad key"}');
  });
  it('raw and html formats return a 403 body as it is, cut to maxChars', async () => {
    routes['https://a.alex.dev/x'] = { status: 403, body: 'F'.repeat(100) };
    for (const format of ['raw', 'html']) {
      const r = await readUrl('https://a.alex.dev/x', { format, maxChars: 10 });
      expect(r).toMatchObject({ ok: false, status: 403, text: 'F'.repeat(10) });
    }
    expect(jina()).toBe(false);
  });
  it('an app shell fetched with headers is not rendered outside; render "js" with headers is refused', async () => {
    routes['https://app.alex.dev/'] = { status: 200, body: SHELL };
    const r = await readUrl('https://app.alex.dev/', { headers: { Cookie: 's=1' } });
    expect(r).toMatchObject({ ok: false, reason: 'js_required', via: 'direct' });
    expect((await readUrl('https://app.alex.dev/', { headers: { Cookie: 's=1' }, render: 'js' })).ok).toBe(false);
    expect(jina()).toBe(false);
  });
  it('a network error with headers is reported, not retried through the renderer', async () => {
    routes['https://down.alex.dev/'] = new Error('Connection refused');
    const r = await readUrl('https://down.alex.dev/', { headers: { Authorization: 'Bearer t' } });
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(jina()).toBe(false);
  });
  it('without headers, an ordinary text read still falls back to the renderer for a 403 and a shell', async () => {
    routes['https://app.alex.dev/'] = { status: 200, body: SHELL };
    expect((await readUrl('https://app.alex.dev/')).via).toBe('jina');
    routes['https://p.alex.dev/'] = { status: 403, body: 'x' };
    expect((await readUrl('https://p.alex.dev/')).via).toBe('jina');
  });
});
