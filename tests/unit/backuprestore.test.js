// A restored backup gives every chat its files as they were (modes, exec bits, dates), the Files page's index
// counts them, and the shell's old /workspace of the same chat cannot bring back files that are not in the backup.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => {
  const table = () => {
    const m = new Map();
    return { m, all: async () => [...m.values()], get: async (id) => m.get(id) ?? null, put: async (x) => void m.set(x.id, x), remove: async (id) => void m.delete(id), clear: async () => m.clear(), ids: async () => [...m.keys()], keys: async () => [...m.keys()] };
  };
  return { conversations: table(), workspaces: table(), art: { ...table(), read: async () => null } };
});
vi.mock('../../src/store.js', () => db);

import { unzipSync, zipSync } from 'fflate';
import { fakeFs } from './helpers/fakefs.js';
import { buildBackup, readBackup, applyBackup } from '../../src/backup.js';
import { workspaceSummaries } from '../../src/sandbox.js';
import { syncWork } from '../../src/bridge.js';

const enc = (s) => new TextEncoder().encode(s);
let fs;
beforeEach(() => {
  fs = fakeFs();
  globalThis.__ocmFiles = fs;
  for (const t of [db.conversations, db.workspaces]) t.m.clear();
});

async function backupOf(files, { old = false } = {}) {
  db.conversations.m.set('c1', { id: 'c1', title: 'one', updatedAt: 10, messages: [] });
  db.workspaces.m.set('c1', { id: 'c1', files });
  const { zip } = await buildBackup({ personas: [] });
  if (!old) return readBackup(zip);
  const entries = unzipSync(zip); // a backup made before the modes were kept
  delete entries['workspaces.json'];
  return readBackup(zipSync(entries));
}

describe('restoring a backup', () => {
  it('keeps the mode, exec bit and date of every file', async () => {
    const parsed = await backupOf({
      'run.sh': { data: enc('#!/bin/sh\necho hi\n'), mtime: 1700000000000, exec: true, mode: 0o755 },
      'secret.key': { data: enc('k'), mtime: 1600000000000, exec: false, mode: 0o600 },
    });
    db.workspaces.m.clear();
    await applyBackup(parsed, 'replace', {});
    const w = db.workspaces.m.get('c1');
    expect(w.files['run.sh']).toMatchObject({ mode: 0o755, exec: true, mtime: 1700000000000 });
    expect(w.files['secret.key']).toMatchObject({ mode: 0o600, exec: false, mtime: 1600000000000 });
  });

  it('an older backup without the list of modes still restores (dates become now)', async () => {
    const parsed = await backupOf({ 'a.txt': { data: enc('a'), mtime: 5, mode: 0o755 } }, { old: true });
    await applyBackup(parsed, 'replace', {});
    const f = db.workspaces.m.get('c1').files['a.txt'];
    expect(new TextDecoder().decode(f.data)).toBe('a');
    expect(f.mtime).toBeGreaterThan(5);
    expect(f.mode).toBeUndefined();
  });

  it('the Files page index counts the restored files', async () => {
    const parsed = await backupOf({ 'a.txt': { data: enc('a'), mtime: 5 }, 'b.txt': { data: enc('b'), mtime: 6 } });
    db.workspaces.m.set('c1', { id: 'c1', files: { 'old.txt': { data: enc('old'), mtime: 1 } } });
    expect((await workspaceSummaries()).find((s) => s.id === 'c1').n).toBe(1);
    db.conversations.m.get('c1').updatedAt = 1; // the phone's copy is older: merge takes the backup's
    await applyBackup(parsed, 'merge', {});
    expect((await workspaceSummaries()).find((s) => s.id === 'c1').n).toBe(2);
  });

  it("the shell's old /workspace of the same chat does not bring back files that are not in the backup", async () => {
    const parsed = await backupOf({ 'a.txt': { data: enc('a'), mtime: 5 } });
    fs.put('shell/work/c1/gone.txt', 'deleted before the backup was made');
    fs.put('shell/work/other/keep.txt', 'another chat');
    await applyBackup(parsed, 'replace', {});
    const w = db.workspaces.m.get('c1');
    await syncWork(w, 'c1');
    expect(Object.keys(w.files)).toEqual(['a.txt']);
    expect(fs.get('shell/work/c1/a.txt')).toBe('a');
    expect(fs.get('shell/work/other/keep.txt')).toBe('another chat'); // not restored over: left alone
  });
});
