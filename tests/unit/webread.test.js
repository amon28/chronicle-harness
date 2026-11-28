import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
let routes = {};
vi.mock('../../src/api.js', () => ({
  httpGet: vi.fn(async (url, headers) => {
    calls.push({ url, headers });
    const hit = Object.entries(routes).find(([k]) => url === k || url.startsWith(k));
    if (!hit) return { status: 404, body: 'not found' };
    return typeof hit[1] === 'function' ? hit[1](url, headers) : hit[1];
  }),
  canFetchAnySite: true,
  bytesRequest: vi.fn(async ({ url }) => {
    const hit = Object.entries(routes).find(([k]) => url === k || url.startsWith(k));
    return hit?.[1]?.bytes ? { status: 200, headers: {}, body: hit[1].bytes } : { status: 404, headers: {}, body: new Uint8Array() };
  }),
}));
/** A small real PDF with one line of text on each page. */
function makePdf(lines) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${lines.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${lines.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  lines.forEach((t, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${t}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
// no DOM in the unit-test environment: a tiny stand-in for the article extractor
vi.mock('../../src/websearch.js', async (orig) => ({
  ...(await orig()),
  pageText: (html) => ({
    title: (html.match(/<title>([^<]*)/i) || [])[1] || '',
    text: html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '').replace(/<head[\s\S]*?<\/head>/i, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  }),
}));
const { readUrl, formatRead, parseJina, looksLikeShell, enforceOperators, parseOperators, pageLinks, scriptSources } = await import('../../src/webread.js');

const SHELL = '<!doctype html><html><head><title>Chords</title><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div><noscript>You need to enable JavaScript.</noscript></body></html>';
const ARTICLE = `<html><head><title>An article</title></head><body><article><h1>Hello</h1><p>${'A real paragraph with plenty of words. '.repeat(12)}</p></article></body></html>`;

beforeEach(() => {
  calls.length = 0;
  routes = {};
});

describe('reading a URL', () => {
  it('reads an ordinary article directly and reports the facts', async () => {
    routes['https://a.com/post'] = { status: 200, body: ARTICLE };
    const r = await readUrl('https://a.com/post');
    expect(r).toMatchObject({ ok: true, status: 200, via: 'direct', type: 'html' });
    expect(r.text).toContain('A real paragraph');
    expect(formatRead(r)).toContain('Status: ok');
  });
  it('returns JSON, XML and robots.txt verbatim, not through the article extractor', async () => {
    routes['https://a.com/data.json'] = { status: 200, body: '{"title":"x","n":1}' };
    routes['https://a.com/robots.txt'] = { status: 200, body: 'User-agent: *\nDisallow: /admin' };
    routes['https://a.com/sitemap.xml'] = { status: 200, body: '<?xml version="1.0"?><urlset><url><loc>https://a.com/1</loc></url></urlset>' };
    expect((await readUrl('https://a.com/data.json')).text).toBe('{"title":"x","n":1}');
    expect((await readUrl('https://a.com/robots.txt')).type).toBe('text');
    expect((await readUrl('https://a.com/sitemap.xml')).type).toBe('xml');
  });
  it('an empty app shell is rendered with JavaScript, with the #fragment encoded for the renderer', async () => {
    routes['https://app.web.app/'] = { status: 200, body: SHELL };
    routes['https://r.jina.ai/'] = { status: 200, body: 'Title: Chord Manager\n\nURL Source: https://app.web.app/#/playlists\n\nMarkdown Content:\n# Playlists\n- Sunday set (12 songs)\n- Wedding set (8 songs)' };
    const r = await readUrl('https://app.web.app/#/playlists');
    expect(r).toMatchObject({ ok: true, via: 'jina', title: 'Chord Manager' });
    expect(r.text).toContain('Sunday set');
    expect(calls.find((c) => c.url.startsWith('https://r.jina.ai/')).url).toBe('https://r.jina.ai/https://app.web.app/%23/playlists');
    expect(calls[0].url).toBe('https://app.web.app/'); // the direct fetch never carried the fragment
  });
  it('flags a partial render, and says plainly when a page is a missing, blocked or JS-only', async () => {
    routes['https://app.web.app/'] = { status: 200, body: SHELL };
    routes['https://r.jina.ai/'] = { status: 200, body: 'Title: T\n\nWarning: This page maybe not yet fully loaded, consider explicitly specify a timeout.\n\nMarkdown Content:\nSome content that did load fine here, enough to read.' };
    expect((await readUrl('https://app.web.app/')).partial).toBe(true);
    routes['https://a.com/gone'] = { status: 404, body: 'x' };
    expect(await readUrl('https://a.com/gone')).toMatchObject({ ok: false, reason: 'not_found', status: 404 });
    routes['https://a.com/priv'] = { status: 403, body: 'x' };
    routes['https://r.jina.ai/'] = { status: 403, body: 'x' };
    expect(await readUrl('https://a.com/priv')).toMatchObject({ ok: false, reason: 'blocked' });
    expect(await readUrl('http://192.168.1.1/')).toMatchObject({ ok: false, reason: 'local' });
  });
  it('static mode never renders, and says js_required for a shell', async () => {
    routes['https://app.web.app/'] = { status: 200, body: SHELL };
    const r = await readUrl('https://app.web.app/', { render: 'static' });
    expect(r).toMatchObject({ ok: false, reason: 'js_required' });
    expect(calls.some((c) => c.url.startsWith('https://r.jina.ai/'))).toBe(false);
  });
  it('html and links formats expose the source and the app\'s script files; custom headers go on the direct fetch only', async () => {
    routes['https://app.web.app/'] = { status: 200, body: SHELL };
    const h = await readUrl('https://app.web.app/', { format: 'html', headers: { 'Accept-Language': 'de' } });
    expect(h.text).toContain('<div id="root">');
    expect(calls[0].headers['Accept-Language']).toBe('de');
    const l = await readUrl('https://app.web.app/', { format: 'links' });
    expect(l.text).toContain('https://app.web.app/assets/app.js');
    expect(scriptSources(SHELL, 'https://app.web.app/')).toEqual(['https://app.web.app/assets/app.js']);
    expect(pageLinks('<a href="/x">x</a><a href="#top">t</a>', 'https://a.com/')).toEqual(['https://a.com/x']);
  });
});

describe('helpers', () => {
  it('spots shells and parses the renderer output', () => {
    expect(looksLikeShell(SHELL, '')).toBe(true);
    expect(looksLikeShell(ARTICLE, 'x'.repeat(300))).toBe(false);
    expect(parseJina('Title: A\n\nMarkdown Content:\nbody').text).toBe('body');
  });
  it('enforces site: / filetype: operators and says when nothing matched', () => {
    const results = [{ title: 'a', url: 'https://ipdefenseforum.com/x' }, { title: 'b', url: 'https://songbook.example.net/songs' }, { title: 'c', url: 'https://x.org/a.pdf' }];
    expect(parseOperators('site:songbook.example.net songs').site).toEqual(['songbook.example.net']);
    expect(enforceOperators('site:songbook.example.net', results).results.map((r) => r.title)).toEqual(['b']);
    const none = enforceOperators('site:nowhere.dev app', results);
    expect(none.results).toHaveLength(0);
    expect(none.note).toContain('NO result matched');
    expect(enforceOperators('-site:x.org filetype:pdf q', results).results).toHaveLength(0);
    expect(enforceOperators('plain query', results).results).toHaveLength(3);
  });
});

describe('a PDF is read, not only named (decision 270)', () => {
  it('fetch_url takes the text out of a PDF, page by page', async () => {
    const pdf = makePdf(['Quarterly results are up', 'Second page here']);
    routes['https://example.com/r.pdf'] = { status: 200, body: new TextDecoder('latin1').decode(pdf), bytes: pdf };
    const r = await readUrl('https://example.com/r.pdf', { render: 'static' });
    expect(r.ok).toBe(true);
    expect(r.type).toBe('pdf');
    expect(r.note).toBe('PDF, 2 pages');
    expect(r.text).toMatch(/--- Page 1 ---\nQuarterly results are up[\s\S]*--- Page 2 ---\nSecond page here/);
  }, 30000);
});

describe("an address on the user's network (decision 271)", () => {
  it('is refused, and says how to ask; allowed for the chat, it is read directly and never sent to the renderer', async () => {
    routes['http://192.168.1.20/'] = { status: 200, body: ARTICLE };
    const no = await readUrl('http://192.168.1.20/');
    expect(no.reason).toBe('local');
    expect(no.note).toMatch(/local_network action request/);
    expect(calls).toEqual([]);
    const yes = await readUrl('http://192.168.1.20/', { lanAllow: ['192.168.1.20'] });
    expect(yes.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['http://192.168.1.20/']); // no r.jina.ai
    expect((await readUrl('http://192.168.1.21/', { lanAllow: ['192.168.1.20'] })).reason).toBe('local');
  });
});
