/**
 * A client for the Agent Client Protocol (ACP), through acp-bridge on a PC: Chronicle is the "editor", the PC agent
 * (Claude Code, Gemini CLI, Goose, OpenCode…) does the work there. JSON-RPC both ways: our requests (initialize,
 * session/new, session/prompt), its notifications (session/update) and its requests (session/request_permission).
 * We offer no file system or terminal to the agent: it works on the PC's own files.
 */
export class AcpClient {
  /** http(url, { method, headers, body, timeoutMs }) → { status, body } */
  /**
   * deadAfterMs: while a request waits for its answer, how long the bridge may not answer at all before the request
   * fails (the bridge or the agent died: the reply must not stay "writing" for ever). An idle connection keeps trying.
   */
  constructor({ url, secret, http, deadAfterMs = 60000, retryMs = 1500, graceMs = 120000 }) {
    this.url = String(url).replace(/\/+$/, '');
    this.deadAfterMs = deadAfterMs;
    // probe() → { alive, why }: asked before giving up (decision 216). A bridge that is still running gets up to graceMs
    // more (Linux busy with a heavy command); the answer says why it stopped when it did
    this.probe = null;
    this.graceMs = graceMs;
    this.retryMs = retryMs;
    this.h = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
    this.http = http;
    this.next = 0;
    this.id = 1;
    this.pending = new Map();
    this.onUpdate = () => {};
    this.onPermission = async () => null;
    this.onMcp = null; // (params) → JSON-RPC answer: an MCP request the agent sent to the bridge's /mcp (decision 166)
    this.closed = false;
    this.info = null;
    this.configs = new Map(); // session id → its configOptions (model, effort, mode…), as the agent last sent them
  }
  async post(msg, path = '/send') {
    const r = await this.http(this.url + path, { method: 'POST', headers: this.h, body: JSON.stringify(msg), timeoutMs: 15000 });
    if (r.status === 401) throw new Error('The PC agent refused the secret');
    if (r.status >= 400) throw new Error(`The PC agent answered HTTP ${r.status}`);
  }
  request(method, params) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ jsonrpc: '2.0', id, method, params }).catch((e) => (this.pending.delete(id), reject(e)));
    });
  }
  notify(method, params) {
    return this.post({ jsonrpc: '2.0', method, params });
  }
  async loop() {
    let downSince = 0; // when the bridge stopped answering (0: it answers)
    let probed = null; // the last answer of probe() while it does not answer
    const down = async () => {
      downSince ||= Date.now();
      if (this.pending.size && Date.now() - downSince >= this.deadAfterMs) {
        // asked at most every 10 s: it runs a command in Linux
        if (this.probe && (!probed || Date.now() - probed.at > 10000)) probed = { at: Date.now(), r: await this.probe().catch(() => null) };
        const r = probed?.r;
        if (r?.alive && Date.now() - downSince < this.deadAfterMs + this.graceMs) {
          await new Promise((res) => setTimeout(res, this.retryMs));
          return false;
        }
        return this.fail(new Error(`the bridge does not answer any more (it or the agent stopped)${r?.why ? ': ' + r.why : ''} – send again to start it anew`)), true;
      }
      if (!this.pending.size) downSince = Date.now(); // idle: nothing is waiting, the clock starts with the next request
      await new Promise((res) => setTimeout(res, this.retryMs));
      return false;
    };
    while (!this.closed) {
      let r;
      try {
        r = await this.http(`${this.url}/events?since=${this.next}`, { method: 'GET', headers: this.h, timeoutMs: 35000 });
      } catch (e) {
        if (this.closed) return;
        if (await down()) return;
        continue;
      }
      if (r.status === 401) return this.fail(new Error('The PC agent refused the secret'));
      if (r.status >= 400) {
        if (await down()) return;
        continue;
      }
      downSince = 0;
      probed = null;
      const j = JSON.parse(r.body || '{}');
      this.next = j.next ?? this.next;
      for (const m of j.events || []) await this.dispatch(m);
    }
  }
  fail(e) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.closed = true;
    this.onClose?.(e);
  }
  async dispatch(m) {
    if (m.method === 'bridge/exit') return this.fail(new Error(`The agent on the PC stopped (code ${m.params?.code})`));
    if (m.method === 'bridge/mcp') return void this.mcp(m.params || {}); // not awaited: a tool call may take minutes
    if (m.id != null && !m.method && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (!m.error) return p.resolve(m.result);
      const e = new Error(m.error.message || 'The agent refused');
      e.code = m.error.code; // -32000: the agent needs a sign-in (done in the agent itself, never here)
      return p.reject(e);
    }
    if (m.method === 'session/update') {
      const u = m.params?.update || {};
      if (u.sessionUpdate === 'config_option_update' && Array.isArray(u.configOptions)) this.configs.set(m.params?.sessionId, u.configOptions);
      return this.onUpdate(u, m.params?.sessionId);
    }
    if (m.method === 'session/request_permission' && m.id != null) {
      let optionId = null;
      try {
        optionId = await this.onPermission(m.params);
      } catch {
        optionId = null;
      }
      return this.post({ jsonrpc: '2.0', id: m.id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } }).catch(() => {});
    }
    if (m.id != null && m.method) return this.post({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `${m.method} is not offered by this client` } }).catch(() => {});
  }
  /**
   * One MCP request of the agent's (tools/list, tools/call on the bridge's /mcp): claimed first, so a request is
   * only ever run once (a second client, or the same events read again after a reconnect, gets 409), then answered.
   */
  async mcp(p) {
    const rid = p.rid;
    const msg = p.message || {};
    if (!this.onMcp || rid == null) return;
    try {
      await this.post({ rid, claim: true }, '/mcp-reply');
    } catch {
      return; // answered already, timed out, or taken by another client
    }
    let reply;
    const t0 = Date.now();
    try {
      reply = { result: await this.onMcp({ chat: p.chat, method: msg.method, params: msg.params || {} }) };
    } catch (e) {
      reply = { error: { code: e?.code || -32603, message: String(e?.message || e) } };
    }
    // the answer can find nobody waiting (the agent gave up, or its connection dropped): said, not lost silently
    await this.post({ rid, message: { jsonrpc: '2.0', id: msg.id ?? null, ...reply } }, '/mcp-reply').catch((e) => this.onMcpLate?.({ method: msg.method, tool: msg.params?.name || '', seconds: Math.round((Date.now() - t0) / 1000), error: String(e?.message || e) }));
  }
  async start() {
    this.loop();
    this.info = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'chronicle', version: '1' } });
    return this.info;
  }
  /** Does the agent take a system prompt on session/new (sessionCapabilities.systemPrompt, e.g. claude-agent-acp)? */
  get takesSystemPrompt() {
    return !!this.info?.agentCapabilities?.sessionCapabilities?.systemPrompt;
  }
  /**
   * A new session. systemPrompt: text added after the agent's own instructions ("append" – Claude Code keeps its
   * tools and rules), sent only to an agent that advertises it.
   */
  async newSession(cwd = '.', { systemPrompt = '', mcpServers = [], meta = null } = {}) {
    const extra = systemPrompt && this.takesSystemPrompt ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: systemPrompt }] } } : {};
    const r = await this.request('session/new', { cwd, mcpServers, ...extra, ...(meta ? { _meta: meta } : {}) });
    if (Array.isArray(r?.configOptions)) this.configs.set(r.sessionId, r.configOptions);
    return r.sessionId;
  }
  /** The agent's session from before, if it can load sessions. */
  async loadSession(sessionId, cwd = '.', { mcpServers = [], meta = null } = {}) {
    if (!this.info?.agentCapabilities?.loadSession) return false;
    const r = await this.request('session/load', { sessionId, cwd, mcpServers, ...(meta ? { _meta: meta } : {}) });
    if (Array.isArray(r?.configOptions)) this.configs.set(sessionId, r.configOptions);
    return true;
  }
  /**
   * The agent's session from before, without replaying it (ACP session/resume, when the agent offers it): the other way
   * back into a session after the agent restarted (decision 234).
   */
  async resumeSession(sessionId, cwd = '.', { mcpServers = [], meta = null } = {}) {
    if (!this.info?.agentCapabilities?.sessionCapabilities?.resume) return false;
    const r = await this.request('session/resume', { sessionId, cwd, mcpServers, ...(meta ? { _meta: meta } : {}) });
    if (Array.isArray(r?.configOptions)) this.configs.set(sessionId, r.configOptions);
    return true;
  }
  /** session/set_config_option (the model, its effort…): the agent answers with all the options as they are now. */
  async setConfigOption(sessionId, configId, value) {
    const r = await this.request('session/set_config_option', { sessionId, configId, value });
    if (Array.isArray(r?.configOptions)) this.configs.set(sessionId, r.configOptions);
    return r?.configOptions || null;
  }
  /** Close a session the agent advertises it can close (its process goes away); errors are not ours to show. */
  async closeSession(sessionId) {
    this.configs.delete(sessionId);
    if (!this.info?.agentCapabilities?.sessionCapabilities?.close) return false;
    await this.request('session/close', { sessionId }).catch(() => {});
    return true;
  }
  prompt(sessionId, text) {
    return this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  }
  cancel(sessionId) {
    return this.notify('session/cancel', { sessionId }).catch(() => {});
  }
  /** Let go of the connection (Claude Code restarted or stopped, the agent removed): what still waits fails now. */
  close() {
    this.closed = true;
    const e = new Error('the connection was closed (Claude Code or the agent was restarted or stopped) – send again');
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}

/** A session/update → what to change in the reply on screen: { text?, tool?: { id, title, status, kind } , plan? } */
/** What a tool call produced, as text for its card: its text content, the files a diff touched (cut to 4000). */
export function toolOutput(u) {
  const parts = [];
  for (const c of Array.isArray(u?.content) ? u.content : []) {
    if (c?.type === 'content' && c.content?.type === 'text' && c.content.text) parts.push(c.content.text);
    else if (c?.type === 'diff' && c.path) parts.push(`edited ${c.path}`);
  }
  // nothing as content (a failed MCP call is often reported only as rawOutput): its text or error, so the card says why
  if (!parts.length && u?.rawOutput != null) parts.push(rawText(u.rawOutput));
  return parts.filter(Boolean).join('\n').slice(0, 4000);
}
/** rawOutput as text: a string, an MCP result's text parts, an error's message, else the JSON. */
function rawText(r) {
  if (typeof r === 'string') return r;
  if (Array.isArray(r?.content)) return r.content.map((x) => (x?.type === 'text' ? x.text : '')).filter(Boolean).join('\n');
  if (r?.error) return typeof r.error === 'string' ? r.error : r.error.message || JSON.stringify(r.error);
  if (typeof r?.message === 'string') return r.message;
  try {
    return JSON.stringify(r);
  } catch {
    return '';
  }
}

export function readUpdate(u) {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      return { text: u.content?.type === 'text' ? u.content.text : '' };
    case 'agent_thought_chunk':
      return { thought: u.content?.text || '' };
    case 'tool_call': {
      const out = toolOutput(u);
      return { tool: { id: u.toolCallId, title: u.title || 'Tool', status: u.status || 'pending', kind: u.kind || '', ...(out ? { output: out } : {}) } };
    }
    case 'tool_call_update': {
      const out = toolOutput(u);
      return { tool: { id: u.toolCallId, ...(u.title ? { title: u.title } : {}), ...(u.status ? { status: u.status } : {}), ...(u.kind ? { kind: u.kind } : {}), ...(out ? { output: out } : {}) } };
    }
    case 'config_option_update':
      return Array.isArray(u.configOptions) ? { config: u.configOptions } : {};
    case 'available_commands_update':
      // the agent's slash commands (Claude Code: its built-in ones, skills, project commands) – for the "/" menu
      return Array.isArray(u.availableCommands) ? { commands: u.availableCommands.filter((c) => c && typeof c.name === 'string' && c.name).map((c) => ({ name: c.name.replace(/^\//, ''), description: String(c.description || ''), hint: String(c.input?.hint || '') })) } : {};
    case 'usage_update':
      // the agent's own context: tokens in it now and its window (Claude Code sends one after each turn)
      return Number.isFinite(u.used) && u.size > 0 ? { ctx: { used: u.used, size: u.size } } : {};
    case 'plan':
      return { plan: (u.entries || []).map((e) => `${e.status === 'completed' ? '☑' : '☐'} ${e.content}`).join('\n') };
    default:
      return {};
  }
}

// an ACP tool call as one of the app's own tool cards: the kind picks the icon and label, the title (a command, a
// path) is plain text – never Markdown, so a `\(` or `*` in a shell command is not read as math or emphasis
const KIND_TOOL = { execute: 'shell', read: 'read_file', edit: 'edit_file', delete: 'delete_file', move: 'move_file', search: 'grep_files', fetch: 'fetch_url' };
const STATUS = { pending: 'running', in_progress: 'running', completed: 'done', failed: 'error' };
export function acpCall(p) {
  const name = KIND_TOOL[p.kind] || 'agent_tool';
  const title = String(p.title || 'Tool');
  return {
    id: p.id,
    name,
    arguments: JSON.stringify(name === 'fetch_url' ? { urls: [title] } : { path: title }),
    status: STATUS[p.status] || 'done',
    ...(STATUS[p.status] === 'running' ? { statusText: p.status === 'pending' ? 'waiting…' : 'running…' } : {}),
    result: [title.length > 80 ? title : '', p.output || ''].filter(Boolean).join('\n\n'),
    display: p.output ? { output: p.output } : {},
  };
}
/**
 * The parts of an agent's reply → the app's message shape: rounds (the text before a run of tool calls, and the
 * calls as cards) and the text after the last call as the message's own content.
 */
export function acpRounds(parts) {
  const rounds = [];
  let text = '';
  let calls = null;
  for (const p of parts || []) {
    if (p.t === 'text') {
      if (calls) {
        rounds.push({ content: text, calls });
        text = '';
        calls = null;
      }
      text += p.s;
    } else (calls ||= []).push(acpCall(p));
  }
  if (calls) {
    rounds.push({ content: text, calls });
    text = '';
  }
  return { rounds, content: text.replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * An agent's reply as plain text for a model that was not that agent (the chat went back to a normal model) or for a
 * new session's context: what it said and, in brackets, what it did – its tool calls were never the other model's.
 */
export function agentReplyText(parts) {
  return (parts || [])
    .map((p) => (p.t === 'text' ? p.s : `\n[${p.kind === 'execute' ? 'Ran' : 'Tool'}: ${String(p.title || 'Tool').slice(0, 300)}${p.status === 'failed' ? ' – failed' : ''}]\n`))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
