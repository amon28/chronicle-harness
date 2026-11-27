import { describe, it, expect } from 'vitest';
import { splitSecrets, mergeSecrets, hasPlainSecrets } from '../../src/store.js';

// Decision 256: a PC agent's secret, an MCP server's sign-in (access + refresh token) and a phone-run MCP server's bridge
// secret go to the Android Keystore with the other keys – the settings in IndexedDB keep none of them.
describe('keys kept out of the plain settings', () => {
  const settings = () => ({
    apiKey: 'sk-top', theme: 'dark',
    providers: [{ id: 'p1', apiKey: 'sk-p', adminKey: 'sk-admin' }],
    mcpServers: [
      { id: 'm1', name: 'Notion', url: 'https://mcp', token: 'tok', oauth: { access: 'acc-1', refresh: 'ref-1', clientId: 'cid', tokenEndpoint: 'https://t', expires: 5 } },
      { id: 'm2', name: 'Local', transport: 'stdio', command: 'npx x', bridgeSecret: 'bridge-2' },
    ],
    acpAgents: [{ id: 'a1', name: 'PC', url: 'http://pc:1', secret: 'pc-secret' }, { id: 'claude-code', phone: true }],
    pcFiles: [{ id: 'f1', secret: 'files-secret' }],
  });
  it('splits every key off and puts each back where it was', () => {
    const { secrets, clean } = splitSecrets(settings());
    const text = JSON.stringify(clean);
    for (const k of ['sk-top', 'sk-p', 'sk-admin', '"tok"', 'acc-1', 'ref-1', 'bridge-2', 'pc-secret', 'files-secret']) expect(text).not.toContain(k);
    // what is not a key stays: the sign-in's client and endpoint, the agent's address
    expect(clean.mcpServers[0].oauth).toMatchObject({ clientId: 'cid', tokenEndpoint: 'https://t', expires: 5 });
    expect(clean.acpAgents[0]).toMatchObject({ id: 'a1', url: 'http://pc:1' });
    expect(clean.acpAgents[1]).toEqual({ id: 'claude-code', phone: true });
    expect(hasPlainSecrets(clean)).toBe(false);
    const back = mergeSecrets(clean, JSON.parse(JSON.stringify(secrets)));
    const drop = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === '' ? undefined : v))); // the blanked fields of keys never set
    expect(drop(back)).toEqual(settings());
  });
  it('notices keys still in plain settings (from a version before this one)', () => {
    expect(hasPlainSecrets({ acpAgents: [{ id: 'a1', secret: 'x' }] })).toBe(true);
    expect(hasPlainSecrets({ mcpServers: [{ id: 'm1', oauth: { access: 'a' } }] })).toBe(true);
    expect(hasPlainSecrets({ theme: 'dark', mcpServers: [{ id: 'm1', oauth: { clientId: 'c' } }] })).toBe(false);
  });
  it('a newer sign-in in the settings is not overwritten by the stored one; signed out stays signed out', () => {
    const s = { mcpServers: [{ id: 'm1', oauth: { access: 'new', refresh: 'new-r' } }, { id: 'm2' }] };
    mergeSecrets(s, { mcpOauth: { m1: { access: 'old', refresh: 'old-r' }, m2: { access: 'x', refresh: 'y' } } });
    expect(s.mcpServers[0].oauth).toEqual({ access: 'new', refresh: 'new-r' });
    expect(s.mcpServers[1].oauth).toBeUndefined();
  });
});
