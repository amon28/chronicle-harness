import { describe, it, expect } from 'vitest';
import { isRichHtml, scopeCss } from '../../src/richhtml.js';

describe('HTML-styled text', () => {
  it('detects designed HTML but not Markdown with a stray tag', () => {
    expect(isRichHtml('<div style="color:red"><h1>Vega</h1></div>')).toBe(true);
    expect(isRichHtml('<style>.a{color:red}</style>*hello*')).toBe(true);
    expect(isRichHtml('She *smiles* and says <b>hi</b>.')).toBe(false);
    expect(isRichHtml('')).toBe(false);
    // a report that mentions `<style>` in inline code or shows html in a fence is markdown, not html
    expect(isRichHtml('| inline `<style>` blank | captured |\n|---|---|')).toBe(false);
    expect(isRichHtml('````markdown\n# Report\n| inline `<style>` | x |\n````')).toBe(false);
    expect(isRichHtml('Here:\n```html\n<style>a{}</style><div>x</div>\n```\nDone.')).toBe(false);
    expect(isRichHtml('<div><h1>x</h1></div>\n<style>h1{color:red}</style>')).toBe(true);
    expect(isRichHtml('<style>.a{color:red}</style><div class="a">hi</div>')).toBe(true);
  });
  it('scopes a card stylesheet to its own wrapper and drops anything external or page-wide', () => {
    const css = '@import url(https://evil.test/x.css); body { background: red; } .box, h1 { color: blue; position: fixed; background: url(https://evil.test/a.png) } @media (max-width: 600px) { .box { color: green } } .x { color: pink }';
    const out = scopeCss(css, '[data-rich="r1"]');
    expect(out).not.toContain('@import');
    expect(out).not.toContain('evil.test');
    expect(out).not.toContain('@media');
    expect(out).not.toContain('fixed');
    expect(out).toContain('[data-rich="r1"] .box');
    expect(out).toContain('[data-rich="r1"] h1');
    expect(out).toContain('[data-rich="r1"] .x{ color: pink }');
    expect(out).not.toMatch(/(^|\})\s*body/); // "body" is not allowed to restyle the page
  });
});
