// "Export everything" (decision 218): the backup with keys, each chat's git history and search index, and the
// app's own lists – and Replace restores all of it on a fresh install (a new app id is a new, empty app).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => {
  const table = () => {
    const m = new Map();
    return { m, all: async () => [...m.values()], get: async (id) => m.get(id) ?? null, put: async (x) => void m.set(x.id, x), remove: async (id) => void m.delete(id), clear: async () => m.clear(), ids: async () => [...m.keys()] };
  };
  const kv = new Map();
  return {
    conversations: table(),
    workspaces: table(),
    art: { ...table(), keys: async () => [], read: async () => null },
    kvMove: { kv, keys: async () => [...kv.keys()], get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
  };
});
vi.mock('../../src/store.js', () => db);

import { buildBackup, readBackup, readBackupFile, applyBackup } from '../../src/backup.js';

const store = new Map();
globalThis.localStorage = { get length() { return store.size; }, key: (i) => [...store.keys()][i], getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.__ocmFiles = undefined;

beforeEach(() => {
  for (const t of [db.conversations, db.workspaces]) t.m.clear();
  db.kvMove.kv.clear();
  store.clear();
});

const settings = { apiKey: 'sk-go', providers: [{ id: 'p1', name: 'Claude API', apiKey: 'sk-ant-api-x', adminKey: 'sk-ant-admin-y' }], mcpServers: [{ id: 'm1', name: 'Notion', url: 'https://mcp', oauth: { access: 'a', refresh: 'r' } }], personas: [{ id: 'a', name: 'Ada' }], memories: [] };

describe('Export everything', () => {
  it('a plain backup has no keys and no extras; everything has both, and Replace brings it all back', async () => {
    db.conversations.m.set('c1', { id: 'c1', title: 'code', updatedAt: 5, messages: [] });
    db.kvMove.kv.set('git:c1', { objects: new Map([['abc', new Uint8Array([1, 2, 3])]]), head: 'abc' });
    db.kvMove.kv.set('vec:c1', { v: [[0.1, 0.2]] });
    store.set('ocm.usageLog', '[{"t":1}]');
    store.set('ocm.cache.models', 'stale');

    const plain = readBackup((await buildBackup(settings)).zip);
    expect(JSON.stringify(plain.data.settings)).not.toContain('sk-ant');
    expect(plain.extra).toBeUndefined();

    const { zip, stats } = await buildBackup(settings, { everything: true });
    expect(stats.extras).toBe(2);
    const parsed = readBackup(zip);
    expect(parsed.data.everything).toBe(true);
    expect(parsed.data.settings.providers[0]).toMatchObject({ apiKey: 'sk-ant-api-x', adminKey: 'sk-ant-admin-y' });
    expect(parsed.data.settings.mcpServers[0].oauth).toEqual({ access: 'a', refresh: 'r' });

    // the new app: empty
    db.conversations.m.clear();
    db.kvMove.kv.clear();
    store.clear();
    const r = await applyBackup(parsed, 'replace', { personas: [], memories: [] });
    expect(r.settings.apiKey).toBe('sk-go');
    expect(r.settings.providers[0].adminKey).toBe('sk-ant-admin-y');
    expect(db.conversations.m.get('c1').title).toBe('code');
    const git = db.kvMove.kv.get('git:c1');
    expect(git.head).toBe('abc');
    expect(git.objects.get('abc')).toEqual(new Uint8Array([1, 2, 3]));
    expect(db.kvMove.kv.get('vec:c1')).toEqual({ v: [[0.1, 0.2]] });
    expect(store.get('ocm.usageLog')).toBe('[{"t":1}]');
    expect(store.has('ocm.cache.models')).toBe(false);
    expect(r.stats.extras).toBe(3);
  });
  it('a git history of a chat that is not in the backup is not written', async () => {
    db.conversations.m.set('c1', { id: 'c1', updatedAt: 5, messages: [] });
    db.kvMove.kv.set('git:other', { head: 'x' });
    const parsed = readBackup((await buildBackup(settings, { everything: true })).zip);
    db.kvMove.kv.clear();
    await applyBackup(parsed, 'replace', { personas: [], memories: [] });
    expect(db.kvMove.kv.has('git:other')).toBe(false);
  });
});

describe('Restore from the file, a piece at a time (decision 220)', () => {
  it('a big backup is read entry by entry: the same chats, files, keys and git history as reading it whole', async () => {
    db.conversations.m.set('c1', { id: 'c1', title: 'code', updatedAt: 5, messages: [] });
    db.conversations.m.set('c2', { id: 'c2', title: 'other', updatedAt: 6, messages: [] });
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 251;
    db.workspaces.m.set('c1', { id: 'c1', files: { 'data.bin': { data: big, mtime: 1700000000000, mode: 0o755 }, 'a/b.txt': { data: new TextEncoder().encode('hello'), mtime: 1700000000000 } } });
    db.kvMove.kv.set('git:c1', { head: 'abc', objects: new Map([['abc', new Uint8Array([4, 5])]]) });
    const { zip } = await buildBackup(settings, { everything: true });
    const blob = new Blob([zip]);
    const p = await readBackupFile(blob);
    expect(p.wsCount).toBe(1);
    expect(p.data.settings.providers[0].apiKey).toBe('sk-ant-api-x');
    expect(typeof p.ws).toBe('function');
    expect(await p.ws('c2')).toBeNull();
    db.conversations.m.clear();
    db.workspaces.m.clear();
    db.kvMove.kv.clear();
    await applyBackup(p, 'replace', { personas: [], memories: [] });
    const files = db.workspaces.m.get('c1').files;
    expect(Buffer.compare(Buffer.from(files['data.bin'].data), Buffer.from(big))).toBe(0); // (toEqual on 3 MB takes seconds)
    expect(files['data.bin'].mode).toBe(0o755);
    expect(new TextDecoder().decode(files['a/b.txt'].data)).toBe('hello');
    expect(db.kvMove.kv.get('git:c1').objects.get('abc')).toEqual(new Uint8Array([4, 5]));
    expect(db.conversations.m.size).toBe(2);
  }, 60000);
  it('the Linux home file, a cut-short zip and something else say what they are', async () => {
    await expect(readBackupFile(new Blob([new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0])]))).rejects.toThrow(/Linux home archive \(\.tar\.gz\): bring it back with 🐧 Import Linux home/);
    db.conversations.m.set('c1', { id: 'c1', updatedAt: 5, messages: [] });
    const { zip } = await buildBackup(settings);
    await expect(readBackupFile(new Blob([zip.subarray(0, zip.length - 30)]))).rejects.toThrow(/not a backup zip – (no zip directory at its end|the zip directory)/);
    await expect(readBackupFile(new Blob([new TextEncoder().encode('just some text, long enough to be checked as a zip')]))).rejects.toThrow(/not a backup zip – no zip directory/);
  });
});

describe('a damaged backup and the phone\'s own file reader (decision 220)', () => {
  it('a file damaged in the zip is left out and named; everything else comes back', async () => {
    db.conversations.m.set('c1', { id: 'c1', updatedAt: 5, messages: [] });
    const noise = new Uint8Array(400000);
    let x = 7;
    for (let i = 0; i < noise.length; i++) (x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (noise[i] = i % 3 ? 65 : x & 255);
    db.workspaces.m.set('c1', { id: 'c1', files: { 'big.txt': { data: noise, mtime: 1 }, 'ok.txt': { data: new TextEncoder().encode('fine'), mtime: 1 } } });
    const { zip } = await buildBackup(settings, { everything: true });
    // damage a few bytes in the middle of big.txt's compressed data
    const at = Buffer.from(zip).indexOf(Buffer.from('workspaces/c1/big.txt')) + 200;
    const bad = zip.slice();
    for (let i = 0; i < 8; i++) bad[at + i] ^= 0x5a;
    const p = await readBackupFile(new Blob([bad]));
    db.conversations.m.clear();
    db.workspaces.m.clear();
    const r = await applyBackup(p, 'replace', { personas: [], memories: [] });
    const files = db.workspaces.m.get('c1').files;
    expect(new TextDecoder().decode(files['ok.txt'].data)).toBe('fine');
    expect(files['big.txt']).toBeUndefined();
    expect(r.stats.damaged).toHaveLength(1);
    expect(r.stats.damaged[0]).toMatch(/^workspaces\/c1\/big\.txt is damaged in the file \(.+, at byte \d+\)$/);
  });
  it('the picked file read through the native copy, in short pieces, gives the same backup', async () => {
    db.conversations.m.set('c1', { id: 'c1', title: 'native', updatedAt: 5, messages: [] });
    db.workspaces.m.set('c1', { id: 'c1', files: { 'a.txt': { data: new TextEncoder().encode('x'.repeat(50000)), mtime: 1 } } });
    const { zip } = await buildBackup(settings, { everything: true });
    let dropped = false;
    globalThis.__ocmPhoneFolder = {
      pickToCache: async () => ({ path: '/cache/import/picked.bin', size: zip.length, name: 'chronicle-everything.zip' }),
      // the phone hands out at most 8 MB a call, and may give less: here 777 bytes at a time
      readCached: async ({ offset, length }) => ({ data: Buffer.from(zip.subarray(offset, offset + Math.min(length, 777))).toString('base64') }),
      dropCached: async () => void (dropped = true),
    };
    const { pickFileToCache } = await import('../../src/phonefolder.js');
    const f = await pickFileToCache();
    const p = await readBackupFile(f);
    expect(p.data.conversations[0].title).toBe('native');
    expect(new TextDecoder().decode((await p.ws('c1'))['a.txt'].data)).toBe('x'.repeat(50000));
    await f.drop();
    expect(dropped).toBe(true);
    delete globalThis.__ocmPhoneFolder;
  });
  it('a zip whose file count wrapped (more than 65535 files, no zip64) still lists every file', async () => {
    const { zipSync } = await import('fflate');
    const { openZip } = await import('../../src/zipread.js');
    const z = zipSync({ 'a.txt': new TextEncoder().encode('a'), 'b.txt': new TextEncoder().encode('b'), 'c.txt': new TextEncoder().encode('c') });
    const e = z.length - 22;
    z[e + 8] = 1, z[e + 9] = 0, z[e + 10] = 1, z[e + 11] = 0; // the count says 1, as 65537 would after wrapping
    const r = await openZip(new Blob([z]));
    expect(r.names).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(new TextDecoder().decode(await r.get('c.txt'))).toBe('c');
  });
});
