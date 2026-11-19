import { describe, it, expect } from 'vitest';
import { snapshotFiles, recordCheckpoint, undoCheckpoint } from '../../src/sandbox.js';

const f = (s) => ({ data: new TextEncoder().encode(s), mtime: 1 });

describe('checkpoints', () => {
  it('records what a turn created, changed and deleted, and undoes all of it', () => {
    const w = { id: 'c1', files: { 'keep.txt': f('keep'), 'edit.txt': f('v1'), 'gone.txt': f('bye') } };
    const before = snapshotFiles(w);
    // the turn: new file, edited file (replaced object), deleted file, untouched file
    w.files['new.png'] = f('png');
    w.files['edit.txt'] = f('v2');
    delete w.files['gone.txt'];
    const ck = recordCheckpoint(w, before);
    expect(ck.changes.map((c) => [c.path, c.kind]).sort()).toEqual([['edit.txt', 'changed'], ['gone.txt', 'deleted'], ['new.png', 'created']]);
    const r = undoCheckpoint(w, ck.id);
    expect(r).toMatchObject({ restored: 2, removed: 1 });
    expect(Object.keys(w.files).sort()).toEqual(['edit.txt', 'gone.txt', 'keep.txt']);
    expect(new TextDecoder().decode(w.files['edit.txt'].data)).toBe('v1');
    expect(w.checkpoints).toHaveLength(0);
    expect(undoCheckpoint(w, ck.id)).toBeNull(); // only once
  });
  it('records nothing when nothing changed, and keeps only the newest checkpoints', () => {
    const w = { id: 'c2', files: { a: f('a') } };
    expect(recordCheckpoint(w, snapshotFiles(w))).toBeNull();
    for (let i = 0; i < 15; i++) {
      const b = snapshotFiles(w);
      w.files['a'] = f('v' + i);
      recordCheckpoint(w, b);
    }
    expect(w.checkpoints.length).toBeLessThanOrEqual(12);
  });
});

import { sessionChanges } from '../../src/sandbox.js';
describe('what the chat changed', () => {
  const f = (t) => ({ data: new TextEncoder().encode(t) });
  it('compares each file with how it was before the oldest change, and leaves out what is back to the same', () => {
    const w = {
      files: { 'a.txt': f('three'), 'new.txt': f('n'), 'same.txt': f('s') },
      // newest first
      checkpoints: [{ changes: [{ path: 'a.txt', before: f('two') }, { path: 'same.txt', before: f('x') }] }, { changes: [{ path: 'a.txt', before: f('one') }, { path: 'new.txt', before: null }, { path: 'same.txt', before: f('s') }, { path: 'gone.txt', before: f('g') }] }],
    };
    const c = sessionChanges(w);
    expect(c.map((x) => [x.path, x.kind])).toEqual([['a.txt', 'changed'], ['gone.txt', 'deleted'], ['new.txt', 'created']]);
    expect(new TextDecoder().decode(c[0].before.data)).toBe('one');
  });
});

describe('a file copied in from the shell keeps its own date', () => {
  it('wsPut takes an mtime, and stamps now without one', async () => {
    const { wsPut } = await import('../../src/sandbox.js');
    const w = { id: 'mt', files: {} };
    wsPut(w, 'old.txt', 'x', { mtime: 1767605400000 });
    wsPut(w, 'new.txt', 'x');
    expect(w.files['old.txt'].mtime).toBe(1767605400000);
    expect(Date.now() - w.files['new.txt'].mtime).toBeLessThan(5000);
  });
});
