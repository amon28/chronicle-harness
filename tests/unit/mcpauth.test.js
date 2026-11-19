import { describe, it, expect } from 'vitest';
import { signIn, refresh, parseWwwAuth, pkceChallenge, REDIRECT_URI, waitRedirect, handleRedirect } from '../../src/mcpauth.js';

function fakeAS() {
  const codes = new Map();
  const log = [];
  const http = async (url, { method = 'GET', body = '' } = {}) => {
    log.push(`${method} ${url}`);
    const u = new URL(url);
    const ok = (o) => ({ status: 200, headers: {}, body: JSON.stringify(o) });
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return ok({ resource: 'https://mcp.test/mcp', authorization_servers: ['https://auth.test'], scopes_supported: ['tools'] });
    if (u.pathname === '/.well-known/oauth-authorization-server') return ok({ issuer: 'https://auth.test', authorization_endpoint: 'https://auth.test/authorize', token_endpoint: 'https://auth.test/token', registration_endpoint: 'https://auth.test/register', code_challenge_methods_supported: ['S256'] });
    if (u.pathname === '/register') return ok({ client_id: 'cid-1', redirect_uris: JSON.parse(body).redirect_uris });
    if (u.pathname === '/token') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        const c = codes.get(p.get('code'));
        if (!c || (await pkceChallenge(p.get('code_verifier'))) !== c.challenge || p.get('resource') !== 'https://mcp.test/mcp') return { status: 400, headers: {}, body: JSON.stringify({ error: 'invalid_grant' }) };
        return ok({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
      }
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'rt-1') return ok({ access_token: 'at-2', expires_in: 3600 });
      return { status: 400, headers: {}, body: '{"error":"invalid_grant"}' };
    }
    return { status: 404, headers: {}, body: '' };
  };
  // the "browser": the user signs in; the server redirects back with a code bound to the PKCE challenge
  const open = async (url) => {
    const u = new URL(url);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('tools');
    codes.set('code-1', { challenge: u.searchParams.get('code_challenge') });
    setTimeout(() => handleRedirect(`${REDIRECT_URI}?code=code-1&state=${u.searchParams.get('state')}`), 5);
  };
  return { http, open, log };
}

describe('MCP sign-in (OAuth + PKCE)', () => {
  it('reads WWW-Authenticate', () => expect(parseWwwAuth('Bearer resource_metadata="https://x/.well-known/oauth-protected-resource", scope="a b"')).toEqual({ resourceMetadata: 'https://x/.well-known/oauth-protected-resource', scope: 'a b' }));
  it('discovers, registers, signs in with PKCE and refreshes', async () => {
    const { http, open, log } = fakeAS();
    const o = await signIn({ url: 'https://mcp.test/mcp' }, { http, open, waitRedirect });
    expect(o).toMatchObject({ access: 'at-1', refresh: 'rt-1', clientId: 'cid-1', issuer: 'https://auth.test', resource: 'https://mcp.test/mcp' });
    expect(log).toContain('POST https://auth.test/register');
    const o2 = await refresh(o, { http });
    expect(o2.access).toBe('at-2');
    expect(o2.refresh).toBe('rt-1'); // kept when the server sends no new one
    // signing in again reuses the registered client
    const again = fakeAS();
    await signIn({ url: 'https://mcp.test/mcp', oauth: o }, { http: again.http, open: again.open, waitRedirect });
    expect(again.log).not.toContain('POST https://auth.test/register');
  });
  it('a callback with the wrong state is refused', async () => {
    const { http } = fakeAS();
    const open = async () => setTimeout(() => handleRedirect(`${REDIRECT_URI}?code=x&state=nope`), 5);
    const p = signIn({ url: 'https://mcp.test/mcp' }, { http, open, waitRedirect: (s) => waitRedirect(s, 200) });
    await expect(p).rejects.toThrow(/timed out/);
  });
});
