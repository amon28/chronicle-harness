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

import { buildBackup, readBackup, applyBackup } from '../../src/backup.js';

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
