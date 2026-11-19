// Minimal MCP client for remote servers (Streamable HTTP transport): initialize → tools/list → tools/call.
// On Android requests go through native HTTP, so servers don't need CORS.
import { noteMcpTool } from './mcphints.js';
import { httpRequest } from './api.js';
import { refresh as refreshToken, expiring } from './mcpauth.js';
import { isStdio, bridgeUrl, ensureBridge } from './mcpstdio.js';

let saveAuth = () => {};
/** How a refreshed sign-in is stored (the settings). */
export const setAuthSaver = (fn) => (saveAuth = fn);
async function renewToken(server) {
  server.oauth = await refreshToken(server.oauth, { http: httpRequest });
  saveAuth(server);
}

const PROTOCOL = '2025-06-18';
const sessions = new Map(); // serverId -> { sessionId, tools, at }
let rpcId = 1;

export const slug = (s) => String(s || 'server').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'server';

/** "Name: value" lines (or a JSON object) → { name: value }. Anything that is not a valid header name is ignored. */
export function parseHeaders(text) {
  const out = {};
  const t = String(text || '').trim();
  if (!t) return out;
  try {
    const j = JSON.parse(t);
    if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) if (/^[A-Za-z0-9-]+$/.test(k)) out[k] = String(v);
    return out;
  } catch {
    /* lines */
  }
  for (const line of t.split('\n')) {
    const i = line.indexOf(':');
    const k = line.slice(0, i).trim();
    if (i > 0 && /^[A-Za-z0-9-]+$/.test(k)) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

function parseRpc(body, id) {
  const lines = body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  const msgs = (lines.length ? lines : [body]).map((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  });
  return msgs.find((m) => m && m.id === id) || msgs.reverse().find((m) => m && (m.result || m.error));
}

async function rpc(server, method, params, opts = {}) {
  if (!isStdio(server)) return rpcHttp(server, method, params, opts);
  // a stdio server: through its bridge in the app's Linux (started on first use, and again if it has stopped)
  const via = { ...server, url: bridgeUrl(server), token: server.bridgeSecret, oauth: null, headers: '' };
  if (!bridged.has(server.id)) {
    await ensureBridge(server);
    bridged.add(server.id);
  }
  try {
    return await rpcHttp(via, method, params, opts);
  } catch (e) {
    if (e.retry || opts.restarted || !/fetch|network|refused|timed out|HTTP 50[34]|Failed/i.test(String(e.message))) throw e;
    bridged.delete(server.id);
    sessions.delete(server.id);
    await ensureBridge(server);
    bridged.add(server.id);
    if (method !== 'initialize') await connect(server); // a new process: it has to be initialised again
    return rpcHttp(via, method, params, { ...opts, restarted: true });
  }
}
const bridged = new Set();

async function rpcHttp(server, method, params, { notify = false, renewed = false } = {}) {
  if (server.oauth?.access && expiring(server.oauth) && server.oauth.refresh) await renewToken(server).catch(() => {});
  const st = sessions.get(server.id) || {};
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL };
  for (const [k, v] of Object.entries(parseHeaders(server.headers))) headers[k] = v; // extra headers (API keys, custom auth)
  if (server.token) headers.Authorization = /^bearer\s/i.test(server.token) ? server.token : `Bearer ${server.token}`;
  if (server.oauth?.access) headers.Authorization = `Bearer ${server.oauth.access}`; // signed in (OAuth)
  if (st.sessionId) headers['Mcp-Session-Id'] = st.sessionId;
  const id = notify ? undefined : rpcId++;
  const r = await httpRequest(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, ...(params ? { params } : {}) }), timeoutMs: method === 'tools/call' ? 45000 : 15000 });
  if (r.headers['mcp-session-id']) sessions.set(server.id, { ...st, sessionId: r.headers['mcp-session-id'] });
  if (notify) return null;
  if (r.status === 401 && server.oauth?.refresh && !renewed) {
    // the token ran out early: renew it once and ask again
    const ok = await renewToken(server).then(() => true, () => false);
    if (ok) return rpcHttp(server, method, params, { notify, renewed: true });
  }
  if (r.status === 401 || r.status === 403) {
    const wwwAuth = r.headers['www-authenticate'] || '';
    const oauthy = r.status === 401 && (/bearer/i.test(wwwAuth) || !server.token);
    throw Object.assign(new Error(oauthy ? `${server.name}: needs you to sign in (Settings › MCP servers › Sign in)` : `${server.name}: not authorized (HTTP ${r.status}) – check the token`), { needsAuth: oauthy, wwwAuth });
  }
  if (r.status === 404 && st.sessionId) {
    sessions.delete(server.id); // session expired → start over once
    throw Object.assign(new Error('session expired'), { retry: true });
  }
  if (r.status >= 400) throw new Error(`${server.name}: HTTP ${r.status} ${r.body.slice(0, 200)}`);
  const msg = parseRpc(r.body, id);
  if (!msg) throw new Error(`${server.name}: unexpected response`);
  if (msg.error) throw new Error(`${server.name}: ${msg.error.message || JSON.stringify(msg.error)}`);
  return msg.result;
}

async function connect(server) {
  await rpc(server, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'chronicle', version: '1.1' } });
  await rpc(server, 'notifications/initialized', null, { notify: true }).catch(() => {});
}

const FRESH = 10 * 60 * 1000;
const FAIL_PAUSE = 2 * 60 * 1000;
const failed = new Map(); // serverId -> { at, message }: a server that just failed is not retried on every message
const refreshing = new Map();
const KEY = 'ocm.mcpTools';
const loadSaved = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
};
const saveTools = (id, tools) => {
  try {
    const all = loadSaved();
    all[id] = { tools, at: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
};
/** Tools remembered for a server (this run, or an earlier one), however old – or null. */
export function cachedTools(server) {
  const st = sessions.get(server.id);
  if (st?.tools) return { tools: st.tools, at: st.at };
  const saved = loadSaved()[server.id];
  return saved?.tools ? saved : null;
}
/** True when an enabled server has no remembered tool list yet, so the first message has to wait for it. */
export const needsConnect = (servers) => servers.some((s) => s.enabled !== false && (s.url || isStdio(s)) && !cachedTools(s));

/** List a server's tools. A remembered list is used at once (and refreshed in the background when old). */
export async function listTools(server, { force = false } = {}) {
  const c = force ? null : cachedTools(server);
  if (c) {
    if (Date.now() - c.at >= FRESH && !refreshing.has(server.id) && !(failed.get(server.id) && Date.now() - failed.get(server.id).at < FAIL_PAUSE)) {
      const job = fetchTools(server).catch(() => {}).finally(() => refreshing.delete(server.id));
      refreshing.set(server.id, job);
    }
    return c.tools;
  }
  const f = failed.get(server.id);
  if (!force && f && Date.now() - f.at < FAIL_PAUSE) throw new Error(f.message);
  return fetchTools(server, force);
}

async function fetchTools(server, force = false) {
  if (force) sessions.delete(server.id);
  try {
    await connect(server);
    const tools = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const res = await rpc(server, 'tools/list', cursor ? { cursor } : {});
      tools.push(...(res.tools || []));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    sessions.set(server.id, { ...(sessions.get(server.id) || {}), tools, at: Date.now() });
    saveTools(server.id, tools);
    failed.delete(server.id);
    return tools;
  } catch (e) {
    failed.set(server.id, { at: Date.now(), message: e.message });
    throw e;
  }
}

export async function callTool(server, name, args) {
  const go = () => rpc(server, 'tools/call', { name, arguments: args || {} });
  let res;
  try {
    if (!sessions.get(server.id)?.sessionId) await connect(server);
    res = await go();
  } catch (e) {
    if (!e.retry) throw e;
    await connect(server);
    res = await go();
  }
  // pictures in the result (a screenshot, a chart) are kept for the model to see (decision 201): at most 4, 4 MB each
  const images = [];
  const parts = (res.content || []).map((c) => {
    if (c.type === 'image' && typeof c.data === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(c.mimeType || '') && c.data.length < 4e6 && images.length < 4) {
      images.push({ path: `${name} picture ${images.length + 1}`, url: `data:${c.mimeType};base64,${c.data}` });
      return `[picture ${images.length} – shown to you after this result]`;
    }
    return c.type === 'text' ? c.text : c.type === 'resource' ? c.resource?.text || `[resource ${c.resource?.uri}]` : `[${c.type}]`;
  });
  if (res.structuredContent && !parts.length) parts.push(JSON.stringify(res.structuredContent));
  return { text: parts.join('\n') || '(no content)', isError: !!res.isError, images };
}

/** OpenAI tool definitions for all enabled servers. Returns { defs, route: name → {server, tool} , errors }. */
export async function mcpToolDefs(servers, { force = false } = {}) {
  const defs = [];
  const route = {};
  const errors = [];
  await Promise.all(
    servers
      .filter((s) => s.enabled !== false && (s.url || isStdio(s)))
      .map(async (s) => {
        try {
          const tools = await listTools(s, { force });
          for (const t of tools) {
            if ((s.disabledTools || []).includes(t.name)) continue; // switched off in the server's tool list
            const name = `mcp_${slug(s.name)}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
            route[name] = { server: s, tool: t.name };
            noteMcpTool(name, t.annotations, s.trusted === true);
            const schema = t.inputSchema && typeof t.inputSchema === 'object' ? { ...t.inputSchema } : { type: 'object', properties: {} };
            delete schema.$schema;
            if (schema.type !== 'object') schema.type = 'object';
            schema.properties ||= {};
            defs.push({ type: 'function', function: { name, description: `[${s.name}] ${(t.description || t.title || t.name).slice(0, 900)}`, parameters: schema } });
          }
        } catch (e) {
          errors.push(e.message);
        }
      }),
  );
  return { defs, route, errors };
}

/**
 * Connect to every enabled server again, now, and say what came back. Used by the reload_tools tool:
 * registration is per session, so a server the user just switched on is otherwise invisible until a
 * new chat starts - which is what made the enable button look broken.
 */
export async function reloadTools(servers) {
  const list = (servers || []).filter((s) => s.enabled !== false && (s.url || isStdio(s)));
  if (!list.length) return { servers: [], errors: [], defs: [], route: {}, text: 'No MCP servers are enabled, so there is nothing to load. Add one in Settings → MCP servers.' };
  const out = await mcpToolDefs(list, { force: true });
  const lines = list.map((s) => {
    const err = out.errors.find((e) => String(e).includes(s.name));
    const tools = (cachedTools(s)?.tools || []).filter((t) => !(s.disabledTools || []).includes(t.name));
    if (err) return s.name + ': FAILED - ' + String(err).replace(s.name + ': ', '');
    return s.name + ': ' + tools.length + ' tool' + (tools.length === 1 ? '' : 's') + (tools.length ? ' (' + tools.map((t) => t.name).slice(0, 10).join(', ') + ')' : '');
  });
  return { servers: list.map((s) => s.name), errors: out.errors, defs: out.defs, route: out.route, text: lines.join('\n') };
}
