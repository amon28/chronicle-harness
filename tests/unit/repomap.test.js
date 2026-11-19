import { describe, it, expect } from 'vitest';
import { repoMap } from '../../src/repomap.js';

describe('repo_map', () => {
  const files = {
    'src/app.js': 'import x from "y";\nexport function start(a) {\n  return a;\n}\nexport class Store {\n  get(key) {\n    return 1;\n  }\n}\nconst helper = (n) => n + 1;\n',
    'tool.py': 'import os\n\nclass Runner:\n    def run(self):\n        pass\n\ndef main():\n    pass\n',
    'node_modules/x/index.js': 'function hidden() {}',
    'logo.png': null,
    'README.md': '# Title\nsome text\n## Usage\n',
  };
  it('lists definitions with line numbers and skips vendored files', () => {
    const r = repoMap(Object.keys(files), (p) => files[p]);
    expect(r.text).toContain('src/app.js (11 lines)');
    expect(r.text).toMatch(/2│ export function start\(a\)/);
    expect(r.text).toMatch(/5│ export class Store/);
    expect(r.text).toMatch(/6│ get\(key\)/);
    expect(r.text).toMatch(/10│ const helper = \(n\) => n \+ 1;/);
    expect(r.text).toMatch(/3│ class Runner:/);
    expect(r.text).toMatch(/4│ def run\(self\):/);
    expect(r.text).toContain('## Usage');
    expect(r.text).not.toContain('hidden');
    expect(r.files).toBe(3);
  });
});

import { repoMap as rm2 } from '../../src/repomap.js';
describe('repo_map honesty', () => {
  it('does not list strings inside an HTML script, cuts a docstring off a Python signature, and says it is not a parser', () => {
    const files = {
      'index.html': '<html><head><title>Shop</title>\n<script>\nconst t = "<h1>Not a heading</h1>";\n</script>\n</head><body>\n<h1>Real heading</h1>\n</body></html>',
      'v.py': "def verify(token):'''Check it.'''\n    return True\n",
    };
    const { text } = rm2(Object.keys(files), (p) => files[p]);
    expect(text).toContain('Real heading');
    expect(text).not.toContain('Not a heading');
    expect(text).toMatch(/def verify\(token\):\n/);
    expect(text).toContain('not by parsing');
  });
});
