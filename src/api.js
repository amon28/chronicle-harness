// OpenCode Go API client.
// On Android (Capacitor) requests go through the native GoStream plugin, which
// streams over HttpURLConnection and so isn't subject to browser CORS rules.
// In a plain browser, requests go to an optional proxy (see /proxy).
import { bridgeBytes } from './bridgebytes.js';
import { modelAbilities } from './modelcaps.js';
import { Capacitor, registerPlugin, CapacitorHttp } from '@capacitor/core';
import { recordUsage, chatIdOf, sourceOf } from './usage.js';
import { isLocalModel, localModels, streamLocal } from './localllm.js';
import { ANTHROPIC_BASE, ANTHROPIC_DEFAULT_MODEL, anthropicBase, anthropicModel, anthropicParams, goStreamFetch, listAnthropicModels, runAnthropicStream, describeAnthropicError } from './anthropic.js';

export const GO_BASE = import.meta.env.VITE_GO_BASE || 'https://opencode.ai/inference/go';
const CHAT_PATH = '/openai/v1/chat/completions';
const MODELS_PATH = '/v1/models';
// Same usage endpoint the opencode CLI polls for the Go allowance meters.
const USAGE_URL = import.meta.env.VITE_GO_USAGE_URL || 'https://opencode.ai/zen/go/v1/usage';
const CLIENT_NAME = 'chronicle';
const USER_AGENT = `${CLIENT_NAME}/1.1 (Android)`;

const isNative = Capacitor.isNativePlatform();
const GoStream = isNative ? registerPlugin('GoStream') : null;

export const needsProxy = !isNative;

function baseUrl(settings) {
  if (!isNative && settings.proxyUrl) return settings.proxyUrl.replace(/\/+$/, '');
  return GO_BASE;
}

// Mirrors the session headers the opencode CLI sends with every model request
// (x-opencode-session routes the request + enables prompt caching on Go).
function headers(settings, sessionId) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${settings.apiKey}`,
    'x-opencode-session': sessionId,
  };
  if (isNative) {
    Object.assign(h, {
      'User-Agent': USER_AGENT,
      'x-opencode-client': CLIENT_NAME,
      'x-opencode-session-id': sessionId,
      'x-session-affinity': sessionId,
    });
  } else h['x-client'] = USER_AGENT;
  return h;
}

/**
 * OpenCode Go allowance: { rolling, weekly, monthly } each { percent, limited, resetsAt(ms) },
 * or null if the key can't see usage (403).
 */
export async function getUsage(settings) {
  if (!settings.apiKey) return null;
  const h = { Authorization: `Bearer ${settings.apiKey}` };
  // The opencode CLI sends the Console workspace (org) id with this request.
  if (settings.workspaceId) h['x-opencode-org-id'] = settings.workspaceId;
  // This endpoint doesn't answer CORS preflights, so on Android it must go through native HTTP.
  const url = globalThis.__ocmUsageUrl || USAGE_URL; // tests point it at the mock server
  const res = isNative ? await nativeGet(url, { ...h, 'User-Agent': USER_AGENT }) : await webGet(url, h);
  if (res.status === 403) return null;
  if (res.status >= 400) throw new Error(describeError(res.status, res.body));
  const { usage } = JSON.parse(res.body);
  const meter = (m) =>
    m && {
      percent: Number(m.percent) || 0,
      limited: m.status === 'rate-limited',
      resetsAt: typeof m.resetsAt === 'number' ? (m.resetsAt < 1e12 ? m.resetsAt * 1000 : m.resetsAt) : Date.parse(m.resetsAt),
    };
  return usage ? { rolling: meter(usage.rolling), weekly: meter(usage.weekly), monthly: meter(usage.monthly) } : null;
}

// OpenCode Zen (pay-as-you-go) also lists free models – e.g. "Crouton Alpha Free" – that aren't in the
// Go list. They're served from Zen's own endpoint; the app routes requests per model.
const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const ZEN_CHAT_BASE = 'https://opencode.ai/inference/openai/v1';
const modelRoutes = {}; // model id -> chat completions base URL (Zen) or { provider, apiModel } (custom endpoints)
let providersById = {};
export function setModelRoutes(models, providers) {
  if (providers) providersById = Object.fromEntries(providers.map((p) => [p.id, p]));
  for (const k of Object.keys(modelRoutes)) delete modelRoutes[k];
  for (const m of models || []) {
    if (m.source === 'zen') modelRoutes[m.id] = m.api?.['chat-completions']?.base_url || ZEN_CHAT_BASE;
    else if (m.source === 'custom') modelRoutes[m.id] = { providerId: m.providerId, apiModel: m.apiModel, ...(m.anthropic ? { anthropic: m.anthropic } : {}) };
  }
}

// ---------- custom OpenAI-compatible endpoints (e.g. Chub's https://inference.chub.ai/soji/v1) ----------
export const PROVIDER_PRESETS = {
  // Chub sits behind Cloudflare, which rejects the native HTTP client; its API allows browser (CORS) requests,
  // so it goes through the WebView's own fetch (a real Chrome), with only the CH-API-KEY header.
  chub: { name: 'Chub (Soji)', baseUrl: 'https://inference.chub.ai/soji/v1', auth: 'ch-api-key', via: 'browser', models: 'soji', context: 32768, tools: false },
  openai: { name: 'OpenAI-compatible', baseUrl: 'https://', auth: 'bearer', via: 'native', models: '', context: 32768, tools: true },
  // Claude with the user's own API key from platform.claude.com (decision 164) – through the official SDK, not the
  // OpenAI-compatible path. "models" is only the fallback when the live list (client.models.list()) can't be read.
  anthropic: { kind: 'anthropic', name: 'Anthropic (Claude)', baseUrl: ANTHROPIC_BASE, via: 'native', models: ANTHROPIC_DEFAULT_MODEL, context: 1000000, tools: true, vision: true },
};
export const isAnthropic = (p) => p?.kind === 'anthropic';

/** The SDK client for an Anthropic provider (the SDK is loaded the first time Claude is used). */
async function anthropicClient(p) {
  const mod = await import('@anthropic-ai/sdk');
  const A = mod.default;
  if (!p.apiKey) throw new Error('Add your Anthropic API key (from platform.claude.com › API keys) in Settings › Custom endpoints › Anthropic (Claude).');
  // Android: through the native GoStream plugin like every other provider (background-safe, no CORS);
  // the web build: the browser's fetch (Anthropic answers CORS for direct browser access)
  const native = isNative && p.via !== 'browser';
  const client = new A({
    apiKey: p.apiKey,
    authToken: null,
    baseURL: anthropicBase(p.baseUrl),
    dangerouslyAllowBrowser: true, // the key is the user's own and stays on this phone
    fetch: native ? goStreamFetch(GoStream) : (url, init) => globalThis.fetch(url, init),
  });
  return { A, client };
}

export function providerHeaders(p) {
  const h = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
  if (p.apiKey) {
    if (p.auth === 'ch-api-key' || p.auth === 'both-chub') h['CH-API-KEY'] = p.apiKey;
    if (p.auth === 'x-api-key') h['x-api-key'] = p.apiKey;
    if (p.auth === 'bearer' || p.auth === 'both-chub' || !p.auth) h.Authorization = `Bearer ${p.apiKey}`;
  }
  if (isNative && p.via !== 'browser') h['User-Agent'] = USER_AGENT;
  return h;
}
const viaBrowser = (p) => !isNative || p?.via === 'browser';
async function providerGet(p, url) {
  if (!viaBrowser(p)) return httpGet(url, providerHeaders(p), 15000);
  const { Accept, ...h } = providerHeaders(p);
  delete h['Content-Type'];
  const r = await fetch(url, { headers: h });
  return { status: r.status, body: await r.text() };
}
const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

/**
 * What is left on an endpoint that says so (decision 195): DeepSeek's balance (GET {origin}/user/balance – its API has
 * no usage history; that is on platform.deepseek.com). → { text, available } for the Settings row, or null when the
 * endpoint has no such call.
 */
export const hasBalance = (p) => {
  try {
    return /(^|\.)deepseek\.com$/i.test(new URL(String(p?.baseUrl || '')).hostname);
  } catch {
    return false;
  }
};
export async function providerBalance(p) {
  if (!hasBalance(p)) return null;
  const r = await providerGet(p, new URL(p.baseUrl).origin + '/user/balance');
  if (r.status >= 400) throw new Error(describeError(r.status, r.body));
  const j = JSON.parse(r.body || '{}');
  const sign = { USD: '$', CNY: '¥' };
  const money = (cur, v) => `${sign[cur] ?? (cur ? cur + ' ' : '')}${(Number(v) || 0).toFixed(2)}`;
  const parts = (j.balance_infos || []).map((b) => `${money(b.currency, b.total_balance)} left` + (Number(b.granted_balance) > 0 ? ` (${money(b.currency, b.granted_balance)} of it granted)` : ''));
  return { text: parts.join(', ') || 'no balance', available: j.is_available !== false };
}

/**
 * What a Claude endpoint has spent (decision 208), from Anthropic's Usage and Cost Analytics API with the Admin key
 * the user added (an ordinary API key cannot read it – nor can any key read the credit balance). Daily buckets from
 * the start of this month (UTC), by model. Anthropic's figures run 4–24 h behind and are before credits.
 * → { today, week, month, monthName, models: [[name, dollars]], refreshed } or null without an Admin key.
 */
export const hasSpend = (p) => isAnthropic(p) && !!String(p?.adminKey || '').trim();
export const COST_BETA = 'analytics-usage-cost-2026-08-24';
export function sumSpend(rows, now = Date.now()) {
  const day = (t) => Math.floor(Date.parse(t) / 86400000);
  const today = Math.floor(now / 86400000);
  let todayC = 0;
  let week = 0;
  let month = 0;
  const byModel = new Map();
  for (const r of rows || []) {
    const cents = Number(r?.cost?.amount) || 0;
    const d = day(r.starting_at);
    month += cents;
    if (d >= today - 6) week += cents;
    if (d === today) todayC += cents;
    const m = r?.group?.model || 'other';
    byModel.set(m, (byModel.get(m) || 0) + cents);
  }
  const $ = (c) => c / 100;
  return { today: $(todayC), week: $(week), month: $(month), models: [...byModel].sort((a, b) => b[1] - a[1]).map(([m, c]) => [m, $(c)]) };
}
export async function providerSpend(p, now = new Date()) {
  if (!hasSpend(p)) return null;
  const base = anthropicBase(p.baseUrl);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const headers = { 'x-api-key': String(p.adminKey).trim(), 'anthropic-version': '2026-10-21', 'anthropic-beta': COST_BETA };
  const rows = [];
  let refreshed = null;
  let page = '';
  for (let i = 0; i < 10; i++) {
    const q = `starting_at=${encodeURIComponent(iso(start))}&ending_at=${encodeURIComponent(iso(tomorrow))}&time_bucket_width=1d&group_by[]=model&order_by=time&limit=1000${page ? `&page=${encodeURIComponent(page)}` : ''}`;
    const r = await httpGet(`${base}/v1/organizations/analytics/cost?${q}`, headers, 20000);
    if (r.status === 401 || r.status === 403) throw new Error(`Anthropic did not accept the Admin key (HTTP ${r.status}) – it must be an Admin API key (sk-ant-admin…), not an ordinary one`);
    if (r.status >= 400) throw new Error(describeError(r.status, r.body));
    const j = JSON.parse(r.body || '{}');
    rows.push(...(j.data || []));
    refreshed = j.data_refreshed_at || refreshed;
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  return { ...sumSpend(rows, now.getTime()), monthName: now.toLocaleString(undefined, { month: 'long', timeZone: 'UTC' }), refreshed };
}

/** Models offered by a custom endpoint: GET {base}/models, plus any model names typed in by the user. */
export async function listProviderModels(p) {
  if (isAnthropic(p)) return listAnthropicProvider(p);
  const manual = String(p.models || '').split(',').map((x) => x.trim()).filter(Boolean);
  let fetched = [];
  let error = null;
  try {
    const r = await providerGet(p, trimBase(p.baseUrl) + '/models');
    if (r.status >= 400) throw new Error(describeError(r.status, r.body));
    const j = JSON.parse(r.body);
    fetched = (j.data || j.models || []).map((m) => (typeof m === 'string' ? { id: m } : m)).filter((m) => m.id);
  } catch (e) {
    error = e.message;
  }
  const seen = new Set();
  const list = [...fetched, ...manual.map((id) => ({ id }))].filter((m) => !seen.has(m.id) && seen.add(m.id));
  return {
    error,
    models: list.map((m) => {
      // each model's own abilities when the provider lists them (OpenRouter, Mistral, models.dev…), else the provider's switches
      const a = modelAbilities(m, p);
      return {
        id: `${p.id}:${m.id}`,
        apiModel: m.id,
        name: `${m.name || m.id}`,
        source: 'custom',
        providerId: p.id,
        providerName: p.name,
        description: m.description || `${p.name} · ${m.id}`,
        limit: { context: a.context, output: a.output },
        capabilities: { tools: { supported: a.tools }, reasoning: { supported: a.reasoning } },
        modalities: { input: a.vision ? ['text', 'image/jpeg', 'image/png'] : ['text'] },
        // the price the provider lists (OpenRouter's pricing) – usage priced these at $0 before (decision 275)
        ...(a.cost ? { cost: a.cost } : {}),
        type: 'chat',
      };
    }),
  };
}

async function listAnthropicProvider(p) {
  let fetched = [];
  let error = null;
  let A = null;
  try {
    const c = await anthropicClient(p);
    A = c.A;
    fetched = await listAnthropicModels(c.client, p);
  } catch (e) {
    error = describeAnthropicError(e, A);
  }
  // a model name typed in (or the default) when the list can't be read; without capability data it is
  // assumed to take adaptive thinking and every effort level
  const have = new Set(fetched.map((m) => m.apiModel));
  const manual = String(p.models || '').split(',').map((x) => x.trim()).filter((id) => id && !have.has(id));
  return { error, models: [...fetched, ...(error ? manual.map((id) => anthropicModel(p, { id })) : [])] };
}

const isFreeModel = (m) => m?.cost?.text?.input?.price === 0 && (m?.cost?.text?.output?.price ?? 0) === 0;

async function listZenFree(settings) {
  // the list is public; sending a Go key here can be rejected ("Invalid credential")
  const res = await fetch(ZEN_MODELS_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || []).filter((m) => (!m.type || m.type === 'chat') && isFreeModel(m) && m.api?.['chat-completions']);
}

/** Go models, plus (optionally) OpenCode Zen's free models that Go doesn't list. */
export async function listModels(settings) {
  const providers = (settings.providers || []).filter((p) => p.enabled !== false && p.baseUrl);
  const [go, zen, ...custom] = await Promise.allSettled([
    settings.apiKey ? listGoModels(settings) : Promise.resolve([]),
    settings.prefs?.zenFree !== true ? Promise.resolve([]) : listZenFree(settings),
    ...providers.map((p) => listProviderModels(p)),
  ]);
  const local = localModels(settings.prefs?.localModel);
  if (go.status === 'rejected' && !local.length && !custom.some((c) => c.status === 'fulfilled' && c.value.models.length)) throw go.reason;
  const goList = go.status === 'fulfilled' ? go.value : [];
  const ids = new Set(goList.map((m) => m.id));
  const extra = zen.status === 'fulfilled' ? zen.value.filter((m) => !ids.has(m.id)).map((m) => ({ ...m, source: 'zen' })) : [];
  const customModels = custom.flatMap((c) => (c.status === 'fulfilled' ? c.value.models : []));
  const all = [...goList, ...extra, ...customModels, ...local];
  setModelRoutes(all, settings.providers || []);
  // OpenCode's list did not come (no connection yet after a start, a timeout) while another provider's did (decision
  // 193): the caller must not take this for the whole list – OpenCode's models did not go away
  if (settings.apiKey && go.status === 'rejected') all.goFailed = String(go.reason?.message || go.reason || 'failed');
  // …and the same for each custom provider that did not answer this time: its models are not gone either
  all.failedProviders = providers.filter((p, i) => custom[i].status === 'rejected' || custom[i].value?.error).map((p) => p.id);
  return all;
}

async function listGoModels(settings) {
  const url = baseUrl(settings) + MODELS_PATH;
  // The models endpoint allows CORS, so try it directly first in the browser.
  const tryUrls = isNative || !settings.proxyUrl ? [GO_BASE + MODELS_PATH] : [url, GO_BASE + MODELS_PATH];
  let lastErr;
  for (const u of tryUrls) {
    try {
      const res = await fetch(u, { headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return (json.data || []).filter((m) => !m.type || m.type === 'chat');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Any request (used for MCP). Android: native HTTP (no CORS). Resolves { status, headers, body }.
 */
export function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  if (!isNative) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, { method, headers, body, signal: ctrl.signal })
      .then(async (r) => ({ status: r.status, headers: Object.fromEntries([...r.headers].map(([k, v]) => [k.toLowerCase(), v])), body: await r.text() }))
      .finally(() => clearTimeout(t));
  }
  return new Promise((resolve, reject) => {
    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let out = '';
    let meta = { status: 0, headers: {} };
    const subs = [];
    const cleanup = () => subs.forEach((s) => s.then((h) => h.remove()));
    const timer = setTimeout(() => end(() => reject(new Error('Request timed out'))), timeoutMs);
    function end(fn) {
      clearTimeout(timer);
      cleanup();
      fn();
    }
    subs.push(GoStream.addListener('response', (e) => e.id === id && (meta = { status: e.status, headers: e.headers || {} })));
    subs.push(GoStream.addListener('chunk', (e) => e.id === id && (out += e.data)));
    subs.push(GoStream.addListener('done', (e) => e.id === id && end(() => resolve({ ...meta, body: out }))));
    subs.push(GoStream.addListener('error', (e) => e.id === id && end(() => (e.status ? resolve({ status: e.status, headers: {}, body: e.body || '' }) : reject(new Error(e.message || 'Network error'))))));
    const h = { ...headers };
    if (method !== 'GET' && method !== 'POST') h['X-Http-Method'] = method;
    Promise.all(subs)
      .then(() => GoStream.start({ id, url, headers: h, body: body ?? (method === 'POST' ? '' : undefined) }))
      .catch((err) => end(() => reject(err)));
  });
}

/** One request with a binary body and answer (git). → { status, headers, body: Uint8Array } */
export async function bytesRequest({ url, method = 'GET', headers = {}, body = null, guard = false, lanAllow = [] }) {
  if (!isNative) {
    const r = await fetch(url, { method, headers, body });
    return { status: r.status, headers: Object.fromEntries([...r.headers].map(([k, v]) => [k.toLowerCase(), v])), body: new Uint8Array(await r.arrayBuffer()) };
  }
  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const r = await GoStream.fetchBytes({ url, method, headers, ...(body ? { bodyB64: b64(body) } : {}), ...(guard ? { guard: true } : {}), ...(lanAllow.length ? { lanAllow } : {}) });
  return { status: r.status, headers: r.headers || {}, body: await bridgeBytes(r, { b64Key: 'bodyB64', pathKey: 'bodyPath' }) }; // a big answer comes as a file
}

/** GET any URL. Android: native HTTP (no CORS, custom User-Agent). Browser: fetch (CORS applies). */
export function httpGet(url, headers = {}, timeoutMs = 20000, { lanAllow = [] } = {}) {
  if (isNative) return nativeGet(url, headers, timeoutMs, lanAllow);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const { 'User-Agent': _ua, ...h } = headers; // browsers don't allow setting it
  return fetch(url, { headers: h, signal: ctrl.signal })
    .then(async (r) => ({ status: r.status, body: await r.text() }))
    .finally(() => clearTimeout(t));
}
export const canFetchAnySite = isNative;

async function webGet(url, headers) {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.text() };
}

/** Plain GET through the native GoStream plugin (no CORS). Resolves { status, body }. */
function nativeGet(url, headers, timeoutMs = 20000, lanAllow = []) {
  return new Promise((resolve, reject) => {
    const id = `get-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let body = '';
    const subs = [];
    const cleanup = () => subs.forEach((s) => s.then((h) => h.remove()));
    const timer = setTimeout(() => {
      cleanup();
      GoStream.cancel({ id }).catch(() => {});
      reject(new Error('Request timed out'));
    }, timeoutMs);
    const end = (fn) => {
      clearTimeout(timer);
      cleanup();
      fn();
    };
    subs.push(GoStream.addListener('chunk', (e) => e.id === id && (body += e.data)));
    subs.push(GoStream.addListener('done', (e) => e.id === id && end(() => resolve({ status: 200, body }))));
    subs.push(
      GoStream.addListener('error', (e) => {
        if (e.id !== id) return;
        end(() => (e.status ? resolve({ status: e.status, body: e.body || '' }) : reject(new Error(e.message || 'Network error'))));
      }),
    );
    Promise.all(subs)
      .then(() => GoStream.start({ id, url, headers, guard: true, ...(lanAllow.length ? { lanAllow } : {}) }))
      .catch((err) => end(() => reject(err)));
  });
}

/** Incremental SSE parser. Calls onEvent(dataString) for each `data:` event. */
function sseParser(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) onEvent(data);
    }
  };
}

function describeError(status, body) {
  // HTML error pages (Cloudflare & co.): show the page title / heading instead of raw markup
  if (/^\s*<(!doctype|html)/i.test(body || '')) {
    const pick = (re) => (body.match(re)?.[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const h = pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || pick(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const cf = /cloudflare|cf-ray|challenge-platform|Attention Required/i.test(body);
    return `HTTP ${status} – ${[title, h && h !== title ? h : ''].filter(Boolean).join(': ') || 'HTML error page'}${cf ? ' (blocked by Cloudflare)' : ''}`;
  }
  try {
    const j = JSON.parse(body);
    // Cloudflare's JSON error pages (e.g. Chub's "520 unknown origin error"): a problem on the provider's side
    if (j?.cloudflare_error || (j?.error_code && /cloudflare/i.test(j?.type || ''))) {
      const title = String(j.title || '').replace(/^Error \d+:\s*/i, '');
      return `HTTP ${status} – Cloudflare error ${j.error_code || status}${title ? ` (${title})` : ''}. This is a problem on the provider's servers${j.zone ? ` (${j.zone})` : ''}, not on your phone${j.retryable ? ' – it usually clears up if you try again in a minute' : ''}.`;
    }
    const msg = j?.error?.message || j?.message || body;
    const type = j?.error?.type ? `${j.error.type}: ` : '';
    return `HTTP ${status} – ${type}${msg}`;
  } catch {
    return `HTTP ${status}${body ? ' – ' + body.slice(0, 400) : ''}`;
  }
}

export const SAMPLER_KEYS = ['max_tokens', 'top_p', 'min_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty'];

/**
 * Stream a chat completion.
 * handlers: { onContent(text), onReasoning(text), onUsage(usage, extra), onDone(), onError(err) }
 * Returns { cancel() }.
 */
/**
 * A background job (learning, helper, advisor…) on the user's Claude Code subscription (decision 169): the model id is
 * "claude-code:<Claude Code model value>", and the app registers the runner (a hidden Claude Code session, no tools).
 */
export const CC_MODEL = 'claude-code:';
export const isCcModel = (id) => typeof id === 'string' && id.startsWith(CC_MODEL);
let ccTextRunner = null;
export const setCcTextRunner = (fn) => (ccTextRunner = fn);

export function streamChat(settings, { model, messages, sessionId, reasoningEffort, temperature, samplers, tools, kind, source }, handlers) {
  if (isCcModel(model)) {
    if (ccTextRunner) return ccTextRunner({ value: model.slice(CC_MODEL.length), messages, sessionId }, handlers);
    queueMicrotask(() => handlers.onError?.(new Error('Claude Code is not set up on this phone')));
    return { cancel() {} };
  }
  if (isLocalModel(model)) return streamLocal({ messages, temperature }, handlers, (p) => handlers.onReasoning?.(`Downloading the on-device model… ${p}%\n`));
  const route = modelRoutes[model];
  const provider = route?.providerId ? providersById[route.providerId] : null;
  const usageKind = () => kind || (String(sessionId).match(/-(memory|title|compact|group)$/)?.[1]) || (tools?.length ? 'agent' : 'chat');
  if (isAnthropic(provider)) return streamAnthropicChat({ provider, route, messages, reasoningEffort, samplers, tools, longCache: settings?.prefs?.cacheHour === true, record: (u) => recordUsage(model, u, usageKind(), chatIdOf(sessionId), sourceOf(source, sessionId, kind)) }, handlers);
  // the Claude thinking blocks kept on a stored reply mean nothing to other providers (and some refuse unknown fields)
  if (messages?.some((m) => m && m.anthropic)) messages = messages.map(({ anthropic: _a, ...m }) => m);
  const body = {
    model: provider ? route.apiModel : model,
    messages,
    stream: true,
  };
  if (!provider || provider.streamUsage) body.stream_options = { include_usage: true };
  if (provider && provider.maxTokens) body.max_tokens = Number(provider.maxTokens);
  // "off" (decision 204): OpenCode Go's switch for models that can stop thinking – what OpenCode's own client sends them
  if (reasoningEffort === 'off' && !provider) body.thinking = { type: 'disabled' };
  else if (reasoningEffort && !provider) body.reasoning_effort = reasoningEffort;
  if (typeof temperature === 'number') body.temperature = temperature;
  // per character / per chat sampler overrides – only sent when set
  for (const k of SAMPLER_KEYS) if (typeof samplers?.[k] === 'number' && Number.isFinite(samplers[k])) body[k] = samplers[k];
  if (samplers?.stop?.length) body.stop = samplers.stop;
  if (tools?.length && !(provider && provider.tools === false)) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // Tool calls arrive as fragments (index, id, name, argument chunks) across many deltas.
  const toolCalls = [];

  let finished = false;
  let finishReason = '';
  let sawDone = false;
  let lastUsage = null;
  const finish = (err) => {
    if (finished) return;
    finished = true;
    if (lastUsage) recordUsage(model, lastUsage, usageKind(), chatIdOf(sessionId), sourceOf(source, sessionId, kind));
    if (err) handlers.onError?.(err);
    else {
      const calls = toolCalls.filter((c) => c && c.name);
      calls.forEach((c, i) => (c.id ||= `call_${Date.now().toString(36)}_${i}`));
      if (calls.length) handlers.onToolCalls?.(calls);
      // why it ended: the provider's finish_reason ('stop', 'length' = hit the max-tokens limit …), or
      // 'incomplete' when the connection ended without a finish reason or [DONE] marker
      handlers.onDone?.(finishReason || (sawDone ? 'stop' : 'incomplete'), { maxTokens: body.max_tokens });
    }
  };

  const parse = sseParser((data) => {
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (j.error) {
      finish(new Error(j.error.message || JSON.stringify(j.error)));
      return;
    }
    if (j.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason;
    const delta = j.choices?.[0]?.delta || {};
    const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
    if (reasoning) handlers.onReasoning?.(reasoning);
    if (delta.content) handlers.onContent?.(delta.content);
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? toolCalls.length;
        const cur = (toolCalls[i] ||= { id: '', name: '', arguments: '' });
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        handlers.onToolCallDelta?.(toolCalls.filter(Boolean));
      }
    }
    if (j.usage) lastUsage = j.usage;
    if (j.usage || j.opencode) handlers.onUsage?.(j.usage, j.opencode);
  });

  const url = provider ? trimBase(provider.baseUrl) + '/chat/completions' : typeof route === 'string' ? route + '/chat/completions' : baseUrl(settings) + CHAT_PATH;
  const hdrs = provider ? providerHeaders(provider) : headers(settings, sessionId);
  const payload = JSON.stringify(body);

  if (isNative && !(provider && provider.via === 'browser')) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const subs = [];
    const cleanup = () => subs.forEach((s) => s.then((h) => h.remove()));
    subs.push(GoStream.addListener('chunk', (e) => e.id === id && parse(e.data)));
    subs.push(
      GoStream.addListener('done', (e) => {
        if (e.id !== id) return;
        cleanup();
        finish();
      }),
    );
    subs.push(
      GoStream.addListener('error', (e) => {
        if (e.id !== id) return;
        cleanup();
        finish(new Error((e.status ? describeError(e.status, e.body || '') : e.message || 'Network error') + (body.thinking && e.status === 400 ? ' – OpenCode Go may not take 🧠 off for this model: tap 🧠 back to default.' : '')));
      }),
    );
    Promise.all(subs)
      .then(() => GoStream.start({ id, url, headers: hdrs, body: payload }))
      .catch((e) => {
        cleanup();
        finish(e);
      });
    return {
      cancel() {
        GoStream.cancel({ id }).catch(() => {});
        cleanup();
        finish();
      },
    };
  }

  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(url, { method: 'POST', headers: hdrs, body: payload, signal: ctrl.signal });
      if (!res.ok) throw new Error(describeError(res.status, await res.text()) + (body.thinking && res.status === 400 ? ' – OpenCode Go may not take 🧠 off for this model: tap 🧠 back to default.' : ''));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parse(dec.decode(value, { stream: true }));
      }
      finish();
    } catch (e) {
      if (e.name === 'AbortError') return finish();
      if (e instanceof TypeError && provider) {
        finish(new Error(`Could not reach ${provider.name} (${e.message}). If it blocks browser requests, switch “Connect via” to “App network” in its settings.`));
      } else if (e instanceof TypeError && !settings.proxyUrl) {
        finish(
          new Error(
            'Request blocked by the browser (CORS). OpenCode Go can only be called from the Android app, or from the web through a proxy — set a Proxy URL in Settings.',
          ),
        );
      } else finish(e);
    }
  })();
  return {
    cancel() {
      ctrl.abort();
    },
  };
}

/** streamChat for a model of an Anthropic provider: the converted request, streamed with the official SDK. */
function streamAnthropicChat({ provider, route, messages, reasoningEffort, samplers, tools, record, longCache }, handlers) {
  let inner = null;
  let cancelled = false;
  const { params, hasThinking } = anthropicParams({
    model: route.apiModel,
    messages,
    tools: provider.tools === false ? undefined : tools,
    effort: reasoningEffort,
    samplers,
    maxTokens: provider.maxTokens,
    caps: route.anthropic || {},
    longCache,
  });
  anthropicClient(provider)
    .then(({ A, client }) => {
      if (cancelled) return handlers.onDone?.('stop', { maxTokens: params.max_tokens });
      inner = runAnthropicStream({ client, A, params, hasThinking, onUsageRecord: record }, handlers);
    })
    .catch((e) => handlers.onError?.(e));
  return {
    cancel() {
      cancelled = true;
      inner?.cancel();
    },
  };
}

/** Download a file as bytes (native HTTP on Android – no CORS limits; fetch on the web). */
export async function fetchBytes(url, { timeoutMs = 45000, method = 'GET', json = null } = {}) {
  if (isNative) {
    const r = await CapacitorHttp.request({ method, url, responseType: 'blob', connectTimeout: timeoutMs, readTimeout: timeoutMs, ...(json ? { headers: { 'Content-Type': 'application/json' }, data: json } : {}) });
    if (r.status < 200 || r.status >= 300) throw new Error(`Download failed (${r.status})`);
    const b64 = typeof r.data === 'string' ? r.data : '';
    const bin = atob(b64.replace(/^data:[^,]*,/, ''));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  const res = await fetch(url, json ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) } : { method });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** chub.ai / characterhub character link → "creator/slug", or null. */
export function chubPath(link) {
  const m = String(link || '').trim().match(/^(?:https?:\/\/)?(?:www\.|venus\.)?(?:chub\.ai|characterhub\.org)\/characters\/([\w.~-]+\/[\w.~-]+)/i);
  return m ? m[1].replace(/\/+$/, '') : null;
}
/** botbooru.com character page link → its post id, or null. */
export function botbooruId(link) {
  const m = String(link || '').trim().match(/^(?:https?:\/\/)?(?:www\.)?botbooru\.com\/post\/(\d+)/i);
  return m ? m[1] : null;
}
export const botbooruCardUrl = (id) => `https://botbooru.com/download/png/${id}`;
/** Download the card for a pasted / shared character link from a supported site. → { bytes, name } */
export async function downloadCardFromLink(link) {
  const chub = chubPath(link);
  if (chub) return { bytes: await downloadChubCard(chub), name: chub.split('/').pop() + '.png' };
  const bb = botbooruId(link);
  if (bb) {
    const bytes = await fetchBytes(botbooruCardUrl(bb));
    if (bytes?.[0] !== 0x89) throw new Error('BotBooru did not send a card (it may need you to be signed in – use Browse BotBooru)');
    return { bytes, name: `botbooru-${bb}.png` };
  }
  throw new Error('Paste a chub.ai or botbooru.com character link');
}
/** The full card PNG Chub serves for a character (card data embedded). */
export const chubCardUrl = (path) => `https://avatars.charhub.io/avatars/${path}/chara_card_v2.png`;
/** Download a Chub character card: the card PNG from Chub's image host, or Chub's download API as a fallback. */
export async function downloadChubCard(path) {
  const isPng = (b) => b?.[0] === 0x89 && b?.[1] === 0x50;
  let firstErr;
  try {
    const b = await fetchBytes(chubCardUrl(path));
    if (isPng(b)) return b;
  } catch (e) {
    firstErr = e;
  }
  try {
    const b = await fetchBytes('https://api.chub.ai/api/characters/download', { method: 'POST', json: { format: 'tavern', fullPath: path, version: 'main' } });
    if (isPng(b)) return b;
    throw new Error('Chub did not send a character card');
  } catch (e) {
    throw firstErr || e;
  }
}
