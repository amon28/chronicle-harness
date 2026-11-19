// preview_page: the assistant looks at a web page it just wrote. The page (a workspace .html file) is made
// self-contained – its local CSS, scripts and images are inlined – then drawn by the app's hidden WebView, and
// the assistant gets a screenshot plus any JavaScript errors, so it can fix what it sees and look again.
import { canControlBrowser, VIEWS, runBrowser, closeBrowser, browserFor, captureFrame, contentBottom, pxPerCss, explainFailure, pageSoFar } from './browsercontrol.js';
import { cleanPath } from './sandbox.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' };
const dec = new TextDecoder();
const MAX_INLINE = 2 * 1024 * 1024; // per file
const MAX_TOTAL = 12 * 1024 * 1024;

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
/** Resolve a link inside the page against the page's folder, inside /workspace only. Returns null for web addresses. */
export function resolveLocal(base, href) {
  const h = String(href || '').trim();
  if (!h || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(h)) return null;
  const clean = h.split('#')[0].split('?')[0];
  const parts = (clean.startsWith('/') ? clean.slice(1) : [dirOf(base), clean].filter(Boolean).join('/')).split('/');
  const out = [];
  for (const s of parts) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return cleanPath(out.join('/'));
}
const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The page as one document: <link rel=stylesheet>, <script src>, <img src>, url(…) in CSS pointing into /workspace are inlined. */
export function inlineSite(files, path) {
  const get = (p) => files[p]?.data;
  const root = get(path);
  if (!root) throw new Error(`No such file: ${path}`);
  let total = 0;
  const notes = [];
  const dataUrl = (p) => {
    const d = get(p);
    if (!d) return null;
    if (d.length > MAX_INLINE || total + d.length > MAX_TOTAL) {
      notes.push(`${p} is too big to show`);
      return null;
    }
    total += d.length;
    return `data:${MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream'};base64,${b64(d)}`;
  };
  const cssInline = (css, from) =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
      const p = resolveLocal(from, u);
      const d = p && dataUrl(p);
      return d ? `url("${d}")` : m;
    });
  let html = dec.decode(root);
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const p = href && resolveLocal(path, href);
    if (!p) return tag;
    const d = get(p);
    if (!d) {
      notes.push(`${href} not found in the workspace`);
      return tag;
    }
    total += d.length;
    return `<style>${cssInline(dec.decode(d), p)}</style>`;
  });
  html = html.replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (m, a, src, b) => {
    const p = resolveLocal(path, src);
    if (!p) return m;
    const d = get(p);
    if (!d) {
      notes.push(`${src} not found in the workspace`);
      return m;
    }
    total += d.length;
    const attrs = `${a} ${b}`.trim();
    return `<script${attrs ? ' ' + attrs : ''}>${dec.decode(d).replace(/<\/script/gi, '<\\/script')}</script>`;
  });
  html = html.replace(/(<(?:img|source|video|audio|input)\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (m, pre, q, src) => {
    const p = resolveLocal(path, src);
    const d = p && dataUrl(p);
    if (p && !d && !get(p)) notes.push(`${src} not found in the workspace`);
    return d ? `${pre}${q}${d}${q}` : m;
  });
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, a, css) => `<style${a}>${cssInline(css, path)}</style>`);
  html = html.replace(/style\s*=\s*"([^"]*url\([^"]*)"/gi, (m, st) => `style="${cssInline(st, path).replace(/"/g, '&quot;')}"`);
  // errors the page raises are collected so the assistant can read them
  const probe = `<script>(function(){try{var g=HTMLCanvasElement.prototype.getContext;if(g.__ocmKeep)return;var f=function(t,o){if(/^(webgl2?|experimental-webgl)$/.test(String(t))){o=Object.assign({},o||{},{preserveDrawingBuffer:true})}return g.call(this,t,o)};f.__ocmKeep=1;HTMLCanvasElement.prototype.getContext=f}catch(e){}})();window.__ocmErr=[];addEventListener('error',function(e){__ocmErr.push((e.message||'error')+(e.filename?' ('+String(e.filename).split('/').pop()+':'+e.lineno+')':''))},true);addEventListener('unhandledrejection',function(e){__ocmErr.push('promise: '+(e.reason&&e.reason.message||e.reason))});var __ce=console.error;console.error=function(){__ocmErr.push('console.error: '+Array.prototype.slice.call(arguments).join(' ').slice(0,300));try{__ce.apply(console,arguments)}catch(x){}};</script>`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + probe) : probe + html;
  if (!/<meta[^>]+viewport/i.test(html)) html = html.replace(/<head[^>]*>/i, (h) => h + '<meta name="viewport" content="width=device-width, initial-scale=1">');
  return { html, notes };
}

export const previewAvailable = () => canControlBrowser();

/** A native call that never answers must not freeze the reply: give up after `ms`. */
const timed = (p, ms, what) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not respond within ${Math.round(ms / 1000)} s (the phone's WebView never answered)`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });

/** → [{ view, bytes, mime, width, height }] and the JavaScript errors seen */
export async function renderPreview(api, files, path, { views = ['mobile', 'desktop'], full = false, waitMs = 800, onStage = () => {} } = {}) {
  const { html, notes } = inlineSite(files, path);
  const shots = [];
  const errors = new Set();
  let stage = 'starting';
  const at = (st) => onStage((stage = st));
  try {
  for (const view of views) {
    const v = VIEWS[view] || VIEWS.mobile;
    at(`drawing the ${view} view`);
    await timed(api.renderHtml({ html, ...v, waitMs }), 30000, 'Drawing the page');
    await new Promise((r) => setTimeout(r, Math.min(4000, waitMs)));
    try {
      at(`reading JavaScript errors (${view})`);
      const r = await timed(api.eval({ js: 'JSON.stringify(window.__ocmErr||[])' }), 10000, 'Reading the page errors');
      let list = r.value;
      for (let i = 0; i < 2 && typeof list === 'string'; i++) list = JSON.parse(list);
      for (const e of list || []) errors.add(String(e).slice(0, 300));
    } catch {
      /* no errors list */
    }
    at(`taking the ${view} screenshot`);
    const { shot } = await timed(captureFrame(api, { full }), 30000, 'The screenshot');
    const cb = await contentBottom(api);
    shots.push({ view, bytes: Uint8Array.from(atob(shot.base64), (c) => c.charCodeAt(0)), mime: 'image/jpeg', width: shot.width, height: shot.height, contentPx: cb && cb.w ? Math.ceil(cb.b * pxPerCss(shot, cb.w)) : 0 });
  }
  } catch (e) {
    // which stage, on whose side, and what got through (the screenshots taken, the page's errors so far)
    const { side, why } = explainFailure(e?.message ?? e);
    const soFar = await pageSoFar(api, { known: [...errors] }).catch(() => '');
    throw new Error([`${stage} failed (${side}): ${why}`, shots.length ? `What got through: the ${shots.map((x) => x.view).join(' and ')} screenshot.` : '', soFar].filter(Boolean).join('\n'));
  } finally {
    await closePreview(api);
  }
  return { shots, errors: [...errors].slice(0, 10), notes };
}

/** The preview page is no longer needed: free its WebView. */
export const closePreview = async (api) => {
  try {
    await timed(Promise.resolve(api.close?.()), 5000, 'Closing the preview');
  } catch {
    /* already gone */
  }
};

/**
 * The page as a real site: opened from https://<chat>.workspace.localhost/ (the chat's /workspace, served by the native
 * browser), so its links, redirects, fetches and localStorage work, then optional browser steps (type, click …),
 * then a screenshot per view taken only after the page has painted.
 * → { shots, errors, notes, failures, steps, finalUrl, finalTitle }. A page that did not load, or a frame that stays one
 * flat colour, is a failure – never a screenshot that looks fine. Every failure says which stage, on whose side and
 * why; what got through (the address and title reached, the page's errors) is kept. `seen` is filled as it goes, so
 * a caller that gives up waiting can still say how far it got.
 * Only an open that throws (the workspace could not be served, the page could not be loaded) is thrown: the caller
 * may draw the page another way.
 */
export async function renderServed(ctx, path, { suffix = '', views = ['mobile', 'desktop'], full = false, steps = null, onStage = () => {}, seen = {} } = {}) {
  const browserId = 'preview-' + String(ctx?.convId || 'main');
  const pctx = { ...ctx, browserId, onStatus: () => {} };
  const api = browserFor(browserId);
  const shots = [];
  const errors = new Set();
  const failures = [];
  const warnings = [];
  const stepLog = [];
  let finalUrl = '';
  let finalTitle = '';
  seen.errors = errors;
  let stage = '';
  const at = (st) => onStage((seen.stage = stage = st));
  // the page's errors and where it is: read after every open, also one that failed (what got through)
  const collect = async (view) => {
    at(`reading JavaScript errors (${view})`);
    try {
      let list = (await api.eval({ js: 'JSON.stringify(window.__ocmErr||[])' })).value;
      for (let i = 0; i < 2 && typeof list === 'string'; i++) list = JSON.parse(list);
      for (const e of Array.isArray(list) ? list : []) errors.add(String(e).slice(0, 300));
    } catch {
      /* no errors list */
    }
    try {
      const st = await api.status?.();
      if (st?.url) seen.url = finalUrl = st.url;
      if (st?.title) seen.title = finalTitle = st.title;
    } catch {
      /* the address is not known */
    }
  };
  try {
    for (const view of views) {
      at(`opening the ${view} view`);
      const r = await runBrowser({ action: 'open', url: `/workspace/${path}${suffix}`, view, wait_ms: 900 }, pctx);
      if (!r.ok) {
        // the line that says what failed – not a notice line ("[Opened …]") that may come first
        const lines = String(r.result).split('\n');
        failures.push(`${view}: ${(lines.find((l) => /FAILED|Error/.test(l)) || lines.find((l) => l.trim() && !l.startsWith('[')) || lines[0]).replace(/^FAILED: /, '')}`);
        await collect(view);
        continue;
      }
      try {
        if (Array.isArray(steps) && steps.length) {
          at(`running ${steps.length} step${steps.length === 1 ? '' : 's'} (${view})`);
          const s = await runBrowser({ action: 'read', steps }, pctx);
          stepLog.push(`${view}:\n${String(s.result).slice(0, 4000)}`);
          if (!s.ok) {
            // which step, and why – not only "a step failed"
            const m = /(?:^|\n)#(\d+ [^\n]*?): FAILED – (?:Error: )?([^\n]*)/.exec(String(s.result));
            failures.push(`${view}: ${m ? `step #${m[1]} failed – ${m[2]}` : 'a step failed'} (the steps are below)`);
          }
        }
        await collect(view);
        at(`taking the ${view} screenshot`);
        const { shot, blank, message } = await captureFrame(api, { full });
        if (blank) {
          failures.push(`${view}: ${message}`);
          continue;
        }
        if (message) warnings.push(`${view}: ${message}`);
        // a page shorter than the screen: remember where its content ends, so the picture can be cut there
        const cb = await contentBottom(api);
        // exactly where the content ends (a margin below it read as part of the page)
        const contentPx = cb && cb.w ? Math.ceil(cb.b * pxPerCss(shot, cb.w)) : 0;
        shots.push({ view, bytes: Uint8Array.from(atob(shot.base64), (c) => c.charCodeAt(0)), mime: 'image/jpeg', width: shot.width, height: shot.height, contentPx });
      } catch (e) {
        // the page was open: this view failed at one stage, the others still get their turn
        const { side, why } = explainFailure(e?.message ?? e, { site: true });
        failures.push(`${view}: ${stage} failed (${side}): ${why.split('\n')[0]}`);
        if (!/^reading JavaScript errors/.test(stage)) await collect(view).catch(() => {});
      }
    }
  } finally {
    await closeBrowser(browserId);
  }
  return { shots, errors: [...errors].slice(0, 10), notes: warnings, failures, steps: stepLog, finalUrl, finalTitle };
}
