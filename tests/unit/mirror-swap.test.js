// A name is a file or a folder, never both. When one side replaces one with the other, the old one has to go before
// the new one can be written - and a file that cannot cross must not stop every file after it.
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeFs } from './helpers/fakefs.js';
import { syncWork, prepareShell, collectShell } from '../../src/bridge.js';
import { wsPut, wsDelete } from '../../src/sandbox.js';

const dec = (u8) => (u8 ? new TextDecoder().decode(u8) : undefined);
const W = 'shell/work/c1/';
let fs;
beforeEach(() => {
  fs = fakeFs();
  globalThis.__ocmFiles = fs;
  delete globalThis.__ocmMode;
  // like a disk (and like Capacitor's Filesystem): no file where a folder is, no folder under a file
  const A = (p) => '/data/' + String(p).replace(/^\/+/, '');
  const fileAbove = (p) => {
    for (let cur = A(p); (cur = cur.slice(0, cur.lastIndexOf('/'))) && cur !== '/data'; ) if (fs.files.has(cur)) return cur;
    return '';
  };
  const guard = (p) => {
    if (fs.dirs.has(A(p))) throw new Error('Cannot overwrite a directory with a file');
    if (fileAbove(p)) throw new Error('Parent folder is a file: ' + fileAbove(p));
  };
  const { writeFile, rename, deleteFile } = fs;
  fs.writeFile = async (o) => (guard(o.path), writeFile(o));
  fs.rename = async (o) => (guard(o.to), rename(o));
  fs.deleteFile = async (o) => {
    if (fs.dirs.has(A(o.path))) throw new Error('is a directory');
    return deleteFile(o);
  };
});
const workspace = () => ({ id: 'c1', files: {}, shellState: {} });
const mount = { mounts: '', mode: 'none', folder: null, workHost: '/data/shell/work/c1', error: '' };

describe('a folder replaced by a file of the same name, and the reverse', () => {
  it('delete_file docs/ then write_file docs: the shell gets the file, and later commands still sync', async () => {
    const w = workspace();
    wsPut(w, 'docs/a.md', 'A');
    wsPut(w, 'docs/b.md', 'B');
    await syncWork(w, 'c1');
    wsDelete(w, 'docs/a.md');
    wsDelete(w, 'docs/b.md');
    wsPut(w, 'docs', 'now one file');
    wsPut(w, 'other.txt', 'written in the same turn');
    const prep = await prepareShell({ w, ctx: {}, convId: 'c1', mount });
    expect(prep.note).not.toMatch(/did not sync/);
    expect(fs.get(W + 'docs')).toBe('now one file');
    expect(fs.get(W + 'other.txt')).toBe('written in the same turn');
    // what the command writes comes back
    fs.put(W + 'result.txt', 'from the shell');
    const post = await collectShell({ w, ctx: {}, convId: 'c1' });
    expect(post.note).not.toMatch(/failed/);
    expect(dec(w.files['result.txt']?.data)).toBe('from the shell');
  });

  it('delete_file src then write_file src/main.js: the folder replaces the file in the shell', async () => {
    const w = workspace();
    wsPut(w, 'src', 'a file called src');
    await syncWork(w, 'c1');
    wsDelete(w, 'src');
    wsPut(w, 'src/main.js', 'x');
    const prep = await prepareShell({ w, ctx: {}, convId: 'c1', mount });
    expect(prep.note).not.toMatch(/did not sync/);
    expect(fs.get(W + 'src/main.js')).toBe('x');
    expect(fs.get(W + 'src')).toBeUndefined();
  });

  it('a file that cannot cross is named, and the files after it still cross', async () => {
    const w = workspace();
    wsPut(w, 'a', 'a file');
    wsPut(w, 'a/b.txt', 'under a name that is a file'); // the workspace is a flat map and takes both; a disk cannot
    wsPut(w, 'z.txt', 'an ordinary file');
    const r = await syncWork(w, 'c1');
    expect(fs.get(W + 'z.txt')).toBe('an ordinary file');
    expect(r.failed.map((f) => f.path)).toEqual(['a/b.txt']);
    expect(r.note).toMatch(/could NOT copy a\/b\.txt/);
    expect(dec(w.files['a/b.txt'].data)).toBe('under a name that is a file'); // nothing lost in the app
  });
});
