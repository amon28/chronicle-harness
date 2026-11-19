// Random sequences of ordinary work on both sides of the mirror (the app's workspace and the shell's /workspace),
// against a file system that behaves like a real one (a name is a file or a folder, never both). After every sync
// both sides must hold exactly what the last writer of each path left: no acknowledged write lost, nothing resurrected.
// Deterministic: every sequence comes from a seed, and a failure prints it.
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeFs } from './helpers/fakefs.js';
import { syncWork } from '../../src/bridge.js';
import { wsPut, wsDelete, snapshotFiles, recordCheckpoint, undoCheckpoint } from '../../src/sandbox.js';

const dec = (u8) => new TextDecoder().decode(u8);
const W = 'shell/work/c1/';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** fakeFs, but strict the way a disk is: no file where a folder is, no folder under a file. */
function strictFs() {
  const fs = fakeFs();
  const A = (p) => '/data/' + String(p).replace(/^\/+/, '');
  const fileAbove = (p) => {
    let cur = A(p);
    while ((cur = cur.slice(0, cur.lastIndexOf('/'))) && cur !== '/data') if (fs.files.has(cur)) return cur;
    return '';
  };
  const guard = (p) => {
    if (fs.dirs.has(A(p))) throw new Error('EISDIR ' + p);
    const up = fileAbove(p);
    if (up) throw new Error('ENOTDIR ' + up);
  };
  const { writeFile, rename, mkdir, deleteFile } = fs;
  fs.writeFile = async (o) => (guard(o.path), writeFile(o));
  fs.rename = async (o) => (guard(o.to), rename(o));
  fs.mkdir = async (o) => {
    if (fs.files.has(A(o.path)) || fileAbove(o.path)) throw new Error('ENOTDIR ' + o.path);
    return mkdir(o);
  };
  fs.deleteFile = async (o) => {
    if (fs.dirs.has(A(o.path))) throw new Error('EISDIR ' + o.path);
    return deleteFile(o);
  };
  /** what a command in the shell does: rm -rf whatever is in the way, then write */
  fs.shPut = (p, s) => {
    if (fs.dirs.has(A(p))) fs.rmTree(p);
    for (let up; (up = fileAbove(p)); ) deleteFile({ path: up.slice('/data/'.length) }); // the fake's delete is synchronous inside
    fs.put(p, s);
  };
  fs.shRm = (p) => {
    if (fs.dirs.has(A(p))) fs.rmTree(p);
    else deleteFile({ path: p });
    // ...and the folders it emptied (rm -r, git checkout): an EMPTY folder left in the shell where the app then
    // writes a file of that name is its own case - the mirror reports it, see mirror-paths.test.js
    for (let up = p.slice(0, p.lastIndexOf('/')); up.length > W.length; up = up.slice(0, up.lastIndexOf('/'))) {
      const d = A(up);
      if ([...fs.files.keys()].some((k) => k.startsWith(d + '/')) || [...fs.dirs].some((k) => k.startsWith(d + '/'))) break;
      fs.rmTree(up);
    }
  };
  return fs;
}

const NAMES = ['a.txt', 'b.txt', 'src/main.js', 'src/lib/util.js', 'src', 'docs/read me.md', 'docs', 'workspace/a.txt', 'workspace', 'données/é.txt', '.env', 'out/.keep', 'A.txt', 'x.git/config', 'my node_modules.txt', 'deep/1/2/3/4/f', 'deep/1'];

let fs;
beforeEach(() => {
  fs = strictFs();
  globalThis.__ocmFiles = fs;
  delete globalThis.__ocmMode;
});

const shellFiles = () => {
  const out = {};
  for (const [p, f] of fs.files) if (p.startsWith('/data/' + W)) out[p.slice(('/data/' + W).length)] = dec(f.bytes);
  return out;
};
const appFiles = (w) => Object.fromEntries(Object.entries(w.files).map(([p, f]) => [p, dec(f.data)]));
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/** the expected tree: writing p removes a folder p and any file that is a folder on p's way */
function expectPut(model, p, s) {
  for (const k of Object.keys(model)) if (k.startsWith(p + '/') || p.startsWith(k + '/')) delete model[k];
  model[p] = s;
}
function expectRm(model, p) {
  for (const k of Object.keys(model)) if (k === p || k.startsWith(p + '/')) delete model[k];
}

function run(seed, rounds = 12) {
  return async () => {
    const r = rng(seed);
    const pick = () => NAMES[Math.floor(r() * NAMES.length)];
    const w = { id: 'c1', files: {}, shellState: {} };
    const model = {};
    let n = 0;
    const log = [];
    const touched = new Set(); // by the shell while a command runs: the app keeps off these (and what is under or above them)
    const clear = (p) => ![...touched].some((t) => t === p || t.startsWith(p + '/') || p.startsWith(t + '/'));
    const appOp = (during = false) => {
      const p = pick();
      if (during && !clear(p)) return;
      if (r() < 0.3) {
        log.push('app rm ' + p);
        for (const k of Object.keys(w.files)) if (k === p || k.startsWith(p + '/')) wsDelete(w, k, { exact: true });
        expectRm(model, p);
      } else {
        const s = r() < 0.15 ? '' : 'app' + ++n; // sometimes emptied on purpose (write_file with "")
        log.push('app put ' + p);
        // a careful app: what is in the way goes first (delete_file of the folder, then write_file)
        for (const k of Object.keys(w.files)) if (k.startsWith(p + '/') || p.startsWith(k + '/')) wsDelete(w, k, { exact: true });
        wsPut(w, p, s, { exact: true });
        expectPut(model, p, s);
      }
    };
    const shellOp = () => {
      const p = pick();
      if (r() < 0.3) {
        log.push('sh rm ' + p);
        fs.shRm(W + p);
        expectRm(model, p);
      } else {
        const s = 'shell' + ++n;
        log.push('sh put ' + p);
        fs.shPut(W + p, s);
        expectPut(model, p, s);
      }
      return p;
    };
    const check = async (prefer, what) => {
      let res;
      try {
        res = await syncWork(w, 'c1', { prefer });
      } catch (e) {
        throw new Error('seed ' + seed + ': ' + what + ' threw ' + e.message + '\n' + log.join('\n'));
      }
      log.push('-- ' + what + ': ' + res.note);
      const ctx = 'seed ' + seed + ' after ' + what + '\n' + log.join('\n');
      expect(sorted(appFiles(w)), 'app side, ' + ctx).toEqual(sorted(model));
      expect(sorted(shellFiles()), 'shell side, ' + ctx).toEqual(sorted(model));
    };
    for (let i = 0; i < rounds; i++) {
      // a turn: the app works, a command runs (and the app keeps working on other files meanwhile), files come back
      const before = snapshotFiles(w);
      const modelBefore = { ...model };
      for (let k = Math.floor(r() * 4); k > 0; k--) appOp();
      await check('a', 'prepare ' + i);
      touched.clear();
      for (let k = Math.floor(r() * 4); k > 0; k--) touched.add(shellOp());
      for (let k = Math.floor(r() * 3); k > 0; k--) appOp(true);
      await check('b', 'collect ' + i);
      // ...and sometimes the user takes the whole turn back: both sides are as they were before it
      const ck = recordCheckpoint(w, before);
      if (ck && r() < 0.25) {
        log.push('undo');
        undoCheckpoint(w, ck.id);
        for (const k of Object.keys(model)) delete model[k];
        Object.assign(model, modelBefore);
        await check('a', 'undo ' + i);
      }
    }
  };
}

describe('the mirror, under random work on both sides (one side at a time)', () => {
  for (let seed = 1; seed <= 200; seed++) it('seed ' + seed, run(seed));
});
