// Decision 35 ("a failed transfer must never become an edit") puts content back over an empty copy. That is right for
// the shell's side, where a zero-byte file is what a failed write leaves. The app's side is memory: a file is replaced
// whole or not at all, so an empty file there that changed since the last sync was MADE empty (write_file with "",
// Python's open(p, "w")). Putting the old text back undoes an acknowledged write on both sides.
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

describe('a file emptied in the app', () => {
  it('stays empty and reaches the shell empty, and the result says an empty file crossed', async () => {
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'log.txt', 'yesterday\n');
    await syncWork(w, 'c1');
    wsPut(w, 'log.txt', '', { by: 'the assistant' }); // write_file path=log.txt content="" -> "Wrote log.txt (0 chars)"
    const r = await syncWork(w, 'c1', { prefer: 'a' });
    expect(dec(w.files['log.txt'].data)).toBe('');
    expect(fs.get(W + 'log.txt')).toBe('');
    expect(r.note).toMatch(/EMPTY file crossed: log\.txt \(written by the assistant\)/);
    expect(r.note).not.toMatch(/the newer one won/);
  });

  it('also when the sync that sees it is the one after a command (prefer the shell)', async () => {
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'log.txt', 'yesterday\n');
    await syncWork(w, 'c1');
    wsPut(w, 'log.txt', '', { by: 'python' });
    await syncWork(w, 'c1', { prefer: 'b' });
    expect(dec(w.files['log.txt'].data)).toBe('');
    expect(fs.get(W + 'log.txt')).toBe('');
  });

  it('unchanged rules: a zero-byte file in the SHELL never replaces content, nor does an empty app file the two never agreed on', async () => {
    const w = { id: 'c1', files: {}, shellState: {} };
    wsPut(w, 'keep.bin', 'important');
    await syncWork(w, 'c1');
    fs.put(W + 'keep.bin', '');
    await syncWork(w, 'c1', { prefer: 'b' });
    expect(dec(w.files['keep.bin'].data)).toBe('important');
    fs.put(W + 'first.txt', 'shell content');
    wsPut(w, 'first.txt', '');
    await syncWork(w, 'c1');
    expect(dec(w.files['first.txt'].data)).toBe('shell content');
    // and when the shell changed the file too, its content is not thrown away for an empty one
    wsPut(w, 'log.txt', 'a');
    await syncWork(w, 'c1');
    wsPut(w, 'log.txt', '');
    fs.put(W + 'log.txt', 'appended by the job');
    await syncWork(w, 'c1', { prefer: 'a' });
    expect(dec(w.files['log.txt'].data)).toBe('appended by the job');
  });
});
