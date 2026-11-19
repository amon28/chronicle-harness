import { describe, it, expect } from 'vitest';
import { inlineSite, resolveLocal } from '../../src/previewpage.js';

const enc = (s) => new TextEncoder().encode(s);
const f = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { data: typeof v === 'string' ? enc(v) : v }]));

describe('preview_page: making the page self-contained', () => {
  it('resolves links against the page folder and never leaves the workspace', () => {
    expect(resolveLocal('site/index.html', 'style.css')).toBe('site/style.css');
    expect(resolveLocal('site/index.html', './img/a.png?v=2')).toBe('site/img/a.png');
    expect(resolveLocal('site/index.html', '../shared/x.js')).toBe('shared/x.js');
    expect(resolveLocal('site/index.html', '/root.css')).toBe('root.css');
    expect(resolveLocal('index.html', '../../../etc/passwd')).toBe('etc/passwd'); // clamped inside
    expect(resolveLocal('index.html', 'https://cdn.example.com/a.js')).toBeNull();
    expect(resolveLocal('index.html', '//cdn.example.com/a.js')).toBeNull();
    expect(resolveLocal('index.html', 'data:image/png;base64,AAAA')).toBeNull();
  });
  it('inlines local css, scripts and images, keeps web links, and reports what is missing', () => {
    const files = f({
      'site/index.html': '<html><head><link rel="stylesheet" href="s.css"><link rel="stylesheet" href="https://fonts.example/x.css"><link rel="stylesheet" href="gone.css"></head><body><img src="logo.png"><img src="nope.png"><script src="a.js"></script></body></html>',
      'site/s.css': 'body { background: url(bg.png) }',
      'site/bg.png': new Uint8Array([1, 2, 3]),
      'site/logo.png': new Uint8Array([4, 5]),
      'site/a.js': 'var x = 1;',
    });
    const { html, notes } = inlineSite(files, 'site/index.html');
    expect(html).toContain('<style>body { background: url("data:image/png;base64,AQID") }</style>');
    expect(html).toContain('href="https://fonts.example/x.css"');
    expect(html).toContain('src="data:image/png;base64,BAU="');
    expect(html).toContain('<script>var x = 1;</script>');
    expect(html).toContain('__ocmErr'); // the error probe
    expect(notes).toEqual(expect.arrayContaining(['gone.css not found in the workspace', 'nope.png not found in the workspace']));
  });
  it('fails clearly when the file is missing', () => {
    expect(() => inlineSite({}, 'index.html')).toThrow('No such file');
  });
});
