// A background job ends and its files are collected while the assistant keeps working: the collect compares a
// listing of the workspace taken a moment ago. A write that lands after that listing must not be deleted by it.
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

describe('a write that lands while a sync is running', () => {
  it('write_file during the collect of a job that deleted the same file: the new file is kept', async () => {
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'report.md', 'draft 1');
    await syncWork(w, 'c1');
    // the job: rm report.md (it regenerates things), and it ends
    await fs.deleteFile({ path: W + 'report.md' });
    // the collect starts; while it walks the shell's tree, the assistant's write_file lands
    const readdir = fs.readdir;
    let once = true;
    fs.readdir = async (o) => {
      if (once) {
        once = false;
        wsPut(w, 'report.md', 'draft 2 - written by write_file, and acknowledged', { by: 'the assistant' });
      }
      return readdir(o);
    };
    const r = await syncWork(w, 'c1', { prefer: 'b' });
    fs.readdir = readdir;
    expect(dec(w.files['report.md']?.data)).toBe('draft 2 - written by write_file, and acknowledged');
    expect(r.deleted).not.toContain('report.md');
    // and the shell gets it (now or on the next sync), like any file changed after the other side deleted it
    await syncWork(w, 'c1');
    expect(fs.get(W + 'report.md')).toBe('draft 2 - written by write_file, and acknowledged');
  });
});
