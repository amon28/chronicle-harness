import { describe, it, expect } from 'vitest';
import { runCodeTool, writeFileTool } from '../../src/codetools.js';
import { wsPut } from '../../src/sandbox.js';

const mk = () => {
  const w = { id: 't-move', files: {} };
  wsPut(w, 'a.txt', 'A');
  wsPut(w, 'img/x.png', new Uint8Array([137, 80, 78, 71]));
  wsPut(w, 'img/y.png', new Uint8Array([1, 2]));
  return w;
};
describe('move_file and delete_file', () => {
  it('moves a file, a folder, copies, and refuses to clobber', async () => {
    const w = mk();
    await runCodeTool('move_file', { from: 'a.txt', to: 'docs/a.md' }, {}, w);
    expect(Object.keys(w.files).sort()).toEqual(['docs/a.md', 'img/x.png', 'img/y.png']);
    const r = await runCodeTool('move_file', { from: 'img', to: 'pics', copy: true }, {}, w);
    expect(r.result).toContain('Copied 2 files');
    expect(w.files['pics/x.png'].data[0]).toBe(137);
    expect(w.files['img/x.png']).toBeTruthy();
    await expect(runCodeTool('move_file', { from: 'img/x.png', to: 'pics/x.png' }, {}, w)).rejects.toThrow(/already exists/);
  });
  it('deletes a file or a whole folder', async () => {
    const w = mk();
    const r = await runCodeTool('delete_file', { path: 'img' }, {}, w);
    expect(r.result).toContain('2 files');
    expect(Object.keys(w.files)).toEqual(['a.txt']);
    await expect(runCodeTool('delete_file', { path: 'nope' }, {}, w)).rejects.toThrow(/Not found/);
  });
});

// The workspace is a flat map of paths, so it would take a file "docs" next to "docs/a.md". The shell and Python
// cannot: there a name is a file or a folder. A tool that makes both leaves a file that never reaches them.
describe('a name is a file or a folder, never both', () => {
  it('move_file into an existing folder puts the file IN it (like mv), not a file of the folder\'s name next to it', async () => {
    const w = mk();
    const r = await runCodeTool('move_file', { from: 'a.txt', to: 'img' }, {}, w);
    expect(Object.keys(w.files).sort()).toEqual(['img/a.txt', 'img/x.png', 'img/y.png']);
    expect(r.result).toContain('img/a.txt');
    const w2 = mk();
    await runCodeTool('move_file', { from: 'a.txt', to: 'new-folder/' }, {}, w2); // a trailing slash says "folder"
    expect(Object.keys(w2.files).sort()).toEqual(['img/x.png', 'img/y.png', 'new-folder/a.txt']);
  });
  it('move_file keeps the permission bits (a key that was 600 is not world-readable after a rename)', async () => {
    const w = mk();
    wsPut(w, 'id_key', 'secret', { mode: 0o600 });
    await runCodeTool('move_file', { from: 'id_key', to: 'keys/id_key' }, {}, w);
    expect(w.files['keys/id_key'].mode).toBe(0o600);
  });
  it('move_file refuses to move a folder into itself', async () => {
    const w = mk();
    await expect(runCodeTool('move_file', { from: 'img', to: 'img/old', overwrite: true }, {}, w)).rejects.toThrow(/into itself/);
    expect(Object.keys(w.files).sort()).toEqual(['a.txt', 'img/x.png', 'img/y.png']);
  });
  it('write_file refuses a path under a file, and a file where a folder is', async () => {
    const w = mk();
    await expect(writeFileTool({ path: 'a.txt/notes.md', content: 'x' }, {}, w)).rejects.toThrow(/a\.txt is a file/);
    await expect(writeFileTool({ path: 'img', content: 'x' }, {}, w)).rejects.toThrow(/img is a folder/);
    expect(Object.keys(w.files).sort()).toEqual(['a.txt', 'img/x.png', 'img/y.png']);
  });
  it('apply_patch refuses the same, before anything is written - unless the patch itself clears the way', async () => {
    const w = mk();
    const bad = '*** Begin Patch\n*** Add File: ok.txt\n+fine\n*** Add File: a.txt/inner.txt\n+x\n*** End Patch';
    await expect(runCodeTool('apply_patch', { patch: bad }, {}, w)).rejects.toThrow(/a\.txt is a file/);
    expect(w.files['ok.txt']).toBeUndefined();
    const good = '*** Begin Patch\n*** Delete File: a.txt\n*** Add File: a.txt/inner.txt\n+x\n*** End Patch';
    await runCodeTool('apply_patch', { patch: good }, {}, w);
    expect(Object.keys(w.files).sort()).toEqual(['a.txt/inner.txt', 'img/x.png', 'img/y.png']);
  });
});
