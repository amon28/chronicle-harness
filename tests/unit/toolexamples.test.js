import { describe, it, expect } from 'vitest';
import { parsePatch, applyHunks } from '../../src/patch.js';
import { codeDefs } from '../../src/codetools.js';

// the example call in apply_patch's description is a real patch: it parses and applies (decision 201)
describe('example calls in tool descriptions', () => {
  it('apply_patch’s example applies', () => {
    const d = codeDefs().find((x) => x.function.name === 'apply_patch').function.description;
    const ex = d.slice(d.indexOf('*** Begin Patch', d.indexOf('Example')), d.lastIndexOf('*** End Patch') + '*** End Patch'.length);
    const ops = parsePatch(ex);
    const files = { 'src/util.js': 'export function fmt(x) {\n  return String(x);\n}\n', 'src/main.js': "import { fmt } from './util.js';\nconst now = 1;\nconsole.log(fmt(now));\n" };
    for (const o of ops) {
      const r = applyHunks(files[o.path], o.hunks, o.path);
      files[o.path] = typeof r === 'string' ? r : r.text;
    }
    expect(files['src/util.js']).toContain('export function formatDate(x) {');
    expect(files['src/main.js']).toBe("import { formatDate } from './util.js';\nconst now = 1;\nconsole.log(formatDate(now));\n");
  });
});
