// Decision 256: a write to the shell's storage renames the finished temporary over the old copy first – the old copy is
// deleted beforehand only when that rename is refused (deleting first left no file when the rename then failed).
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeFs } from './helpers/fakefs.js';
import * as shellfs from '../../src/shellfs.js';

let fs;
beforeEach(() => {
  fs = fakeFs();
  globalThis.__ocmFiles = fs;
});
const enc = (s) => new TextEncoder().encode(s);

describe('writing a file over an older copy', () => {
  it('renames over it without deleting it first', async () => {
    fs.put('shell/work/c1/notes.md', 'old');
    const deleted = [];
    const del = fs.deleteFile.bind(fs);
    fs.deleteFile = async (o) => (deleted.push(o.path), del(o));
    await shellfs.writeFile('work/c1', 'notes.md', enc('new text'));
    expect(fs.get('shell/work/c1/notes.md')).toBe('new text');
    expect(deleted.filter((p) => p.endsWith('notes.md'))).toEqual([]);
  });
  it('when the rename over it is refused, deletes the old copy and renames again', async () => {
    fs.put('shell/work/c1/notes.md', 'old');
    const rename = fs.rename.bind(fs);
    fs.rename = async (o) => {
      if (fs.get(o.to.replace(/^\/data\//, '')) !== undefined) throw new Error('destination exists');
      return rename(o);
    };
    await shellfs.writeFile('work/c1', 'notes.md', enc('new text'));
    expect(fs.get('shell/work/c1/notes.md')).toBe('new text');
  });
});
