// Reproduction: the shell's /workspace grows past shellfs.listTree's 20,000-entry cap (git clone +
// npm ci), the listing is cut short without saying so, and the reconciler reads "not in this
// listing" as "deleted in the shell" - deleting app-side files, including fresh edits.
//
// Every test asserts the safe behaviour (8 of the 12 failed before the fix).
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeFs } from './helpers/fakefs.js';
import { syncWork } from '../../src/bridge.js';
import { wsPut } from '../../src/sandbox.js';

const dec = (u8) => new TextDecoder().decode(u8);
const W = 'shell/work/c1/';
const CAP = 20000; // MAX_ENTRIES in src/shellfs.js

let fs;
beforeEach(() => {
  fs = fakeFs();
  globalThis.__ocmFiles = fs;
  delete globalThis.__ocmMode;
});

// One shared 33 MiB buffer: every tree file is over the 32 MiB crossing cap, so none is copied into the
// app (that copy calls saveWorkspace -> summarize(all files) once per file: quadratic, ~100 s for 20,000).
// What matters here is only how many names the shell side has, and that they sort before output/.
const HEAVY = new Uint8Array(33 * 1024 * 1024);
const workspace = () => ({ id: 'c1', files: {}, shellState: {} });
const appList = (w, dir) => Object.keys(w.files).filter((p) => p.startsWith(dir + '/'));

// node_modules: the tester's case (the fix keeps it out of the mirror altogether);
// vendor: a big tree under any other name (the fix must still never delete because of the cap)
describe.each(['om/node_modules', 'om/vendor'])('a /workspace bigger than the listing cap (%s)', (tree) => {
  const bigTree = (n = CAP + 500) => {
    for (let i = 0; i < n; i++) fs.put(W + tree + '/pkg' + (i % 40) + '/f' + i + '.js', HEAVY);
  };

  it('(b) a file written with write_file survives the very next shell command', async () => {
    const w = workspace();
    bigTree(); // git clone + npm ci
    await syncWork(w, 'c1', { prefer: 'b' }); // that command's collect
    wsPut(w, 'output/probe.txt', 'probe'); // write_file
    await syncWork(w, 'c1', { prefer: 'a' }); // prepareShell of the next command
    expect(fs.get(W + 'output/probe.txt')).toBe('probe'); // it reached the shell
    const post = await syncWork(w, 'c1', { prefer: 'b' }); // collectShell after it
    expect(post.note).not.toMatch(/deleted on both sides/);
    expect(w.files['output/probe.txt']).toBeDefined();
  });

  it('(a) list_files keeps showing output/ while the shell shows it, and (c) nothing has to come back', async () => {
    const w = workspace();
    for (let i = 0; i < 5; i++) wsPut(w, 'output/r' + i + '.txt', 'r' + i);
    await syncWork(w, 'c1');
    bigTree();
    await syncWork(w, 'c1', { prefer: 'b' });
    expect(appList(w, 'output').length).toBe(5);
    fs.rmTree(W + 'om'); // rm -rf om
    const r = await syncWork(w, 'c1', { prefer: 'b' });
    expect(r.down).toBe(0); // (c) on the unpatched tree, output/ "reappears" here
    expect(appList(w, 'output').length).toBe(5);
  });

  it('an app-side edit made while a background job grows the tree is not destroyed (the real loss)', async () => {
    const w = workspace();
    wsPut(w, 'output/report.md', 'v1');
    await syncWork(w, 'c1'); // agreed on both sides
    // `npm ci` runs as a job (over 30 s); meanwhile the model edits the report with edit_file
    bigTree();
    wsPut(w, 'output/report.md', 'v2 - the only copy of this edit');
    await syncWork(w, 'c1', { prefer: 'b' }); // the job's collectShell (shell.js onFinish)
    fs.rmTree(W + 'om'); // later: rm -rf om, the scan is complete again
    await syncWork(w, 'c1', { prefer: 'b' });
    const now = w.files['output/report.md'] ? dec(w.files['output/report.md'].data) : '(gone)';
    expect(now).toBe('v2 - the only copy of this edit');
    expect(fs.get(W + 'output/report.md')).toBe('v2 - the only copy of this edit');
  });

  it('the other direction: an incomplete scan never deletes shell files', async () => {
    const w = workspace();
    fs.put(W + 'output/shell-made.csv', 'a,b');
    await syncWork(w, 'c1', { prefer: 'b' });
    bigTree();
    for (let i = 0; i < 4; i++) await syncWork(w, 'c1', { prefer: i % 2 ? 'a' : 'b' });
    expect(fs.get(W + 'output/shell-made.csv')).toBe('a,b');
  });

  it('a delete in the shell still reaches the app once the scan is whole again', async () => {
    const w = workspace();
    wsPut(w, 'output/old.txt', 'old');
    await syncWork(w, 'c1');
    bigTree();
    await fs.deleteFile({ path: W + 'output/old.txt' }); // rm in the shell, while the tree is big
    await syncWork(w, 'c1', { prefer: 'b' });
    fs.rmTree(W + 'om');
    const r = await syncWork(w, 'c1', { prefer: 'b' });
    expect(w.files['output/old.txt']).toBeUndefined();
    expect(fs.get(W + 'output/old.txt')).toBeUndefined(); // and it did not come back
    expect(r.note || '').not.toMatch(/kept output\/old/);
  });
});

describe('other ways to an incomplete listing', () => {
  it('an unreadable sub-directory is not a deleted one', async () => {
    const w = workspace();
    wsPut(w, 'data/keep.json', '{}');
    await syncWork(w, 'c1');
    const real = fs.readdir;
    fs.readdir = async (o) => (String(o.path).endsWith('/data') ? Promise.reject(new Error('EACCES')) : real(o)); // chmod 000 data, an I/O error...
    await syncWork(w, 'c1', { prefer: 'b' });
    fs.readdir = real;
    expect(w.files['data/keep.json']).toBeDefined();
  });

  it('the result tells the model the scan was cut short', async () => {
    for (let i = 0; i < CAP + 10; i++) fs.put(W + 'build/f' + i, HEAVY);
    const r = await syncWork(workspace(), 'c1', { prefer: 'b' });
    expect(r.note).toMatch(/more than 20,000 files/);
  });

  it('copies of node_modules the app took before are dropped from the app, not from the shell', async () => {
    const w = workspace();
    fs.put(W + 'node_modules/x/index.js', 'x');
    w.files['node_modules/x/index.js'] = { data: new TextEncoder().encode('x'), mtime: 1 };
    w.shellState['node_modules/x/index.js'] = { a: { size: 1 }, b: { size: 1 } }; // agreed before node_modules stayed in the shell
    const r = await syncWork(w, 'c1', { prefer: 'b' });
    expect(w.files['node_modules/x/index.js']).toBeUndefined();
    expect(fs.get(W + 'node_modules/x/index.js')).toBe('x');
    expect(r.note).toMatch(/dropped the app's copy of 1 file/);
  });

  it('a symbolic link is not followed (a link to ../.. would mirror the app folders)', async () => {
    fs.put(W + 'up/secret.txt', 'private');
    fs.put(W + 'notes.md', 'mine');
    globalThis.__ocmMode = { modes: async () => ({ files: {}, links: ['up'] }) };
    const w = workspace();
    await syncWork(w, 'c1', { prefer: 'b' });
    expect(w.files['notes.md']).toBeDefined();
    expect(Object.keys(w.files).some((p) => p.startsWith('up/'))).toBe(false);
  });
});

