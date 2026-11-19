/**
 * Signing in to an MCP server (the MCP authorization spec: OAuth 2.1 with PKCE).
 *   1. The server answers 401 with WWW-Authenticate: Bearer resource_metadata="…" (or we look at
 *      /.well-known/oauth-protected-resource), which names its authorization server.
 *   2. That server's metadata (/.well-known/oauth-authorization-server, or OpenID's) gives the endpoints.
 *   3. The app registers itself (dynamic client registration) unless you gave a client id.
 *   4. The sign-in page opens in the phone's browser (Custom Tabs); it comes back to
 *      dev.chronicle.app://oauth/callback with a code, which is swapped for tokens (PKCE S256, resource = the server).
 *   5. The access token is sent as Bearer; it is refreshed when it runs out or a request gets 401.
 */
export const REDIRECT_URI = 'dev.chronicle.app://oauth/callback';

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function randomString(n = 64) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a).slice(0, n);
}
export async function pkceChallenge(verifier) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

/** WWW-Authenticate: Bearer resource_metadata="…", scope="…" → { resourceMetadata, scope } */
export function parseWwwAuth(h) {
  const out = {};
  for (const m of String(h || '').matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return { resourceMetadata: out.resource_metadata || '', scope: out.scope || '' };
}

const json = (r, what) => {
  if (r.status >= 400) throw new Error(`${what}: HTTP ${r.status}`);
  try {
    return JSON.parse(r.body);
  } catch {
    throw new Error(`${what}: not JSON`);
  }
};
/** The well-known URLs for an issuer, path-aware (RFC 8414 puts the path after the well-known part). */
function wellKnown(issuer, name) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, '');
  return path && path !== '/' ? [`${u.origin}/.well-known/${name}${path}`, `${u.origin}${path}/.well-known/${name}`, `${u.origin}/.well-known/${name}`] : [`${u.origin}/.well-known/${name}`];
}
async function firstJson(http, urls, what) {
  let err;
  for (const url of urls) {
    try {
      const r = await http(url, { method: 'GET', headers: { Accept: 'application/json' } });
      if (r.status < 400) return json(r, what);
      err = new Error(`${what}: HTTP ${r.status}`);
    } catch (e) {
      err = e;
    }
  }
  throw err || new Error(`${what}: not found`);
}

/** → { issuer, authorization_endpoint, token_endpoint, registration_endpoint, scope, resource } */
export async function discover(server, { http, wwwAuth = '' }) {
  const w = parseWwwAuth(wwwAuth);
  let prm = null;
  try {
    prm = await firstJson(http, w.resourceMetadata ? [w.resourceMetadata] : wellKnown(server.url, 'oauth-protected-resource'), 'Protected resource metadata');
  } catch {
    /* older servers: the MCP server is its own authorization server */
  }
  const issuer = prm?.authorization_servers?.[0] || new URL(server.url).origin;
  const as = await firstJson(http, [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')], 'Authorization server metadata');
  if (!as.authorization_endpoint || !as.token_endpoint) throw new Error('The authorization server does not list its endpoints');
  if (as.code_challenge_methods_supported && !as.code_challenge_methods_supported.includes('S256')) throw new Error('The authorization server does not support PKCE (S256)');
  return { issuer, authorization_endpoint: as.authorization_endpoint, token_endpoint: as.token_endpoint, registration_endpoint: as.registration_endpoint || '', scope: w.scope || (prm?.scopes_supported || []).join(' '), resource: prm?.resource || server.url };
}

async function register(meta, { http, clientName = 'Chronicle' }) {
  if (!meta.registration_endpoint) throw new Error('This server does not let apps register themselves – add a client id in the server settings');
  const r = await http(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  const j = json(r, 'Client registration');
  if (!j.client_id) throw new Error('Client registration gave no client id');
  return j.client_id;
}

const form = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
async function tokenRequest(http, endpoint, params) {
  const r = await http(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form(params) });
  const j = (() => {
    try {
      return JSON.parse(r.body);
    } catch {
      return {};
    }
  })();
  if (r.status >= 400 || !j.access_token) throw new Error(`Sign-in failed: ${j.error_description || j.error || 'HTTP ' + r.status}`);
  return j;
}
const keep = (j, old = {}, now = Date.now()) => ({ ...old, access: j.access_token, refresh: j.refresh_token || old.refresh || '', expiresAt: j.expires_in ? now + Number(j.expires_in) * 1000 : 0 });

/**
 * The whole sign-in. deps: http(url, opts) → {status, headers, body}; open(url) shows the page;
 * waitRedirect(state) → resolves the callback URL. → server.oauth to store.
 */
export async function signIn(server, { http, open, waitRedirect, wwwAuth = '' }) {
  const meta = await discover(server, { http, wwwAuth });
  const clientId = server.oauthClientId || (server.oauth?.issuer === meta.issuer && server.oauth?.clientId) || (await register(meta, { http }));
  const verifier = randomString(64);
  const state = randomString(24);
  const q = form({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', state, scope: meta.scope, resource: meta.resource });
  const back = waitRedirect(state);
  await open(`${meta.authorization_endpoint}${meta.authorization_endpoint.includes('?') ? '&' : '?'}${q}`);
  const cb = new URL(await back);
  if (cb.searchParams.get('state') !== state) throw new Error('Sign-in came back for another request');
  if (cb.searchParams.get('error')) throw new Error(`Sign-in refused: ${cb.searchParams.get('error_description') || cb.searchParams.get('error')}`);
  const code = cb.searchParams.get('code');
  if (!code) throw new Error('Sign-in came back without a code');
  const j = await tokenRequest(http, meta.token_endpoint, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: meta.resource });
  return keep(j, { issuer: meta.issuer, clientId, tokenEndpoint: meta.token_endpoint, resource: meta.resource });
}

/** A new access token from the refresh token. → the updated server.oauth (throws when it can't). */
export async function refresh(oauth, { http }) {
  if (!oauth?.refresh) throw new Error('Signed out – sign in again');
  const j = await tokenRequest(http, oauth.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: oauth.refresh, client_id: oauth.clientId, resource: oauth.resource });
  return keep(j, oauth);
}

/** Is the token about to run out (a minute's margin)? */
export const expiring = (oauth, now = Date.now()) => !!oauth?.expiresAt && oauth.expiresAt - now < 60_000;

// ---------- the redirect: the browser comes back to the app with ?code=…&state=… ----------
const waiting = new Map(); // state → resolve
export function waitRedirect(state, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (waiting.delete(state), reject(new Error('Sign-in timed out'))), timeoutMs);
    waiting.set(state, (url) => (clearTimeout(t), resolve(url)));
  });
}
/** A deep link: if it is an OAuth callback, hand it to the sign-in waiting for it. → true when handled. */
export function handleRedirect(url) {
  if (!String(url).startsWith(REDIRECT_URI)) return false;
  let st = '';
  try {
    st = new URL(url).searchParams.get('state') || '';
  } catch {
    return false;
  }
  const fn = waiting.get(st);
  if (!fn) return true; // a stale one: nothing is waiting, but it is ours
  waiting.delete(st);
  fn(url);
  return true;
}
