import { describe, it, expect } from 'vitest';
import { applyEdits, editPreview, sliceLines, globRegex, globFiles, grepFiles, formatGrep, nearestLines, markSeen, seenState, checkSyntaxLocal } from '../../src/codeedit.js';

const src = 'def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n';

describe('edit_file: exact-text edits', () => {
  it('replaces one unique place and keeps the rest byte for byte', () => {
    const r = applyEdits(src, [{ old_text: 'return a - b', new_text: 'return a - b  # minus' }]);
    expect(r.text).toBe(src.replace('return a - b', 'return a - b  # minus'));
    expect(r.replaced).toBe(1);
  });
  it('applies several edits in order, all or nothing', () => {
    const r = applyEdits(src, [
      { old_text: 'def add', new_text: 'def plus' },
      { old_text: 'def plus(a, b):', new_text: 'def plus(a, b=0):' },
    ]);
    expect(r.text).toMatch(/def plus\(a, b=0\):/);
    expect(() => applyEdits(src, [{ old_text: 'def add', new_text: 'x' }, { old_text: 'nope', new_text: 'y' }])).toThrow(/edit #2.*not found.*Nothing was changed/s);
  });
  it('refuses an ambiguous match unless replace_all, and says how many', () => {
    expect(() => applyEdits(src, [{ old_text: '(a, b)', new_text: '(x, y)' }])).toThrow(/appears 2 times/);
    expect(applyEdits(src, [{ old_text: '(a, b)', new_text: '(x, y)', replace_all: true }])).toMatchObject({ replaced: 2 });
  });
  it('a miss shows the closest lines and notices a spacing difference', () => {
    let msg = '';
    try {
      applyEdits(src, [{ old_text: 'def sub(a, b):\n  return a - b', new_text: 'x' }]);
    } catch (e) {
      msg = e.message;
    }
    expect(msg).toMatch(/different spacing/);
    expect(msg).toMatch(/4│ def sub\(a, b\):/);
    expect(nearestLines(src, 'return a + b')).toMatch(/2│ {5}return a \+ b/);
  });
  it('edits a Windows file with its own line endings', () => {
    const crlf = src.replace(/\n/g, '\r\n');
    const r = applyEdits(crlf, [{ old_text: 'def sub(a, b):\n    return a - b', new_text: 'def sub(a, b):\n    return b - a' }]);
    expect(r.text).toBe(crlf.replace('return a - b', 'return b - a'));
  });
  it('rejects empty and no-op edits with a hint', () => {
    expect(() => applyEdits(src, [{ old_text: '', new_text: 'x' }])).toThrow(/write_file/);
    expect(() => applyEdits(src, [{ old_text: 'def', new_text: 'def' }])).toThrow(/same/);
  });
  it('shows the edited lines numbered', () => {
    const after = applyEdits(src, [{ old_text: 'return a - b', new_text: 'return b - a' }]).text;
    expect(editPreview(src, after)).toMatch(/5│ {5}return b - a/);
    expect(sliceLines(src, 4, 5).text).toBe('   4│ def sub(a, b):\n   5│     return a - b');
  });
});

describe('glob and grep over the workspace', () => {
  const files = [
    { path: 'src/app.js', size: 10, mtime: 3 },
    { path: 'src/lib/util.js', size: 10, mtime: 5 },
    { path: 'src/app.css', size: 10, mtime: 1 },
    { path: 'README.md', size: 10, mtime: 2 },
    { path: 'img.png', size: 10, mtime: 2 },
  ];
  const body = { 'src/app.js': 'import x from "./lib/util.js"\nconst TODO = 1\n', 'src/lib/util.js': 'export default 1 // todo later\n', 'src/app.css': 'a{}', 'README.md': '# Todo app\n', 'img.png': null };
  it('matches globs like a shell does', () => {
    expect(globRegex('src/**/*.js').test('src/lib/util.js')).toBe(true);
    expect(globRegex('src/**/*.js').test('src/app.js')).toBe(true);
    expect(globRegex('src/*.js').test('src/lib/util.js')).toBe(false);
    expect(globRegex('*.{js,css}').test('src/app.css')).toBe(true); // a bare pattern matches anywhere
    expect(globFiles(files, '**/*.js').map((f) => f.path)).toEqual(['src/lib/util.js', 'src/app.js']); // newest first
  });
  it('greps text files with line numbers, context and a limit', () => {
    const r = grepFiles(files, (p) => body[p], { pattern: 'todo', ignoreCase: true, context: 1 });
    expect(r.hits.map((h) => `${h.path}:${h.line}`)).toEqual(['README.md:1', 'src/app.js:2', 'src/lib/util.js:1']);
    expect(formatGrep(r, 'todo')).toMatch(/src\/app\.js\n {2}1- import x[\s\S]* {2}2: const TODO = 1/);
    expect(grepFiles(files, (p) => body[p], { pattern: 'todo', ignoreCase: true, max: 1 }).truncated).toBe(true);
    expect(grepFiles(files, (p) => body[p], { pattern: 'a{', literal: true }).hits[0].path).toBe('src/app.css');
    expect(() => grepFiles(files, (p) => body[p], { pattern: '(' })).toThrow(/literal: true/);
  });
});

describe('the assistant only overwrites what it has seen', () => {
  it('tracks the version it read or wrote', () => {
    const w = { files: { 'a.txt': { data: new TextEncoder().encode('one') } } };
    expect(seenState(w, 'a.txt')).toBe('unseen');
    markSeen(w, 'a.txt');
    expect(seenState(w, 'a.txt')).toBe('same');
    w.files['a.txt'] = { data: new TextEncoder().encode('two'), by: 'the shell' };
    expect(seenState(w, 'a.txt')).toBe('changed');
    expect(seenState(w, 'nope')).toBe('missing');
  });
});

describe('syntax check after a write', () => {
  it('finds broken JSON and JavaScript, with the line', async () => {
    expect(await checkSyntaxLocal('a.json', '{"a": 1}')).toBe('');
    expect(await checkSyntaxLocal('a.json', '{"a": 1,\n}')).toMatch(/^JSON: .*line 2/);
    expect(await checkSyntaxLocal('a.js', 'const x = 1;\nconst = 2;\n')).toMatch(/^JavaScript: .*\(line 2, column 7\)/);
    expect(await checkSyntaxLocal('m.js', 'import a from "a";\nexport const b = await a;\n')).toBe('');
    expect(await checkSyntaxLocal('notes.md', 'anything {')).toBe('');
  });
});

describe('the file tools through runTool', async () => {
  const { runTool, toolDefs } = await import('../../src/tools.js');
  const { wsPut } = await import('../../src/sandbox.js');
  const call = (name, args, w) => runTool({ name, arguments: JSON.stringify(args) }, { workspace: w, settings: {}, convId: 'ce' });
  it('read → edit → a change by the shell blocks a blind overwrite', async () => {
    const w = { id: 'ce', files: {} };
    expect((await call('write_file', { path: 'a.py', content: 'x = 1\ny = 2\n' }, w)).ok).toBe(true);
    const e = await call('edit_file', { path: 'a.py', old_text: 'y = 2', new_text: 'y = 3' }, w);
    expect(e.ok).toBe(true);
    expect(e.result).toMatch(/2│ y = 3/);
    expect(e.display.diff.map((o) => o.t + o.s)).toEqual(expect.arrayContaining(['-y = 2', '+y = 3']));
    wsPut(w, 'a.py', 'x = 1\ny = 3\nz = 9\n', { by: 'the shell' });
    const blind = await call('write_file', { path: 'a.py', content: 'x = 0\n' }, w);
    expect(blind.ok).toBe(false);
    expect(blind.result).toMatch(/changed by the shell/);
    expect((await call('read_file', { path: 'a.py', start_line: 3 }, w)).result).toMatch(/lines 3-4 of 4:\n {3}3│ z = 9/);
    expect((await call('write_file', { path: 'a.py', content: 'x = 0\n' }, w)).ok).toBe(true); // it has seen it now
    const broken = await call('write_file', { path: 'b.json', content: '{"a":' }, w);
    expect(broken.result).toMatch(/does not parse[\s\S]*⚠ Syntax check: JSON/);
    expect(broken.ok).toBe(false); // a failed step, not a success with a footnote
    expect(w.files['b.json']).toBeTruthy(); // but kept, to be fixed with edit_file
    expect((await call('grep_files', { pattern: 'x = 0', glob: '*.py' }, w)).result).toMatch(/a\.py\n {2}1: x = 0/);
    expect((await call('glob_files', { pattern: '*.json' }, w)).result).toMatch(/^b\.json/);
    const names = toolDefs({ files: true }).map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['edit_file', 'grep_files', 'glob_files']));
  });
});
