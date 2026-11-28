// Markdown → sanitized HTML with code boxes (language label, copy, syntax
// highlighting) and a "Preview" button for HTML/SVG code.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { isRichHtml, scopeCss } from './richhtml.js';

marked.setOptions({ gfm: true, breaks: true });

// ---------- math: $…$, $$…$$, \(…\), \[…\] → placeholders rendered later by KaTeX ----------
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const mathEl = (tex, block) => `<${block ? 'div' : 'span'} class="math${block ? ' math-block' : ''}" data-tex="${escAttr(tex)}">${escAttr(tex)}</${block ? 'div' : 'span'}>`;
const MATH_ENVS = 'align|aligned|equation|gather|gathered|multline|alignat|cases|matrix|pmatrix|bmatrix|split';
marked.use({
  extensions: [
    {
      name: 'mathBlock',
      level: 'block',
      start(src) {
        let i = src.search(/\$\$|\\\[/);
        // \begin{…} only at the start of a line: inside a $…$ formula it stays part of that formula
        const b = /(?:^|\n)[ \t]*(\\begin\{)/.exec(src);
        const at = b ? b.index + b[0].length - b[1].length : -1;
        if (at >= 0 && (i < 0 || at < i)) i = at;
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src) || /^\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
        // a bare \begin{align}…\end{align} (no $$ around it) is display maths too (decision 275)
        const env = new RegExp(`^[ \\t]{0,3}\\\\begin\\{(${MATH_ENVS})(\\*?)\\}[\\s\\S]+?\\\\end\\{\\1\\2\\}[ \\t]*(?:\\n|$)`).exec(src);
        if (env) return { type: 'mathBlock', raw: env[0], text: env[0].trim() };
      },
      renderer: (t) => mathEl(t.text, true),
    },
    {
      name: 'mathInline',
      level: 'inline',
      start(src) {
        // a $ right after a letter or digit ("200$") is a price, not the start of a formula
        const i = src.search(/(?<![\p{L}\p{N}\\])\$|\\\(/u);
        return i < 0 ? undefined : i;
      },
      tokenizer(src, tokens) {
        const before = String(tokens?.at(-1)?.raw || '').slice(-1);
        let m = /^\$\$([^$]+?)\$\$/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: true };
        m = /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim() };
        // $x$ – but not prices like "$5 and $10": no space inside the delimiters, no digit right after
        // …nor "200$. Now I want … 100$": a $ right after a letter or digit opens nothing, and words in a row with no
        // maths in them (\, ^, _, =, +, braces) are a sentence between two prices
        if (/[\p{L}\p{N}]/u.test(before)) return undefined;
        m = /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?![\d\w])/.exec(src);
        const prose = (t) => /[\p{L}]{2,}\s+[\p{L}]{2,}\s+[\p{L}]{2,}\s+[\p{L}]{2,}/u.test(t) && !/[\\^_=+{}]/.test(t);
        if (m && !/^\d+([.,]\d+)?$/.test(m[1]) && !prose(m[1])) return { type: 'mathInline', raw: m[0], text: m[1] };
      },
      renderer: (t) => mathEl(t.text, t.display),
    },
  ],
});

// ---------- what marked would take for HTML but is not (decision 275) ----------
// `vector<int>`, `#include <iostream>`, `<T>`, `HashMap<String, List<Integer>>` outside code were parsed by marked as
// HTML tags, and DOMPurify then removed them – the reply lost them. Before marked, a `<name…>` outside code spans,
// fences and formulas is escaped when name is not an HTML (or SVG/MathML) tag DOMPurify keeps; a real tag right
// after a word (`List<b>`) is escaped too unless its closing tag follows. Real HTML (<details>, <br>, <kbd>…) works,
// and so does a made-up tag that is opened and closed (<scene>…</scene>: its text shows, as before).
const HTML_TAGS = new Set(
  ('a abbr acronym address area article aside audio b bdi bdo big blink blockquote body br button canvas caption center cite code col colgroup ' +
    'content data datalist dd decorator del details dfn dialog dir div dl dt element em fieldset figcaption figure font footer form h1 h2 h3 h4 h5 h6 ' +
    'head header hgroup hr html i img input ins kbd label legend li main map mark marquee menu menuitem meter nav nobr ol optgroup option output p ' +
    'picture pre progress q rp rt ruby s samp section select shadow small source spacer span strike strong style sub summary sup table tbody td ' +
    'template textarea tfoot th thead time tr track tt u ul var video wbr svg g path circle rect line polyline polygon ellipse text tspan defs ' +
    'lineargradient radialgradient stop use symbol clippath mask pattern filter image title desc math mi mn mo ms mrow msup msub mfrac msqrt semantics ' +
    'annotation script iframe object embed link meta base noscript frame frameset')
    .split(' '),
);
const TAG_RX = /<(\/?)([A-Za-z][\w-]*)(?=[\s/>,])/g;
function escapeTagsIn(seg, whole) {
  return seg.replace(TAG_RX, (m, close, name, at, str) => {
    const n = name.toLowerCase();
    // an unknown tag that is opened and closed (<scene>…</scene>) is left to DOMPurify as before: its text stays, the tags go
    if (!HTML_TAGS.has(n)) return new RegExp(`</${n}\\s*>`, 'i').test(whole) && new RegExp(`<${n}[\\s>]`, 'i').test(whole) ? m : '&lt;' + close + name;
    if (!close && /[\w$]/.test(str[at - 1] || '') && !new RegExp(`</${n}\\s*>`, 'i').test(whole)) return '&lt;' + name;
    return m;
  });
}
/** Escape stray `<word>` outside code (fenced, indented, `spans`) and maths, so marked leaves them as text. */
export function escapeStrayTags(text) {
  const src = String(text || '');
  if (!src.includes('<')) return src;
  const lines = src.split('\n');
  let fence = null;
  const out = [];
  let prose = [];
  const flush = () => {
    if (!prose.length) return;
    const block = prose.join('\n');
    // code spans and formulas are kept as they are
    out.push(block.replace(/(`+)[\s\S]*?[^`]\1(?!`)|`[^`]`|\$\$[\s\S]*?\$\$|(?<![\p{L}\p{N}\\])\$[^$\n]+\$|\\\([\s\S]*?\\\)|([^`$\\]+|[`$\\])/gu, (m, _t, plain) => (plain ? escapeTagsIn(plain, src) : m)));
    prose = [];
  };
  for (const l of lines) {
    const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) {
      out.push(l);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.trim().slice(f[1].length).trim()) fence = null;
      continue;
    }
    if (f) {
      flush();
      fence = f[1];
      out.push(l);
      continue;
    }
    // indented code (4 spaces or a tab, not a nested list item) stays as written
    if (/^( {4,}|\t)/.test(l) && !/^\s+([-*+]|\d+[.)])\s/.test(l) && (!prose.length || !prose.at(-1).trim())) {
      flush();
      out.push(l);
      continue;
    }
    prose.push(l);
  }
  flush();
  return out.join('\n');
}

/**
 * A `|` inside $…$ in a table row split the cell: `| $P(a|b)$ | x |` had three cells. It is written `\|` there,
 * which the table takes as a literal bar and gives back to the formula as `|` (decision 275).
 */
export function protectTableMath(text) {
  const src = String(text || '');
  if (!src.includes('|') || !src.includes('$')) return src;
  let fence = null;
  return src
    .split('\n')
    .map((l) => {
      const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(l);
      if (fence) {
        if (f && f[1][0] === fence[0]) fence = null;
        return l;
      }
      if (f) {
        fence = f[1];
        return l;
      }
      if (!/^\s*\|.*\|\s*$/.test(l)) return l;
      return l.replace(/(`+)[\s\S]*?\1|\$\$[^$]+\$\$|(?<![\p{L}\p{N}\\])\$[^$\n]+\$/gu, (m, tick) => (tick ? m : m.replace(/(?<!\\)\|/g, '\\|')));
    })
    .join('\n');
}

/** Markdown → HTML before sanitizing (what renderMarkdown gives DOMPurify). */
export function markdownHtml(text) {
  return marked.parse(protectTableMath(escapeStrayTags(text || '')));
}

const ALIASES = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown', html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', jsonc: 'json', kt: 'kotlin', rs: 'rust', rb: 'ruby', cs: 'csharp', 'c++': 'cpp' };

export function isPreviewable(lang, code) {
  const l = (lang || '').toLowerCase();
  if (l === 'html' || l === 'htm' || l === 'svg') return true;
  if (!l || l === 'xml') return /^\s*(<!doctype html|<html[\s>]|<svg[\s>])/i.test(code);
  return false;
}

// Injected into previews: stop form submits and link clicks from navigating the
// frame (they would load the app itself inside the preview). Page JS still runs;
// external links are handed to the app to open in the system browser.
const PREVIEW_GUARD = `<script>(function(){
addEventListener('submit',function(e){e.preventDefault();},false);
addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href')||'';
if(h.charAt(0)==='#'){e.preventDefault();var t=h.length>1&&document.getElementById(decodeURIComponent(h.slice(1)));if(t)t.scrollIntoView({behavior:'smooth'});return;}
if(/^javascript:/i.test(h))return;e.preventDefault();if(/^(https?:|mailto:|tel:)/i.test(h))parent.postMessage({ocmOpen:a.href},'*');},false);
window.open=function(u){if(u&&/^(https?:|mailto:|tel:)/i.test(String(u)))parent.postMessage({ocmOpen:String(u)},'*');return null;};
})();<\/script>`;

function withGuard(doc) {
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => m + PREVIEW_GUARD);
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html[^>]*>/i, (m) => m + '<head>' + PREVIEW_GUARD + '</head>');
  return PREVIEW_GUARD + doc;
}

/** Turn previewable code into a full HTML document for the sandboxed iframe. */
export function previewDoc(lang, code) {
  return withGuard(previewDocRaw(lang, code));
}

function previewDocRaw(lang, code) {
  if (/^\s*<svg[\s>]/i.test(code) || (lang || '').toLowerCase() === 'svg')
    return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100%}</style>${code}`;
  if (/<html[\s>]|<!doctype/i.test(code)) {
    // add a mobile viewport if the page doesn't have one
    return /name=["']?viewport/i.test(code) ? code : code.replace(/<head[^>]*>/i, (m) => `${m}<meta name="viewport" content="width=device-width,initial-scale=1">`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${code}</body></html>`;
}

function highlight(codeEl, lang, allowAuto) {
  const text = codeEl.textContent;
  const name = ALIASES[lang] || lang;
  try {
    if (name && hljs.getLanguage(name)) {
      codeEl.innerHTML = hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
      codeEl.classList.add('hljs');
      return name;
    }
    if (!lang && allowAuto && text.length < 6000) {
      const r = hljs.highlightAuto(text);
      if (r.relevance >= 5) {
        codeEl.innerHTML = r.value;
        codeEl.classList.add('hljs');
        return r.language;
      }
    }
  } catch {
    /* leave plain */
  }
  return '';
}

// ---------- HTML-styled text (character cards often have a designed description / greeting) ----------
const RISKY_STYLE = /position\s*:\s*(fixed|sticky)|expression\s*\(|behavior\s*:|-moz-binding|url\(\s*['"]?(?!data:image\/)/i;
DOMPurify.addHook?.('afterSanitizeAttributes', (node) => {
  const st = node.getAttribute?.('style');
  if (st && RISKY_STYLE.test(st)) node.setAttribute('style', st.split(';').filter((d) => !RISKY_STYLE.test(d)).join(';'));
});

let richN = 0;
function richHtml(text) {
  const id = 'rich' + ++richN;
  const css = [];
  const body = String(text).replace(/<style\b[^>]*>([\s\S]*?)(?:<\/style>|$)/gi, (_, c) => (css.push(c), ''));
  const clean = DOMPurify.sanitize(body, { FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'style'], ADD_ATTR: ['align', 'valign', 'color', 'face', 'size', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'width', 'height'] });
  const style = css.length ? `<style>${scopeCss(css.join('\n'), `[data-rich="${id}"]`).replace(/</g, '\\3c ')}</style>` : '';
  return `<div class="rich-html" data-rich="${id}">${style}${clean}</div>`;
}

const LANG_LABEL = { xml: 'html', javascript: 'js', typescript: 'ts', python: 'python', bash: 'bash', plaintext: 'text' };

/**
 * opts.highlight: syntax highlighting on/off
 * opts.streaming: true while the reply is still arriving (skips expensive auto-detect)
 * opts.collapseLines: collapse code boxes longer than this many lines (0 = never)
 * opts.wrap: wrap long lines in code boxes by default
 */
export function renderMarkdown(text, opts = {}) {
  const html = isRichHtml(text) ? richHtml(text) : DOMPurify.sanitize(markdownHtml(text));
  const div = document.createElement('div');
  div.innerHTML = html;
  // the code box still being written is left uncoloured until its closing ``` arrives: colouring it again on every
  // frame was a large part of a streaming redraw (decision 239)
  const pres = div.querySelectorAll('pre');
  const open = opts.streaming && ((text || '').match(/^\s*(```|~~~)/gm) || []).length % 2 === 1 ? pres[pres.length - 1] : null;
  pres.forEach((pre) => {
    const code = pre.querySelector('code') || pre;
    const lang = ((code.className.match(/language-([\w+#-]+)/) || [])[1] || '').toLowerCase();
    const raw = code.textContent;
    let shown = lang;
    if (opts.highlight !== false && pre !== open) {
      const detected = highlight(code, lang, !opts.streaming);
      if (!shown && detected) shown = LANG_LABEL[detected] || detected;
    }
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    const bar = document.createElement('div');
    bar.className = 'code-bar';
    const label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = shown || 'code';
    bar.append(label);
    const btns = document.createElement('span');
    btns.className = 'code-btns';
    const lines = raw.replace(/\n$/, '').split('\n').length;
    if (lang === 'mermaid' || lang === 'map') {
      // drawn as a diagram (or a map) by hydrateRich() once the reply is complete
      const tb = document.createElement('button');
      tb.className = 'code-btn';
      tb.dataset.diagramToggle = '1';
      tb.textContent = '</> Code';
      btns.append(tb);
    }
    const wb = document.createElement('button');
    wb.className = 'code-btn';
    wb.dataset.wrap = '1';
    wb.textContent = opts.wrap ? '⇥ No wrap' : '↩ Wrap';
    btns.append(wb);
    if (isPreviewable(lang, raw)) {
      const pv = document.createElement('button');
      pv.className = 'code-btn preview';
      pv.dataset.preview = lang || 'html';
      pv.textContent = '▶ Preview';
      btns.append(pv);
    }
    const cp = document.createElement('button');
    cp.className = 'code-btn';
    cp.dataset.copy = '1';
    cp.textContent = 'Copy';
    btns.append(cp);
    bar.append(btns);
    pre.replaceWith(wrap);
    wrap.append(bar, pre);
    if (lang === 'mermaid') wrap.dataset.mermaid = '1';
    if (lang === 'map') wrap.dataset.map = '1';
    if (opts.wrap) wrap.classList.add('wrapped');
    const limit = opts.collapseLines || 0;
    if (limit && lines > limit + 3) {
      wrap.classList.add('collapsible');
      wrap.style.setProperty('--collapse-lines', limit);
      const more = document.createElement('button');
      more.className = 'code-more';
      more.dataset.expand = '1';
      more.dataset.lines = lines;
      more.textContent = `Show all ${lines} lines ▾`;
      wrap.append(more);
    }
  });
  div.querySelectorAll('a').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  if (opts.rp) colorDialogue(div);
  return div.innerHTML;
}

// Roleplay: wrap "dialogue" in <span class="rp-q"> (actions are *italics* → <em>, styled by CSS). A quote is found
// across the whole paragraph, not one text node at a time: "I *told* you" has an <em> in the middle, and was left
// uncoloured (white) – each piece of it is wrapped now, the emphasis keeps its italics in the dialogue colour.
const QUOTE_RX = /("[^"\n]{1,1200}"|“[^”\n]{1,1200}”|«[^»\n]{1,1200}»)/g;
const BLOCK = 'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, div';
function colorDialogue(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('pre, code, .code-wrap, .math, a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  // the text nodes of each paragraph, in order
  const groups = new Map();
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const block = n.parentElement.closest(BLOCK) || root;
    if (!groups.has(block)) groups.set(block, []);
    groups.get(block).push(n);
  }
  for (const nodes of groups.values()) {
    const text = nodes.map((n) => n.nodeValue).join('');
    if (!/["“«]/.test(text)) continue;
    const ranges = [...text.matchAll(QUOTE_RX)].map((m) => [m.index, m.index + m[0].length]);
    if (!ranges.length) continue;
    let at = 0;
    for (const n of nodes) {
      const start = at;
      const end = at + n.nodeValue.length;
      at = end;
      const cuts = ranges.filter(([a, b]) => a < end && b > start).map(([a, b]) => [Math.max(a, start) - start, Math.min(b, end) - start]);
      if (!cuts.length) continue;
      const v = n.nodeValue;
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const [a, b] of cuts) {
        if (a > pos) frag.append(document.createTextNode(v.slice(pos, a)));
        const sp = document.createElement('span');
        sp.className = 'rp-q';
        sp.textContent = v.slice(a, b);
        frag.append(sp);
        pos = b;
      }
      if (pos < v.length) frag.append(document.createTextNode(v.slice(pos)));
      n.replaceWith(frag);
    }
  }
}

const ERROR_LINE =
  /^\s*(\S+\.\w+:\d+(:\d+)?:\s*(fatal )?(error|warning)\b|Traceback \(most recent call last\)|Exception in thread "|error(\[E\d+\])?: |error TS\d+:|\S+\.\w+\(\d+,\d+\): error|[A-Z][A-Za-z]*(Error|Exception): |at [\w$.<>]+\([\w$.]*:\d+(:\d+)?\)\s*$|Segmentation fault|thread '[^']*' panicked at )/;

/** Heuristic: does unfenced user text look like a code paste? */
export function looksLikeCode(text) {
  if (!text || text.includes('```')) return false;
  const lines = text.split('\n').filter((l) => l.trim());
  // a pasted compiler or runtime error is fenced even when it is one or two lines (decision 275)
  if (lines.some((l) => ERROR_LINE.test(l))) return true;
  if (lines.length < 3) return false;
  let score = 0;
  for (const l of lines) {
    if (/[;{}]\s*$|^\s*[}\])]|=>|^\s*(\/\/|#include|import |from \S+ import|def |class |function |const |let |var |public |private |return |if \(|for \(|<\/?[a-z][\w-]*[\s>])/.test(l)) score++;
    else if (/^\s{2,}\S/.test(l)) score += 0.5;
  }
  return score / lines.length >= 0.5;
}

/** User messages: render Markdown, auto-wrapping pasted code in a code box. */
export function renderUserText(text, opts) {
  if (looksLikeCode(text)) return renderMarkdown('```\n' + text + '\n```', opts);
  return renderMarkdown(text, opts);
}


// ---------- lazy rendering of math (KaTeX) and diagrams (Mermaid) ----------
let katexP, mermaidP;
const svgCache = new Map();
let mermaidN = 0;
const darkMode = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t !== 'light' : matchMedia('(prefers-color-scheme: dark)').matches;
};

/** Other fenced blocks the app draws itself: richBlocks.map(wrap, text) is set by app/map-ui.js (it needs the chat's files). */
export const richBlocks = {};

export async function hydrateRich(root) {
  if (richBlocks.map) {
    for (const w of root.querySelectorAll('.code-wrap[data-map]:not([data-done])')) {
      if (w.closest('.streaming-msg')) continue;
      w.dataset.done = '1';
      // never in the way of the message itself: a map that fails leaves its code box and a note
      Promise.resolve()
        .then(() => richBlocks.map(w, w.querySelector('pre')?.textContent || ''))
        .catch((e) => console.warn('map block failed', e));
    }
  }
  const maths = root.querySelectorAll('.math:not([data-done])');
  if (maths.length) {
    katexP ||= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([k]) => k.default);
    const katex = await katexP;
    for (const m of maths) {
      if (m.dataset.done) continue;
      m.dataset.done = '1';
      try {
        m.innerHTML = katex.renderToString(m.dataset.tex, { displayMode: m.classList.contains('math-block'), throwOnError: false, strict: 'ignore' });
      } catch {
        /* leave the TeX source */
      }
    }
  }
  const diagrams = [...root.querySelectorAll('.code-wrap[data-mermaid]:not([data-done])')].filter((w) => !w.closest('.streaming-msg'));
  if (diagrams.length) {
    mermaidP ||= import('mermaid').then((m) => m.default);
    const mermaid = await mermaidP;
    const theme = darkMode() ? 'dark' : 'default';
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif', flowchart: { useMaxWidth: true } });
    for (const w of diagrams) {
      if (w.dataset.done) continue;
      w.dataset.done = '1';
      const code = w.querySelector('pre').textContent;
      const key = theme + '\n' + code;
      try {
        let svg = svgCache.get(key);
        if (!svg) {
          svg = (await mermaid.render('mmd' + ++mermaidN, code)).svg;
          svgCache.set(key, svg);
        }
        const d = document.createElement('div');
        d.className = 'mermaid-diagram';
        d.innerHTML = svg;
        w.insertBefore(d, w.querySelector('pre'));
        w.classList.add('diagram');
      } catch (e) {
        const n = document.createElement('div');
        n.className = 'mermaid-error';
        n.textContent = 'Could not draw this diagram: ' + String(e.message || e).split('\n')[0].slice(0, 160);
        w.append(n);
        document.querySelectorAll('[id^="dmmd"]').forEach((x) => x.remove()); // mermaid leaves error nodes behind
      }
    }
  }
}
