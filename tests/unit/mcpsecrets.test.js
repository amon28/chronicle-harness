// An MCP server's extra headers (its API key), sign-in and bridge secret, and a PC agent's secret, go to the secure
// store with the other keys (decision 273), and come back from it unchanged.
import { describe, it, expect } from 'vitest';
import { splitSecrets, mergeSecrets } from '../../src/store.js';

const settings = () => ({
  apiKey: 'sk-alex-top',
  theme: 'dark',
  providers: [{ id: 'p1', name: 'OpenRouter', apiKey: 'sk-or-alex', adminKey: 'sk-admin-alex' }],
  mcpServers: [
    { id: 'm1', name: 'Search', url: 'https://mcp.alex.dev/mcp', headers: 'X-Api-Key: hdr-secret-alex', token: 'tok-alex', oauth: { access: 'acc-alex', refresh: 'ref-alex' } },
    { id: 'm2', name: 'Local', transport: 'stdio', command: 'npx x', bridgeSecret: 'bridge-secret-alex' },
    { id: 'm3', name: 'Plain', url: 'https://plain.alex.dev/mcp' },
  ],
  acpAgents: [{ id: 'a1', name: 'PC', url: 'http://pc:9000', secret: 'acp-secret-alex' }],
});
const SECRETS = ['sk-alex-top', 'sk-or-alex', 'sk-admin-alex', 'hdr-secret-alex', 'tok-alex', 'acc-alex', 'ref-alex', 'bridge-secret-alex', 'acp-secret-alex'];

describe('MCP headers, sign-ins and bridge secrets are kept with the keys (decision 273)', () => {
  it('the settings written to IndexedDB hold none of them', () => {
    const { clean, secrets } = splitSecrets(settings());
    const text = JSON.stringify(clean);
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(clean.theme).toBe('dark');
    expect(clean.mcpServers[2]).toEqual({ id: 'm3', name: 'Plain', url: 'https://plain.alex.dev/mcp', token: '' }); // nothing added to a server without them
    expect(secrets.mcpHeaders).toEqual({ m1: 'X-Api-Key: hdr-secret-alex' });
    expect(secrets.mcpBridge).toEqual({ m2: 'bridge-secret-alex' });
    expect(secrets.acp).toEqual({ a1: 'acp-secret-alex' });
  });
  it('they come back unchanged when the settings are read', () => {
    const { clean, secrets } = splitSecrets(settings());
    const back = mergeSecrets(JSON.parse(JSON.stringify(clean)), JSON.parse(JSON.stringify(secrets)));
    const want = settings();
    want.mcpServers[1].token = ''; // an empty token was always written for every server
    want.mcpServers[2].token = '';
    for (const k of ['apiKey', 'providers', 'mcpServers', 'acpAgents']) expect(back[k]).toEqual(want[k]);
  });
  it('a value the user typed since is not overwritten by the stored one', () => {
    const { clean, secrets } = splitSecrets(settings());
    clean.mcpServers[0].headers = 'X-Api-Key: new-alex';
    expect(mergeSecrets(clean, secrets).mcpServers[0].headers).toBe('X-Api-Key: new-alex');
  });
});
