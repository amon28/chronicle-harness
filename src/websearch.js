// On-device web search, ported from the user's websearch.js (itself a port of headlessWebSearch.py):
// Bing, Brave, Google and DuckDuckGo are asked at once, results are merged and ranked, and the best
// pages are read. Instead of a headless Edge, pages are fetched with the app's native HTTP (no CORS,
// real desktop Edge User-Agent) and parsed with DOMParser, so it runs on the phone with nothing to install.
// Engines that answer with a captcha or a JavaScript-only page simply contribute nothing.
import { httpGet } from './api.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const HEADERS = { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

export const ENGINES = {
  bing: {
    url: 'https://www.bing.com/search?q={q}&setlang=en', weight: 1.1,
    items: 'li.b_algo', title: 'h2', link: 'h2 a[href^="http"], a[href^="http"]', snippet: '.b_caption p, .b_algoSlug, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4',
  },
  brave: {
    url: 'https://search.brave.com/search?q={q}', weight: 1.0,
    items: 'div[data-type="web"]', title: '.search-snippet-title, div.title', link: 'a.l1, a[href^="http"]', snippet: '.generic-snippet .content, div.content',
  },
  google: {
    url: 'https://www.google.com/search?q={q}&hl=en', weight: 1.3,
    items: 'div.g, div[data-hveid]', title: 'h3', link: 'a[href^="http"], a[href^="/url?"]', snippet: 'div.VwiC3b, span.aCOpRe, div[data-sncf]',
  },
  // extra: DuckDuckGo's no-JavaScript HTML page (works well without a browser engine)
  duckduckgo: {
    url: 'https://html.duckduckgo.com/html/?q={q}', weight: 1.0,
    items: '.result:not(.result--ad)', title: '.result__a', link: 'a.result__a', snippet: '.result__snippet',
  },
};
const ENGINE_HOSTS = /(^|\.)(google|bing|brave|duckduckgo)\.com$/;
const BLOCKED = ['just a moment', 'attention required', 'captcha', 'unusual traffic', 'are you a robot', 'verify you are human'];

const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function b64urlDecode(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '==='.slice((b.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Engine redirect links → the real target. */
export function unwrap(url, base) {
  try {
    const u = new URL(url, base);
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
      const v = u.searchParams.get('u'); // "a1" + base64url of the target
      if (v?.startsWith('a1')) return b64urlDecode(v.slice(2));
    }
    if (u.hostname.endsWith('google.com') && u.pathname === '/url') return u.searchParams.get('q') || u.searchParams.get('url') || u.href;
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname === '/l/') return u.searchParams.get('uddg') || u.href;
    return u.href;
  } catch {
    return url;
  }
}

/** Parse one engine's result page. Exported for testing. */
export function parseEngine(name, html, max = 8) {
  const cfg = ENGINES[name];
  const doc = parse(html);
  const title = clean(doc.title).toLowerCase();
  if (BLOCKED.some((m) => title.includes(m))) return [];
  const base = cfg.url.split('?')[0];
  const out = [];
  for (const item of doc.querySelectorAll(cfg.items)) {
    const h = item.querySelector(cfg.title);
    const a = item.querySelector(cfg.link);
    const s = item.querySelector(cfg.snippet);
    const t = clean(h?.textContent);
    let url = a ? unwrap(a.getAttribute('href'), base) : '';
    if (t && url.startsWith('http')) out.push({ title: t, url, snippet: clean(s?.textContent), engine: name });
    if (out.length >= max) break;
  }
  return out;
}

async function searchEngine(name, query, max) {
  const cfg = ENGINES[name];
  try {
    const r = await httpGet(cfg.url.replace('{q}', encodeURIComponent(query)), HEADERS, 9000);
    if (r.status >= 400) return [];
    return parseEngine(name, r.body, max);
  } catch {
    return [];
  }
}

const keyOf = (url) => {
  const u = new URL(url);
  return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '').toLowerCase();
};

/** Merge result lists: a page found by several engines, or found high up, ranks first. Exported for testing. */
export function mergeResults(lists, max = 6) {
  const merged = new Map();
  lists.forEach((list) =>
    list.forEach((r, i) => {
      let key;
      try {
        key = keyOf(r.url);
        if (ENGINE_HOSTS.test(new URL(r.url).hostname)) return; // the engines' own links
      } catch {
        return;
      }
      const score = (ENGINES[r.engine]?.weight || 1) / (i + 1);
      const m = merged.get(key);
      if (m) {
        m.score += score;
        m.engines.push(r.engine);
        if (!m.snippet && r.snippet) m.snippet = r.snippet;
      } else merged.set(key, { ...r, engines: [r.engine], score });
    }),
  );
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, max);
}

/** Ask every engine at once (each capped at 7 s) and merge. */
export async function search(query, { max = 6, engines = Object.keys(ENGINES) } = {}) {
  // an engine that shows a consent or bot page would otherwise hold everything up
  const capped = (n) => Promise.race([searchEngine(n, query, 8), new Promise((r) => setTimeout(() => r([]), 7000))]);
  const lists = await Promise.all(engines.map(capped));
  const answered = engines.filter((_, i) => lists[i].length);
  const results = mergeResults(lists, max);
  if (!results.length) throw new Error('no results (the search engines may have asked for a captcha)');
  return { results, answered };
}

// Pages on the phone or the local network are never opened (a model could otherwise point it at a router).
export function unsafe(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'bad address';
  }
  if (!/^https?:$/.test(u.protocol)) return 'not a web page';
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return 'local address';
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h)) return 'local address';
  if (h === '::1' || /^f[cd]|^fe80|^::ffff:(127|10|192\.168)\./i.test(h)) return 'local address';
  return null;
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TR', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'TABLE', 'UL', 'OL', 'DT', 'DD', 'FIGCAPTION']);

/** Main text of an HTML page, without menus, headers and footers. Exported for testing. */
export function pageText(html) {
  const doc = parse(html);
  const title = clean(doc.title);
  const root = doc.querySelector('article, main, [role=main]') || doc.body;
  if (!root) return { title, text: '' };
  root.querySelectorAll('nav, header, footer, aside, script, style, noscript, form, svg, iframe, template, [role=navigation], [aria-hidden=true], .cookie, #cookie-banner').forEach((n) => n.remove());
  // keep line structure: add newlines after block elements (textContent alone would glue paragraphs)
  root.querySelectorAll('*').forEach((n) => {
    if (BLOCK_TAGS.has(n.tagName)) n.after(doc.createTextNode('\n'));
    if (n.tagName === 'LI') n.before(doc.createTextNode('• '));
    if (n.tagName === 'TD' || n.tagName === 'TH') n.after(doc.createTextNode(' \t'));
    if (/^H[1-6]$/.test(n.tagName)) n.before(doc.createTextNode('\n'));
  });
  const text = (root.textContent || '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
}

// sign-up walls, member perks, cookie and newsletter prompts: lines that say nothing about the page's subject and would
// fill the few thousand characters a search reads of it
const BOILER = /\b(free member|members? only|become a member|sign ?up (now|for free|to (read|continue|unlock|see))|log ?in to (read|continue|see|comment)|create (a )?(free )?account|subscribe (now|to (read|continue|unlock))|already (a member|have an account)|accept (all )?cookies|cookie (settings|policy|preferences)|we use cookies|newsletter|what can you do as a|unlock (all|this|full)|remove ads|ad-?free)\b/i;
/** The page text without boilerplate lines (short lines that are only about accounts, cookies or ads). Exported for testing. */
export function dropBoilerplate(text) {
  const out = [];
  let skip = 0; // after a sign-up heading, its short perk lines go too ("Bookmark articles", "Post comments", a ✓ table)
  for (const l of String(text).split('\n')) {
    const t = l.trim();
    if (t.length < 240 && BOILER.test(t)) {
      skip = 25;
      continue;
    }
    if (skip > 0 && t.length < 45 && !/[.!?:]$/.test(t)) {
      skip--;
      continue;
    }
    skip = 0;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'who', 'when', 'where', 'why', 'is', 'are', 'was', 'latest', 'new', 'best', 'from', 'that', 'this', 'about', 'does', 'can']);
/**
 * A result that shares none of the query's words (title, snippet, address) is a weak match: engines return something
 * for any query, even gibberish. Exported for testing.
 */
export function weakMatch(query, r) {
  const words = [...new Set((String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP.has(w) && !/^(site|filetype)$/.test(w)))];
  if (!words.length) return false;
  const hay = `${r.title || ''} ${r.snippet || ''} ${r.url || ''}`.toLowerCase();
  // a third of the searched words at least: one shared word of six ("stress" in a gibberish query) is chance
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits < Math.max(1, Math.ceil(words.length / 3));
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/**
 * The date a snippet carries ("January 14, 2025", "14 Jan 2025", "2025-01-14"), when it is more than about six months
 * before `now`: the engine's cached copy may be that old even when the page is not. → "2025-01-14" or ''. Exported
 * for testing.
 */
export function oldSnippetDate(snippet, now = Date.now()) {
  const t = String(snippet || '');
  let d = null;
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) d = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (!d && (m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(t))) d = Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  if (!d && (m = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i.exec(t))) d = Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  if (!d || Number.isNaN(d) || d > now) return '';
  return now - d > 183 * 864e5 ? new Date(d).toISOString().slice(0, 10) : '';
}

export async function read(url, { maxChars = 4000, timeoutMs = 15000 } = {}) {
  const why = unsafe(url);
  if (why) return { url, error: why };
  try {
    const r = await httpGet(url, HEADERS, timeoutMs);
    if (r.status >= 400) return { url, error: `HTTP ${r.status}` };
    if (r.body.startsWith('%PDF')) return { url, error: 'this is a PDF – ask the user to attach it, or try another source' };
    const { title, text: raw } = pageText(r.body);
    if (BLOCKED.some((m) => title.toLowerCase().includes(m))) return { url, title, error: 'blocked by a security check' };
    const text = dropBoilerplate(raw);
    // a cut is said, with how much is missing, so a sentence that stops mid-way is not read as the page's end
    return { url, title, text: text.length > maxChars ? `${text.slice(0, maxChars)}\n[… cut here: ${text.length - maxChars} more characters – fetch_url the page for all of it]` : text };
  } catch (e) {
    return { url, error: String(e.message).split('\n')[0] };
  }
}

/** Search, then read the top pages in parallel: what the chat model gets to look at. */
export async function research(query, { pages = 2, max = 6 } = {}) {
  const { results, answered } = await search(query, { max });
  const opened = await Promise.all(results.slice(0, pages).map((r) => read(r.url, { maxChars: 3500, timeoutMs: 10000 })));
  return { answered, results: results.map((r, i) => ({ ...r, text: opened[i]?.text || '' })) };
}
