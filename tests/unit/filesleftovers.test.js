// Leftovers of the round-6 files hunt: apply_patch moving onto a file, a shell file named __proto__, write_file under
// node_modules, and an empty shell folder in the way of an app file.
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeFs } from './helpers/fakefs.js';
import { runCodeTool, writeFileTool } from '../../src/codetools.js';
import { syncWork } from '../../src/bridge.js';
import { wsPut, wsDelete, getWorkspace } from '../../src/sandbox.js';

const dec = (u8) => (u8 ? new TextDecoder().decode(u8) : undefined);
const W = 'shell/work/';
let fs;
beforeEach(() => {
  fs = fakeFs();
  globalThis.__ocmFiles = fs;
  delete globalThis.__ocmMode;
  // like a disk: no file where a folder is
  const A = (p) => '/data/' + String(p).replace(/^\/+/, '');
  const { rename, deleteFile } = fs;
  fs.rename = async (o) => {
    if (fs.dirs.has(A(o.to))) throw new Error('Cannot overwrite a directory with a file');
    return rename(o);
  };
  fs.deleteFile = async (o) => {
    if (fs.dirs.has(A(o.path))) throw new Error('is a directory');
    return deleteFile(o);
  };
});

describe('apply_patch "Move to" onto a file that exists', () => {
  it('is refused before anything is written', async () => {
    const w = { id: 'p1', files: {} };
    wsPut(w, 'a.py', 'print(1)\n');
    wsPut(w, 'b.py', 'keep me\n');
    const patch = '*** Begin Patch\n*** Update File: a.py\n*** Move to: b.py\n@@\n-print(1)\n+print(2)\n*** End Patch';
    await expect(runCodeTool('apply_patch', { patch }, {}, w)).rejects.toThrow(/b\.py already exists/);
    expect(dec(w.files['b.py'].data)).toBe('keep me\n');
    expect(dec(w.files['a.py'].data)).toBe('print(1)\n');
  });
  it('is allowed when the same patch deletes the file in the way', async () => {
    const w = { id: 'p2', files: {} };
    wsPut(w, 'a.py', 'print(1)\n');
    wsPut(w, 'b.py', 'old\n');
    const patch = '*** Begin Patch\n*** Delete File: b.py\n*** Update File: a.py\n*** Move to: b.py\n@@\n-print(1)\n+print(2)\n*** End Patch';
    await runCodeTool('apply_patch', { patch }, {}, w);
    expect(Object.keys(w.files)).toEqual(['b.py']);
    expect(dec(w.files['b.py'].data)).toBe('print(2)\n');
  });
});

describe('a shell file named __proto__', () => {
  it('comes into the app as a file, and does not make other names look like files', async () => {
    const w = await getWorkspace('proto1');
    wsPut(w, 'a.txt', 'a');
    await syncWork(w, 'proto1');
    fs.put(W + 'proto1/__proto__', 'odd name');
    await syncWork(w, 'proto1');
    expect(Object.keys(w.files).sort()).toEqual(['__proto__', 'a.txt']);
    expect(dec(w.files['__proto__'].data)).toBe('odd name');
    expect(w.files.data).toBeUndefined(); // the entry did not become the prototype of the file list
    expect(w.files.constructor).toBeUndefined();
    // and a delete in the app reaches the shell
    wsDelete(w, '__proto__');
    await syncWork(w, 'proto1');
    expect(fs.get(W + 'proto1/__proto__')).toBeUndefined();
    expect(Object.keys(w.files)).toEqual(['a.txt']);
  });
  it('write_file of names like constructor or toString works in a new workspace', async () => {
    const w = await getWorkspace('proto2');
    const r = await runCodeTool('apply_patch', { patch: '*** Begin Patch\n*** Add File: constructor\n+x\n*** End Patch' }, {}, w);
    expect(r.result).toMatch(/added constructor/);
    await writeFileTool({ path: 'toString/a.txt', content: 'y' }, {}, w);
    expect(Object.keys(w.files).sort()).toEqual(['constructor', 'toString/a.txt']);
  });
});

describe('write_file under node_modules', () => {
  it('says the file does not reach the shell', async () => {
    const w = { id: 'nm1', files: {} };
    const r = await writeFileTool({ path: 'node_modules/x/index.js', content: 'module.exports = 1\n' }, {}, w);
    expect(r.result).toMatch(/not copied into the shell/);
    const plain = await writeFileTool({ path: 'src/index.js', content: 'module.exports = 1\n' }, {}, w);
    expect(plain.result).not.toMatch(/not copied into the shell/);
  });
});

describe('an empty folder in the shell where the app has a file', () => {
  it('is replaced by the file', async () => {
    const w = { id: 'ef1', files: {}, shellState: {} };
    await fs.mkdir({ path: W + 'ef1/docs' });
    await fs.mkdir({ path: W + 'ef1/docs/sub' });
    wsPut(w, 'docs', 'a file now');
    const r = await syncWork(w, 'ef1');
    expect(r.note || '').not.toMatch(/could NOT copy/);
    expect(fs.get(W + 'ef1/docs')).toBe('a file now');
  });
  it('a folder that holds files is not removed', async () => {
    const w = { id: 'ef2', files: {}, shellState: {} };
    fs.put(W + 'ef2/docs/keep.md', 'shell work');
    await syncWork(w, 'ef2'); // the folder's file comes into the app first
    wsDelete(w, 'docs/keep.md');
    fs.put(W + 'ef2/docs/new.md', 'written in the shell since');
    wsPut(w, 'docs', 'a file');
    await syncWork(w, 'ef2');
    expect(fs.get(W + 'ef2/docs/new.md')).toBe('written in the shell since');
  });
});
