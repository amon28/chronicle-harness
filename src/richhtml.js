// Pure helpers for HTML-styled text (character-card descriptions and greetings): detection and CSS scoping.

/** Text that is really a designed HTML page (divs, tables, <style>…), not Markdown with the odd tag. */
export function isRichHtml(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  // markdown that only MENTIONS a tag – `<style>` in inline code, an html example in a fence – is markdown:
  // treating it as html collapsed the reply into one paragraph and the style block swallowed the rest of it
  const bare = s
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[\s\S]*?(\n[ \t]*\2[`~]*[ \t]*(?=\n|$)|$)/g, '$1')
    .replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, '');
  if (/<style\b[^>]*>[\s\S]*?<\/style>/i.test(bare)) return true;
  return /^<[a-z]/i.test(bare.trim()) && /<(div|table|center|section|article|font|h[1-6]|p)\b[^>]*>/i.test(bare);
}

/** Remove @media/@keyframes/@font-face/@supports blocks (brace-aware) – only plain rules are kept. */
function stripAtBlocks(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@', i);
    if (at < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth) depth += css[j] === '{' ? 1 : css[j] === '}' ? -1 : 0, j++;
    i = j;
  }
  return out;
}
/** A card's <style> block, limited to the card's own text: selectors are prefixed with its wrapper, nothing external. */
export function scopeCss(css, scope) {
  let c = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  c = stripAtBlocks(c);
  c = c.replace(/url\(\s*(['"]?)(?!data:image\/)[^)]*\)/gi, 'none').replace(/expression\s*\([^)]*\)|behavior\s*:[^;}]*|-moz-binding\s*:[^;}]*/gi, '');
  c = c.replace(/position\s*:\s*(fixed|sticky)/gi, 'position:relative');
  return c.replace(/(^|\})\s*([^{}]+)\{/g, (m, a, sel) => `${a}${sel.split(',').map((s) => `${scope} ${s.trim().replace(/^(html|body|:root)\b\s*/i, '')}`.trim()).join(',')}{`);
}
