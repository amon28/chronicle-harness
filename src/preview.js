// Turn a workspace file into something a phone can show: pages render (with their own css/js/images),
// markdown/json/csv are formatted, Python and JavaScript run and show their output.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const BASE_CSS = 'body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:16px;color:#1c1c1e;background:#fff}pre{white-space:pre-wrap;word-break:break-word;background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto}img{max-width:100%}table{border-collapse:collapse;font-size:14px}td,th{border:1px solid #d4d4d8;padding:4px 8px;text-align:left}th{background:#f4f4f5}code{background:#f4f4f5;padding:1px 4px;border-radius:4px}blockquote{margin:0;padding-left:12px;border-left:3px solid #d4d4d8;color:#52525b}';
const shell = (body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}${extra}</style></head><body>${body}</body></html>`;

const ext = (p) => (p.split('.').pop() || '').toLowerCase();
export const KINDS = { html: 'html', htm: 'html', svg: 'svg', md: 'md', markdown: 'md', json: 'json', csv: 'csv', tsv: 'csv', py: 'py', js: 'js', mjs: 'js' };
export const previewKind = (path) => KINDS[ext(path)] || '';
export const previewLabel = (kind) => (kind === 'py' || kind === 'js' ? '▶ Run' : '▶ Preview');

export function resolvePath(from, rel) {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  try {
    return decodeURIComponent(new URL(rel, 'http://x/' + dir).pathname.slice(1));
  } catch {
    return '';
  }
}
const isLocal = (u) => u && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);

/** Pull the page's own css/js/images out of the workspace so a saved site works offline in the preview. */
export function inlineAssets(html, path, files, toDataUrl, textOf) {
  const get = (rel, from = path) => files[resolvePath(from, rel.split(/[?#]/)[0])]?.data;
  const cssUrls = (css, from) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
    const d = isLocal(u) && get(u, from);
    return d ? `url(${toDataUrl(resolvePath(from, u.split(/[?#]/)[0]), d)})` : m;
  });
  let out = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel=["']?stylesheet/i.test(tag)) return tag;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    const d = isLocal(href) && get(href);
    return d ? `<style>${cssUrls(textOf(d), resolvePath(path, href.split(/[?#]/)[0]))}</style>` : tag;
  });
  out = out.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (m, a, src, b) => {
    const d = isLocal(src) && get(src);
    return d ? `<script${a}${b}>${textOf(d).replace(/<\/script/gi, '<\\/script')}</script>` : m;
  });
  out = out.replace(/\b(src|poster)=["']([^"']+)["']/gi, (m, attr, u) => {
    const d = isLocal(u) && get(u);
    return d ? `${attr}="${toDataUrl(resolvePath(path, u.split(/[?#]/)[0]), d)}"` : m;
  });
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => m.replace(css, cssUrls(css, path)));
  return out;
}

function csvDoc(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) (row.push(cell), (cell = ''));
    else if (c === '\n') (row.push(cell), rows.push(row), (row = []), (cell = ''));
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  const cut = rows.slice(0, 500);
  const [head, ...body] = cut;
  const tr = (r, t) => `<tr>${r.map((x) => `<${t}>${esc(x)}</${t}>`).join('')}</tr>`;
  return shell(`<div style="overflow:auto"><table>${head ? tr(head, 'th') : ''}${body.map((r) => tr(r, 'td')).join('')}</table></div>${rows.length > 500 ? `<p>… showing the first 500 of ${rows.length} rows</p>` : ''}`);
}

/**
 * Build the HTML document to show for a file. ctx = { files, toDataUrl, textOf, markdown(text), runPython(code) }
 */
export async function buildPreview(path, bytes, ctx) {
  const kind = previewKind(path);
  const text = ctx.textOf(bytes);
  switch (kind) {
    case 'html':
      return inlineAssets(text, path, ctx.files || {}, ctx.toDataUrl, ctx.textOf);
    case 'svg':
      return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100%}</style>${text}`;
    case 'md':
      return shell(ctx.markdown(text));
    case 'json':
      try {
        return shell(`<pre>${esc(JSON.stringify(JSON.parse(text), null, 2))}</pre>`);
      } catch (e) {
        return shell(`<p>Not valid JSON: ${esc(e.message)}</p><pre>${esc(text.slice(0, 20000))}</pre>`);
      }
    case 'csv':
      return csvDoc(text, ext(path) === 'tsv' ? '\t' : ',');
    case 'js':
      return shell(
        `<pre id="o"></pre><script>const o=document.getElementById('o');const w=(...a)=>{o.textContent+=a.map((x)=>typeof x==='object'?JSON.stringify(x,null,1):String(x)).join(' ')+'\\n'};console.log=console.info=console.warn=console.error=w;addEventListener('error',(e)=>w('Error: '+e.message));</script><script>${text.replace(/<\/script/gi, '<\\/script')}</script>`
      );
    case 'py': {
      const r = await ctx.runPython(text);
      const parts = [];
      if (r.stdout) parts.push(esc(r.stdout));
      if (r.value) parts.push(esc(`[result] ${r.value}`));
      if (r.stderr) parts.push(`<span style="color:#b45309">${esc(r.stderr)}</span>`);
      if (r.error) parts.push(`<span style="color:#b91c1c">${esc(r.error)}</span>`);
      const files = (r.changed || []).map((c) => c.path);
      return shell(`<pre>${parts.join('\n') || '(no output)'}</pre>${files.length ? `<p>Files written: ${files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>` : ''}`);
    }
    default:
      return shell(`<pre>${esc(text.slice(0, 60000))}</pre>`);
  }
}
