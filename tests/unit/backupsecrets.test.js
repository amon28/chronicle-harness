import { describe, it, expect } from 'vitest';
import { withoutSecrets } from '../../src/backup.js';

describe('a backup without keys has none', () => {
  it('drops every key and token: top-level ones (GitHub included), each provider key, each MCP token and sign-in', () => {
    const s = withoutSecrets({
      apiKey: 'sk-go', githubToken: 'gho_x', ghToken: 'github_pat_y', exaKey: 'e', microlinkKey: 'm', theme: 'dark',
      providers: [{ id: 'p1', name: 'OpenRouter', apiKey: 'sk-or', baseUrl: 'https://x' }],
      mcpServers: [{ id: 'm1', name: 'Notion', url: 'https://mcp', token: 'tok', oauth: { access: 'a', refresh: 'r' } }],
    });
    const text = JSON.stringify(s);
    for (const secret of ['sk-go', 'gho_x', 'github_pat_y', 'sk-or', '"tok"', '"refresh"']) expect(text).not.toContain(secret);
    expect(s.theme).toBe('dark');
    expect(s.providers[0]).toMatchObject({ id: 'p1', baseUrl: 'https://x', apiKey: '' });
    expect(s.mcpServers[0]).toEqual({ id: 'm1', name: 'Notion', url: 'https://mcp' });
  });
});
