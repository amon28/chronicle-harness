// Reading a URL for the assistant: a ladder of strategies with plain facts about what happened to each page.
//   1. direct fetch on the phone (verbatim for JSON/XML/text; article text for HTML)
//   2. pages that need JavaScript (empty app shells) → rendered by r.jina.ai, a public rendering reader
//   3. whatever is still unreadable → Exa (done by the caller)
// Every URL gets its own result: { url, ok, reason, status, via, type, bytes, ms, partial, note, title, text }.
import { httpGet } from './api.js';
import { pageText, unsafe } from './websearch.js';
import { lanHostOf } from './lan.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const BASE_HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8' };
const BLOCKED = ['just a moment', 'attention required', 'captcha', 'unusual traffic', 'are you a robot', 'verify you are human', 'access denied'];
export const JINA = 'https://r.jina.ai/';

/** Reasons a page could not be read (so "needs JavaScript" is never confused with "does not exist"). */
export const REASONS = { js_required: 'the page is built by JavaScript (an empty app shell)', not_found: 'HTTP 404 – the page does not exist', blocked: 'blocked (HTTP 401/403, a captcha or a bot check)', timeout: 'timed out', empty: 'the page has no readable text', http_error: 'the server returned an error', local: 'local addresses are never opened', pdf: 'a PDF – download it (shell: curl -L -o file.pdf <url>, or browser action download when it needs a sign-in) and extract the text (pdftotext, or pypdf in run_python)', network: 'could not connect' };

const kind = (url, body) => {
  const head = body.slice(0, 400).trimStart().toLowerCase();
  if (/\.json(\?|$)/i.test(url) || /^[[{]/.test(head)) return 'json';
  if (/\.(xml|rss|atom)(\?|$)/i.test(url) || head.startsWith('<?xml') || /^<(urlset|sitemapindex|rss|feed)\b/.test(head)) return 'xml';
  if (/\.(txt|csv|md|tsv|yaml|yml|js|css|map|ts|py)(\?|$)/i.test(url) || /\/(robots\.txt|llms\.txt|humans\.txt)$/i.test(url)) return 'text';
  if (!/<(html|body|head|div|p|a|script|!doctype)[\s>]/i.test(head + body.slice(400, 1500).toLowerCase())) return 'text';
  return 'html';
};

/** Does this HTML look like an app shell that only fills itself in with JavaScript? */
export function looksLikeShell(html, text) {
  if ((text || '').length >= 200) return false;
  return /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["']|__NEXT_DATA__|data-reactroot|ng-version|<noscript[^>]*>[^<]*(enable|requires?)[^<]*javascript|<script[^>]+type=["']module["']/i.test(html) || (html.match(/<script\b/gi) || []).length >= 1;
}

export const scriptSources = (html, base) =>
  [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => abs(m[1], base)).filter(Boolean);
export const pageLinks = (html, base) => {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<(a|link|img|script|form)\b[^>]*\b(href|src|action)=["']([^"'#][^"']*)["']/gi)) {
    const u = abs(m[3], base);
    if (u && !seen.has(u) && /^https?:/.test(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
};
const abs = (u, base) => {
  try {
    return new URL(u, base).href;
  } catch {
    return null;
  }
};

const reasonFor = (status) => (status === 404 || status === 410 ? 'not_found' : status === 401 || status === 403 || status === 451 || status === 429 ? 'blocked' : 'http_error');
const oneLine = (e) => String(e?.message || e).split('\n')[0];

/** Pages rendered by r.jina.ai come back as "Title: …\n\nURL Source: …\n\nWarning: …\n\nMarkdown Content:\n…". */
export function parseJina(body) {
  const i = body.indexOf('Markdown Content:');
  const head = i >= 0 ? body.slice(0, i) : '';
  return {
    title: head.match(/^Title:\s*(.*)$/m)?.[1]?.trim() || '',
    warning: head.match(/^Warning:\s*([\s\S]*?)(?:\n\n|$)/m)?.[1]?.trim() || '',
    text: (i >= 0 ? body.slice(i + 'Markdown Content:'.length) : body).trim(),
  };
}

const PDF_MAX = 25 * 1024 * 1024;
async function pdfText(url, headers, timeoutMs, maxChars, lanAllow = []) {
  const { bytesRequest } = await import('./api.js');
  // guarded like the first read: every hop public (or the chat's allowed local address it started at)
  const r = await Promise.race([bytesRequest({ url, headers, guard: true, lanAllow }), new Promise((_, no) => setTimeout(() => no(new Error('timed out')), Math.max(timeoutMs, 30000)))]);
  if (r.status >= 400 || !r.body?.length || r.body.length > PDF_MAX) return null;
  const { pdfBytesToText } = await import('./files.js');
  const p = await pdfBytesToText(r.body, maxChars + 2000);
  if (p.empty) return { empty: true };
  return { text: p.text.slice(0, maxChars), cut: p.text.length > maxChars || p.pagesRead < p.pageCount, pageCount: p.pageCount, bytes: r.body.length };
}

async function viaJina(url, headers, timeoutMs, maxChars, format) {
  const target = url.replace(/#/g, '%23'); // a fragment never reaches a server – encode it so the renderer sees the whole address
  const h = { 'X-Return-Format': format === 'html' ? 'html' : 'markdown', 'X-Timeout': String(Math.round(timeoutMs / 1000)), Accept: 'text/plain', ...headers };
  const r = await httpGet(JINA + target, h, timeoutMs + 4000);
  if (r.status >= 400) return { error: true, status: r.status };
  const p = parseJina(r.body);
  return { ...p, partial: /not (be |yet )?fully loaded|timed? ?out|partial/i.test(p.warning), text: p.text.slice(0, maxChars), bytes: r.body.length };
}

/**
 * Read one page. opts: { format: 'text'|'html'|'raw'|'links', render: 'auto'|'js'|'static', maxChars, timeoutMs, headers }
 */
export async function readUrl(url, opts = {}) {
  const { format = 'text', maxChars = 6000, timeoutMs = 15000, headers = {}, lanAllow = [] } = opts;
  let { render = 'auto' } = opts;
  const t0 = Date.now();
  const done = (o) => ({ url, ms: Date.now() - t0, ...o });
  const why = unsafe(url);
  // an address on the user's own network that this chat was allowed (decision 271): read directly, never rendered
  // through the outside renderer (it cannot reach it, and must not be told it)
  const lan = why && lanAllow.length && lanAllow.includes(lanHostOf(url));
  if (why && !lan) return done({ ok: false, reason: 'local', note: REASONS.local + (lanHostOf(url) ? (opts.unattended ? ' – a scheduled run or a helper never gets local-network access; the Linux shell reaches it (curl), or the user runs it in the chat' : ' – unless the user allows this address for the chat: local_network action request') : '') });
  if (lan) render = 'static';
  const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
  const bare = hash ? url.slice(0, url.indexOf('#')) : url;
  const hdr = { ...BASE_HEADERS, ...headers };
  // never through the outside renderer (decision 273) when the caller sent headers – a request made with a key or a
  // cookie is the caller's own, and r.jina.ai would get the address without them (or, for a 401, a public copy of
  // something else) – or asked for the page as it is (raw, html): then the origin's own answer is the result, a 4xx
  // with its body included.
  const own = Object.keys(headers || {}).length > 0;
  const noRenderer = own || format === 'raw' || format === 'html';
  if (own && render === 'js') return done({ ok: false, reason: 'http_error', note: 'not sent to the JavaScript renderer: it would not get the headers this request was made with (render "auto" or "static" reads the page directly)' });

  if (render !== 'js') {
    try {
      const r = await httpGet(bare, hdr, timeoutMs, lan ? { lanAllow } : undefined);
      const body = r.body || '';
      if (r.status >= 400) {
        const reason = reasonFor(r.status);
        if (noRenderer) return done({ ok: false, status: r.status, reason, via: 'direct', bytes: body.length, text: body.slice(0, maxChars), note: `HTTP ${r.status}${REASONS[reason] ? ' – ' + REASONS[reason] : ''}${body ? ' – the server\'s own answer is below' : ''}` });
        if (!(render === 'auto' && reason === 'blocked')) return done({ ok: false, status: r.status, reason, note: `HTTP ${r.status}${REASONS[reason] ? ' – ' + REASONS[reason] : ''}` });
      } else if (body.startsWith('%PDF')) {
        // a PDF is read too (decision 270): fetched again as bytes and its text taken out on the phone, with pdf.js
        const t = await pdfText(bare, hdr, timeoutMs, maxChars, lan ? lanAllow : []).catch(() => null);
        if (t?.text) return done({ ok: true, status: r.status, via: 'direct', type: 'pdf', bytes: t.bytes, title: '', text: t.text, note: `PDF, ${t.pageCount} page${t.pageCount === 1 ? '' : 's'}${t.cut ? ` – text cut at ${maxChars} characters (pass max_chars for more)` : ''}` });
        return done({ ok: false, status: r.status, reason: 'pdf', note: t?.empty ? 'a PDF with no selectable text (a scan) – download it and look at its pages as images, or OCR them' : REASONS.pdf });
      }
      else {
        const type = kind(bare, body);
        const base = { ok: true, status: r.status, via: 'direct', type, bytes: body.length };
        if (type !== 'html' || format === 'raw') return done({ ...base, text: body.slice(0, maxChars) });
        if (format === 'html') return done({ ...base, text: body.slice(0, maxChars), note: scriptNote(body, bare) });
        if (format === 'links') {
          const scripts = scriptSources(body, bare);
          return done({ ...base, text: `Links, images, scripts and forms found in the page:\n${pageLinks(body, bare).slice(0, 150).join('\n')}${scripts.length ? `\n\nScript files (the app's code – API calls and config live in these):\n${scripts.slice(0, 20).join('\n')}` : ''}` });
        }
        const { title, text } = pageText(body);
        if (own) {
          const failed = BLOCKED.some((m) => title.toLowerCase().includes(m)) ? 'blocked' : !text ? (looksLikeShell(body, text) ? 'js_required' : 'empty') : null;
          if (failed || looksLikeShell(body, text)) return done({ ...base, title, text: text.slice(0, maxChars), ...(failed ? { ok: false, reason: failed } : {}), note: 'read directly only: a request with headers is not sent to the JavaScript renderer (format "html" gives the page as it is)' });
        }
        if (BLOCKED.some((m) => title.toLowerCase().includes(m))) {
          if (render === 'static') return done({ ...base, ok: false, reason: 'blocked', title, note: REASONS.blocked });
        } else if (text.length >= 200 || render === 'static') {
          return done({ ...base, title, text: text.slice(0, maxChars), ...(text ? {} : { ok: false, reason: looksLikeShell(body, text) ? 'js_required' : 'empty' }), note: hash ? `the #fragment (${hash}) is handled by the page's JavaScript, so it is not part of this text` : undefined });
        } else if (!looksLikeShell(body, text) && text) {
          return done({ ...base, title, text: text.slice(0, maxChars) }); // short, but a real page
        }
        // otherwise: an empty shell – fall through to the renderer
      }
    } catch (e) {
      if (render === 'static' || noRenderer) return done({ ok: false, reason: /timed? ?out/i.test(oneLine(e)) ? 'timeout' : 'network', note: oneLine(e) });
    }
  }

  // 2. JavaScript rendering
  try {
    const j = await viaJina(url, {}, Math.max(timeoutMs, 15000), maxChars, format);
    if (j.error) return done({ ok: false, status: j.status, reason: reasonFor(j.status), via: 'jina', note: `the renderer got HTTP ${j.status}` });
    if (!j.text || j.text.length < 40) return done({ ok: false, via: 'jina', reason: 'empty', note: 'rendered, but still no readable text' });
    return done({ ok: true, via: 'jina', type: 'html (rendered)', title: j.title, text: j.text, bytes: j.bytes, partial: j.partial, note: j.partial ? 'the renderer stopped early – the page may not be fully loaded' : undefined });
  } catch (e) {
    return done({ ok: false, reason: /timed? ?out/i.test(oneLine(e)) ? 'timeout' : 'network', note: `JavaScript rendering failed: ${oneLine(e)}` });
  }
}

const scriptNote = (html, base) => {
  const s = scriptSources(html, base);
  return s.length ? `script files: ${s.slice(0, 8).join(' , ')}` : undefined;
};

/** One readable block for the model: a facts line, then the content (or why there is none). */
export function formatRead(r) {
  const facts = [r.status && `HTTP ${r.status}`, r.via && `via ${r.via}`, r.type, r.bytes && `${r.bytes >= 1024 ? Math.round(r.bytes / 1024) + ' KB' : r.bytes + ' B'}`, r.ms != null && `${r.ms} ms`, r.partial && 'PARTIAL'].filter(Boolean).join(' · ');
  const head = `URL: ${r.url}${r.title ? `\nTitle: ${r.title}` : ''}\nStatus: ${r.ok ? 'ok' : 'failed'}${r.reason ? ` (${r.reason}: ${REASONS[r.reason] || ''})` : ''}${facts ? ` · ${facts}` : ''}${r.note ? `\nNote: ${r.note}` : ''}`;
  return r.text ? `${head}\n\n${r.text}` : head;
}

// ---------- search operators ----------
/** site:, -site:, filetype: from a query. */
export function parseOperators(query) {
  const ops = { site: [], notSite: [], filetype: [] };
  for (const m of String(query).matchAll(/(^|\s)(-?)(site|filetype):("?)([^\s"]+)\4/gi)) {
    const v = m[5].toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (m[3].toLowerCase() === 'filetype') ops.filetype.push(m[5].toLowerCase());
    else (m[2] ? ops.notSite : ops.site).push(v.replace(/^www\./, ''));
  }
  return ops;
}
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};
const inSite = (host, site) => host === site || host.endsWith('.' + site);

/** Enforce the operators the search backend may have ignored. Returns { results, note }. */
export function enforceOperators(query, results) {
  const ops = parseOperators(query);
  if (!ops.site.length && !ops.notSite.length && !ops.filetype.length) return { results, note: '' };
  let out = results;
  if (ops.site.length) out = out.filter((r) => ops.site.some((s) => inSite(hostOf(r.url), s)));
  if (ops.notSite.length) out = out.filter((r) => !ops.notSite.some((s) => inSite(hostOf(r.url), s)));
  if (ops.filetype.length) out = out.filter((r) => ops.filetype.some((f) => new RegExp(`\\.${f}(\\?|$)`, 'i').test(r.url)));
  const dropped = results.length - out.length;
  const note = !out.length
    ? `Search operators (${[...ops.site.map((s) => 'site:' + s), ...ops.notSite.map((s) => '-site:' + s), ...ops.filetype.map((f) => 'filetype:' + f)].join(' ')}) were applied and NO result matched – the search engine does not index that site or ignored the operator. Use fetch_url on the site directly (try format "links", or its /sitemap.xml) instead of searching for it.`
    : dropped
      ? `(${dropped} result${dropped === 1 ? '' : 's'} that did not match your site:/filetype: operators were removed)`
      : '';
  return { results: out, note };
}
