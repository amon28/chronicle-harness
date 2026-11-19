import { describe, it, expect } from 'vitest';
import { buildPreview, inlineAssets, previewKind, resolvePath } from '../../src/preview.js';

const enc = new TextEncoder();
const ctx = (files = {}, extra = {}) => ({
  files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { data: typeof v === 'string' ? enc.encode(v) : v }])),
  textOf: (b) => new TextDecoder().decode(b),
  toDataUrl: (p, d) => `data:x/${p};len=${d.length}`,
  markdown: (t) => `<h1>${t}</h1>`,
  runPython: async () => ({ stdout: 'hi\n', changed: [{ path: 'out.txt' }] }),
  ...extra,
});

describe('preview', () => {
  it('knows which files can be previewed', () => {
    expect(previewKind('a/b.HTML')).toBe('html');
    expect(previewKind('x.py')).toBe('py');
    expect(previewKind('x.bin')).toBe('');
  });
  it('resolves relative paths', () => {
    expect(resolvePath('site/index.html', 'css/a.css')).toBe('site/css/a.css');
    expect(resolvePath('site/index.html', '../x.js')).toBe('x.js');
  });
  it('inlines a page’s own css, js and images from the workspace', async () => {
    const files = { 'site/style.css': 'body{background:url(bg.png)}', 'site/app.js': 'alert(1)', 'site/bg.png': new Uint8Array(3), 'site/hero.jpg': new Uint8Array(5) };
    const html = '<link rel="stylesheet" href="style.css"><img src="hero.jpg"><script src="app.js"></script><script src="https://cdn/x.js"></script>';
    const out = await buildPreview('site/index.html', enc.encode(html), ctx(files));
    expect(out).toContain('<style>body{background:url(data:x/site/bg.png;len=3)}</style>');
    expect(out).toContain('src="data:x/site/hero.jpg;len=5"');
    expect(out).toContain('<script >alert(1)</script>');
    expect(out).toContain('https://cdn/x.js');
    expect(inlineAssets('<img src="missing.png">', 'a.html', {}, () => '', () => '')).toBe('<img src="missing.png">');
  });
  it('formats markdown, json and csv', async () => {
    expect(await buildPreview('a.md', enc.encode('hello'), ctx())).toContain('<h1>hello</h1>');
    expect(await buildPreview('a.json', enc.encode('{"a":1}'), ctx())).toContain('&quot;a&quot;: 1');
    const csv = await buildPreview('a.csv', enc.encode('n,v\n"x, y",2\n'), ctx());
    expect(csv).toContain('<th>n</th>');
    expect(csv).toContain('<td>x, y</td>');
  });
  it('runs python and javascript and shows the output', async () => {
    const py = await buildPreview('a.py', enc.encode('print("hi")'), ctx());
    expect(py).toContain('hi');
    expect(py).toContain('out.txt');
    const js = await buildPreview('a.js', enc.encode('console.log(1)'), ctx());
    expect(js).toContain('console.log(1)');
  });
});
