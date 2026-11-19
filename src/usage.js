// Local usage log: tokens per day and model, for every request the app makes
// (chat replies, tool steps, memory, titles, compaction…). Stored in localStorage, ~90 days.
const KEY = 'ocm.usageLog';
const KEEP_DAYS = 90;

const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

const CHATS_KEY = 'ocm.usageChats';
const SESSION_SUFFIX = /-(memory|title|compact|group|story|vision|helper|lore|card-edit|tidy|episode|tracker|correct|polish|delegate|btw|advisor)$/;
/** The chat a request belonged to (side requests use `<chat id>-<kind>` as their session id). */
export const chatIdOf = (sessionId) => String(sessionId || '').replace(SESSION_SUFFIX, '');
function loadChats() {
  try {
    return JSON.parse(localStorage.getItem(CHATS_KEY) || '{}');
  } catch {
    return {};
  }
}
function recordChat(chatId, model, inT, outT, cached) {
  if (!chatId) return;
  const all = loadChats();
  const c = (all[chatId] ||= { t: 0, models: {} });
  const m = (c.models[model] ||= { in: 0, out: 0, cached: 0, reqs: 0 });
  m.in += inT;
  m.out += outT;
  m.cached += cached;
  m.reqs += 1;
  c.t = Date.now();
  const ids = Object.keys(all);
  if (ids.length > 300) for (const id of ids.sort((a, b) => all[a].t - all[b].t).slice(0, ids.length - 300)) delete all[id];
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(all));
  } catch {
    /* full */
  }
}

// ---------- where the tokens went: per day, per source (reply, a tool, an MCP server, a helper job) and model ----------
const SRC_KEY = 'ocm.usageSrc';
const SRC_NAMES = { reply: 'Replies', memory: 'Memory', title: 'Chat titles', compact: 'Compaction', group: 'Group turn-taking', story: 'Story memory', tracker: 'Scene tracker', lore: 'Lore suggestions', vision: 'Image reading', helper: 'Helpers', correct: 'Corrections', polish: 'Polish', delegate: 'Helper agents', 'card-edit': 'Card editing', tidy: 'Memory tidy-up', episode: 'Episodes', test: 'Prompt tests', persona: 'Persona creation', btw: 'Side questions (/btw)', advisor: 'Advisor' };
/** A readable name for a source key. */
export function sourceName(src) {
  const s = String(src || 'reply');
  if (s.startsWith('tool:')) return `Tool: ${s.slice(5)}`;
  if (s.startsWith('mcp:')) return `MCP: ${s.slice(4)}`;
  return SRC_NAMES[s] || s;
}
/** The source of a request from what the app knows: an explicit one, else the side-request suffix of the session id. */
export function sourceOf(source, sessionId, kind) {
  if (source) return source;
  const sid = String(sessionId || '');
  const suf = sid.match(/-(memory|title|compact|group|story|vision|helper|lore|card-edit|tidy|episode|tracker|correct|polish|btw|advisor)$/)?.[1];
  if (suf) return suf;
  const pre = sid.match(/^(card-edit|persona|shorten|tidy|test)\b/)?.[1];
  if (pre) return pre === 'shorten' ? 'tidy' : pre;
  return kind === 'helper' ? 'helper' : 'reply';
}
/** The tools a step's tokens are put down to: the tool calls of the round just before it. MCP tools by server. */
export function sourceOfCalls(calls, mcpServers = []) {
  const names = (calls || []).map((c) => c?.name).filter(Boolean);
  if (!names.length) return 'reply';
  const n = names[0];
  if (n.startsWith('mcp_')) {
    const server = mcpServers.find((s) => n.startsWith(`mcp_${s}_`));
    return `mcp:${server || n.slice(4).split('_')[0]}`;
  }
  return n === 'delegate' ? 'delegate' : `tool:${n}`;
}
function recordSource(src, model, inT, outT, cached) {
  let all;
  try {
    all = JSON.parse(localStorage.getItem(SRC_KEY) || '{}');
  } catch {
    all = {};
  }
  const day = (all[dayKey()] ||= {});
  const x = ((day[src] ||= {})[model] ||= { in: 0, out: 0, cached: 0, reqs: 0 });
  x.in += inT;
  x.out += outT;
  x.cached += cached;
  x.reqs += 1;
  const cutoff = dayKey(Date.now() - KEEP_DAYS * 864e5);
  for (const k of Object.keys(all)) if (k < cutoff) delete all[k];
  try {
    localStorage.setItem(SRC_KEY, JSON.stringify(all));
  } catch {
    /* full */
  }
}
/** The last `days` days by source, biggest first: [{ src, name, in, out, reqs, value }]. */
export function sourceSpend(models, days = 30) {
  let all;
  try {
    all = JSON.parse(localStorage.getItem(SRC_KEY) || '{}');
  } catch {
    all = {};
  }
  const price = (id) => models.find((m) => m.id === id)?.cost?.text || {};
  const from = dayKey(Date.now() - (days - 1) * 864e5);
  const out = {};
  for (const [d, srcs] of Object.entries(all)) {
    if (d < from) continue;
    for (const [src, byModel] of Object.entries(srcs)) {
      const r = (out[src] ||= { src, name: sourceName(src), in: 0, out: 0, reqs: 0, value: 0 });
      for (const [model, x] of Object.entries(byModel)) {
        const p = price(model);
        r.in += x.in;
        r.out += x.out;
        r.reqs += x.reqs;
        r.value += ((x.in - x.cached) * (p.input?.price || 0) + x.cached * (p.input?.cache?.read ?? p.input?.price ?? 0) + x.out * (p.output?.price || 0)) / 1e6;
      }
    }
  }
  return Object.values(out).sort((a, b) => b.in + b.out - (a.in + a.out));
}

export function recordUsage(model, usage, kind = 'chat', chatId = '', source = 'reply') {
  if (!usage) return;
  const inT = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outT = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
  if (!inT && !outT) return;
  recordChat(chatId, model, inT, outT, cached);
  recordSource(source || 'reply', model, inT, outT, cached);
  const log = load();
  const day = (log[dayKey()] ||= {});
  const m = (day[model] ||= { in: 0, out: 0, cached: 0, reqs: 0, kinds: {} });
  m.in += inT;
  m.out += outT;
  m.cached += cached;
  m.reqs += 1;
  m.kinds[kind] = (m.kinds[kind] || 0) + 1;
  const cutoff = dayKey(Date.now() - KEEP_DAYS * 864e5);
  for (const k of Object.keys(log)) if (k < cutoff) delete log[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(log));
  } catch {
    /* full */
  }
}

/** { days: [{day, in, out, reqs, value}], models: [{model, in, out, reqs, value}], totals: {today, week, month} } */
export function usageSummary(models, days = 30) {
  const log = load();
  const price = (id) => models.find((m) => m.id === id)?.cost?.text || {};
  const value = (id, x) => {
    const p = price(id);
    return ((x.in - (x.cached || 0)) * (p.input?.price || 0) + (x.cached || 0) * (p.input?.cache?.read ?? p.input?.price ?? 0) + x.out * (p.output?.price || 0)) / 1e6;
  };
  const list = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(Date.now() - i * 864e5);
    const day = log[k] || {};
    const row = { day: k, in: 0, out: 0, reqs: 0, value: 0 };
    for (const [id, x] of Object.entries(day)) {
      row.in += x.in;
      row.out += x.out;
      row.reqs += x.reqs;
      row.value += value(id, x);
    }
    list.push(row);
  }
  const byModel = {};
  for (const k of Object.keys(log)) {
    if (k < dayKey(Date.now() - (days - 1) * 864e5)) continue;
    for (const [id, x] of Object.entries(log[k])) {
      const t = (byModel[id] ||= { model: id, in: 0, out: 0, cached: 0, reqs: 0, value: 0 });
      t.in += x.in;
      t.out += x.out;
      t.cached += x.cached || 0;
      t.reqs += x.reqs;
    }
  }
  for (const t of Object.values(byModel)) t.value = value(t.model, t);
  const sum = (rows) => rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, reqs: a.reqs + r.reqs, value: a.value + r.value }), { in: 0, out: 0, reqs: 0, value: 0 });
  return {
    days: list,
    models: Object.values(byModel).sort((a, b) => b.in + b.out - (a.in + a.out)),
    totals: { today: sum(list.slice(-1)), week: sum(list.slice(-7)), month: sum(list) },
  };
}

/** Tokens used today (all requests). */
export function todayTokens() {
  const day = load()[dayKey()] || {};
  return Object.values(day).reduce((n, x) => n + x.in + x.out, 0);
}
export const todayKey = dayKey;

/** Per chat, biggest first: [{ id, in, out, reqs, value, t }]. */
export function chatSpend(models) {
  const price = (id) => models.find((m) => m.id === id)?.cost?.text || {};
  const rows = [];
  for (const [id, c] of Object.entries(loadChats())) {
    const r = { id, in: 0, out: 0, reqs: 0, value: 0, t: c.t };
    for (const [model, x] of Object.entries(c.models)) {
      const p = price(model);
      r.in += x.in;
      r.out += x.out;
      r.reqs += x.reqs;
      r.value += ((x.in - x.cached) * (p.input?.price || 0) + x.cached * (p.input?.cache?.read ?? p.input?.price ?? 0) + x.out * (p.output?.price || 0)) / 1e6;
    }
    rows.push(r);
  }
  return rows.sort((a, b) => b.in + b.out - (a.in + a.out));
}

export const clearUsage = () => {
  localStorage.removeItem(KEY);
  localStorage.removeItem(CHATS_KEY);
  localStorage.removeItem(SRC_KEY);
};
