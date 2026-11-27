// Decision 259: the shell folder's listing comes from one native walk (each file's mode, size and time), not a call per
// folder from the app – and the caches a tool makes there (a virtualenv, __pycache__…) stay in Linux only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fakeFs } from './helpers/fakefs.js';
import * as shellfs from '../../src/shellfs.js';

let fs;
beforeEach(() => {
  fs = fakeFs();
  globalThis.__ocmFiles = fs;
});
afterEach(() => delete globalThis.__ocmMode);

describe('listing the shell folder', () => {
  it('takes the whole tree from one native walk when it gives sizes and times', async () => {
    let reads = 0;
    fs.readdir = async () => {
      reads++;
      return { files: [] };
    };
    const deleted = [];
    fs.deleteFile = async (o) => void deleted.push(o.path);
    const asked = [];
    globalThis.__ocmMode = {
      modes: async (o) => (asked.push(o), {
        files: { 'a.txt': 0o644, 'bin/run.sh': 0o755, 'half.txt.ocm-tmp': 0o644 },
        info: { 'a.txt': [3, 1000], 'bin/run.sh': [5, 2000], 'half.txt.ocm-tmp': [1, 1] },
        links: [],
        excluded: ['node_modules', 'py/.venv'],
        incomplete: '',
      }),
    };
    const t = await shellfs.listTree('work/c1');
    expect(reads).toBe(0);
    expect(asked[0].stat).toBe(true);
    expect([...t.keys()].sort()).toEqual(['a.txt', 'bin/run.sh']);
    expect(t.get('bin/run.sh')).toEqual({ size: 5, mtime: 2000, mode: 0o755, exec: true });
    expect(t.get('a.txt')).toMatchObject({ size: 3, mtime: 1000, exec: false });
    expect(t.excluded).toEqual(['node_modules', 'py/.venv']);
    expect(t.incomplete).toBe('');
    expect(deleted.some((p) => p.endsWith('half.txt.ocm-tmp'))).toBe(true);
  });
  it('an older plugin that gives only the modes: the folder walk as before', async () => {
    fs.put('shell/work/c1/a.txt', 'abc');
    globalThis.__ocmMode = { modes: async () => ({ files: { 'a.txt': 0o600 }, links: [] }) };
    const t = await shellfs.listTree('work/c1');
    expect([...t.keys()]).toEqual(['a.txt']);
    expect(t.get('a.txt').mode).toBe(0o600);
  });
  it('a stopped native walk says so: nothing missing from it is taken as deleted', async () => {
    globalThis.__ocmMode = { modes: async () => ({ files: {}, info: {}, links: [], excluded: [], incomplete: 'more than 20,000 files' }) };
    expect((await shellfs.listTree('work/c1')).incomplete).toMatch(/20,000/);
  });
  it('caches a tool makes in the chat folder stay in Linux', () => {
    for (const p of ['.venv/lib/x.py', 'src/__pycache__/m.pyc', 'app/.next/cache.json', 'node_modules/a/b.js']) expect(shellfs.shellOnly(p)).toBe(true);
    for (const p of ['dist/index.html', 'build/app.js', 'src/main.py']) expect(shellfs.shellOnly(p)).toBe(false);
  });
});
