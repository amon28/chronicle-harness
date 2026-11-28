// A backup made without keys holds no configured secret – an MCP server's headers and bridge secret included
// (decision 273) – and restoring it keeps the ones on this phone (a local server without one gets a new one).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const table = () => {
    const m = new Map();
    return { m, all: async () => [...m.values()], get: async (id) => m.get(id) ?? null, put: async (x) => void m.set(x.id, x), remove: async (id) => void m.delete(id), clear: async () => m.clear(), ids: async () => [...m.keys()], keys: async () => [...m.keys()] };
  };
  return { conversations: table(), workspaces: table(), art: { ...table(), read: async () => null } };
});
vi.mock('../../src/store.js', () => db);

import { unzipSync, strFromU8 } from 'fflate';
import { fakeFs } from './helpers/fakefs.js';
import { buildBackup, readBackup, applyBackup } from '../../src/backup.js';

const SECRETS = { apiKey: 'sk-alex-top', exaKey: 'exa-alex', githubToken: 'gho_alex', provider: 'sk-or-alex', admin: 'sk-admin-alex', header: 'hdr-secret-alex', token: 'tok-alex', access: 'acc-alex', refresh: 'ref-alex', bridge: 'bridge-secret-alex', acp: 'acp-secret-alex' };
const settings = () => ({
  apiKey: SECRETS.apiKey,
  exaKey: SECRETS.exaKey,
  githubToken: SECRETS.githubToken,
  personas: [],
  providers: [{ id: 'p1', name: 'OpenRouter', apiKey: SECRETS.provider, adminKey: SECRETS.admin }],
  mcpServers: [
    { id: 'm1', name: 'Search', url: 'https://mcp.alex.dev/mcp', headers: `X-Api-Key: ${SECRETS.header}`, token: SECRETS.token, oauth: { access: SECRETS.access, refresh: SECRETS.refresh } },
    { id: 'm2', name: 'Local', transport: 'stdio', command: 'npx x', bridgeSecret: SECRETS.bridge },
  ],
  acpAgents: [{ id: 'a1', name: 'PC', url: 'http://pc:9000', secret: SECRETS.acp }],
});

beforeEach(() => {
  globalThis.__ocmFiles = fakeFs();
  for (const t of [db.conversations, db.workspaces]) t.m.clear();
});

describe('a backup without keys (decision 273)', () => {
  it('holds no configured secret string anywhere in the zip', async () => {
    db.conversations.m.set('c1', { id: 'c1', title: 'Alex', updatedAt: 1, messages: [] });
    const { zip } = await buildBackup(settings());
    const all = Object.values(unzipSync(zip)).map((b) => strFromU8(b)).join('\n');
    for (const s of Object.values(SECRETS)) expect(all).not.toContain(s);
    expect(all).toContain('mcp.alex.dev'); // the servers themselves are there
  });

  it('restored over this phone, keeps its headers and bridge secret; a new local server gets a fresh secret', async () => {
    const { zip } = await buildBackup(settings());
    const parsed = readBackup(zip);
    parsed.data.settings.mcpServers.push({ id: 'm9', name: 'Other', transport: 'stdio', command: 'npx y' });
    const { settings: s } = await applyBackup(parsed, 'replace', settings());
    const by = Object.fromEntries(s.mcpServers.map((m) => [m.id, m]));
    expect(by.m1.headers).toBe(`X-Api-Key: ${SECRETS.header}`);
    expect(by.m1.token).toBe(SECRETS.token);
    expect(by.m2.bridgeSecret).toBe(SECRETS.bridge);
    expect(by.m9.bridgeSecret).toMatch(/^[0-9a-f]{48}$/);
  });
});
