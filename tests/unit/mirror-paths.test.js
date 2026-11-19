// Paths the mirror must carry as they are: the workspace's key is the shell's relative path, whatever it is called.
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeFs } from './helpers/fakefs.js';
import { syncWork } from '../../src/bridge.js';
import { wsPut } from '../../src/sandbox.js';

const dec = (u8) => (u8 ? new TextDecoder().decode(u8) : undefined);
const W = 'shell/work/c1/';
let fs;
beforeEach(() => {
  fs = fakeFs();
  globalThis.__ocmFiles = fs;
  delete globalThis.__ocmMode;
});
const workspace = () => ({ id: 'c1', files: {}, shellState: {} });

describe('a folder named "workspace" inside /workspace', () => {
  it('a shell file under workspace/ does not replace the file of the same name at the top', async () => {
    const w = workspace();
    wsPut(w, 'README.md', 'the real readme');
    await syncWork(w, 'c1');
    fs.put(W + 'workspace/README.md', 'a sub-project readme'); // e.g. git clone …/workspace, or a "workspace" package folder
    await syncWork(w, 'c1', { prefer: 'b' });
    expect(dec(w.files['README.md']?.data)).toBe('the real readme');
    expect(dec(w.files['workspace/README.md']?.data)).toBe('a sub-project readme');
    // and the next command does not delete the shell's file or push the wrong text over the top one
    const r = await syncWork(w, 'c1');
    expect(fs.get(W + 'workspace/README.md')).toBe('a sub-project readme');
    expect(fs.get(W + 'README.md')).toBe('the real readme');
    expect(r.deleted).toEqual([]);
  });

  it('a delete in the shell under workspace/ does not delete the top-level file of the same name', async () => {
    const w = workspace();
    wsPut(w, 'notes.txt', 'top');
    w.files['workspace/notes.txt'] = { data: new TextEncoder().encode('inner'), mtime: 5 }; // as run_python leaves it
    await syncWork(w, 'c1');
    expect(fs.get(W + 'workspace/notes.txt')).toBe('inner');
    await fs.deleteFile({ path: W + 'workspace/notes.txt' });
    const r = await syncWork(w, 'c1', { prefer: 'b' });
    expect(dec(w.files['notes.txt']?.data)).toBe('top');
    expect(w.files['workspace/notes.txt']).toBeUndefined();
    expect(r.undeletable).toEqual([]);
  });
});
