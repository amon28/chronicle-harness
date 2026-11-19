// Mods: small JavaScript add-ons that extend the harness – tools for the agent, slash commands, hooks on requests and
// replies, a status chip, a little saved data and (only where allowed) network access.
// Each mod runs in its own sandboxed iframe (opaque origin, no storage, no DOM access to the app, Content-Security-Policy
// that blocks every network request). The only way out is postMessage to the host below, which checks the permissions the
// user approved. See docs/MODS.md.
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { unsafe } from './websearch.js';

export const PERMISSIONS = {
  tools: 'Give the assistant new tools to call',
  commands: 'Add slash commands (/name) to the message box',
  chat: 'Read what you write and what the assistant replies (to react to it or change what you send)',
  request: 'Read and change the whole prompt before it is sent to the model (system prompt, memories, history)',
  storage: 'Keep a little data of its own on this phone',
  search: 'Add its own search sources to the assistant’s web search',
  panel: 'Show its own panel (a page of text) in the chat menu',
  toolhook: 'See every tool call the assistant makes (with its arguments and result) and block or change it',
};
// permissions that expose your conversations or reach the network are marked as sensitive in the install screen
export const SENSITIVE = new Set(['chat', 'request', 'toolhook']);
export const isNetPerm = (p) => /^net:[a-z0-9.-]+$/i.test(p) || p === 'net:*';
export const permOk = (p) => p in PERMISSIONS || isNetPerm(p);
export const describePerm = (p) => (p === 'net:*' ? 'Connect to ANY website (can send data anywhere)' : isNetPerm(p) ? `Connect to ${p.slice(4)} (and nothing else)` : PERMISSIONS[p] || p);

export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const MAX_CODE = 400_000;

/** A mod file: JavaScript starting with a comment `/*! @mod { …manifest json… } *​/`, or a zip with mod.json + main.js. */
export function parseModSource(text) {
  const m = String(text || '').match(/^\s*\/\*[!*]?\s*@mod\s*(\{[\s\S]*?\})\s*\*\//);
  if (!m) throw new Error('This file has no mod header. It must start with /*! @mod { "id": "…", "name": "…", "permissions": […] } */');
  let manifest;
  try {
    manifest = JSON.parse(m[1]);
  } catch (e) {
    throw new Error('The mod header is not valid JSON: ' + e.message);
  }
  return { manifest: validateManifest(manifest), code: String(text) };
}
export function parseModFiles(files) {
  const jsonKey = Object.keys(files).find((p) => /(^|\/)mod\.json$/i.test(p));
  if (!jsonKey) throw new Error('The zip has no mod.json');
  const base = jsonKey.includes('/') ? jsonKey.slice(0, jsonKey.lastIndexOf('/') + 1) : '';
  let manifest;
  try {
    manifest = JSON.parse(files[jsonKey]);
  } catch (e) {
    throw new Error('mod.json is not valid JSON: ' + e.message);
  }
  const main = base + (manifest.main || 'main.js');
  if (!(main in files)) throw new Error(`The zip has no ${manifest.main || 'main.js'}`);
  return { manifest: validateManifest(manifest), code: files[main] };
}
export function validateManifest(m) {
  const id = slug(m?.id || m?.name);
  if (id.length < 2) throw new Error('The mod needs an id (lowercase words with hyphens)');
  const permissions = [...new Set(Array.isArray(m.permissions) ? m.permissions.map(String) : [])];
  const bad = permissions.filter((p) => !permOk(p));
  if (bad.length) throw new Error(`Unknown permission${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}`);
  return { id, name: String(m.name || id).slice(0, 60), version: String(m.version || '1.0.0').slice(0, 20), description: String(m.description || '').slice(0, 400), author: String(m.author || '').slice(0, 60), permissions };
}
export function checkCode(code) {
  if (!String(code || '').trim()) throw new Error('The mod has no code');
  if (code.length > MAX_CODE) throw new Error('The mod is too big (limit 400 KB)');
}

// ---------- the sandboxed runtime ----------
const shim = (token, manifest) => `
(() => {
  const TOKEN = ${JSON.stringify(token)};
  const PERMS = ${JSON.stringify(manifest.permissions)};
  const out = (m) => parent.postMessage({ __mod: TOKEN, ...m }, '*');
  const pending = new Map();
  let seq = 0;
  const call = (type, payload) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); out({ type, id, ...payload }); });
  const has = (p) => PERMS.includes(p);
  const need = (p) => { if (!has(p)) throw new Error('This mod did not ask for the "' + p + '" permission'); };
  const tools = {}, commands = {}, hooks = {}, sources = {}, panels = {};
  const mod = {
    id: ${JSON.stringify(manifest.id)}, name: ${JSON.stringify(manifest.name)}, version: ${JSON.stringify(manifest.version)},
    tool(def) { need('tools'); if (!def || !/^[a-z][a-z0-9_]{1,40}$/.test(def.name || '')) throw new Error('tool names are lowercase_with_underscores'); tools[def.name] = def; },
    command(def) { need('commands'); if (!def || !/^[a-z][a-z0-9-]{1,30}$/.test(def.name || '')) throw new Error('command names are lowercase-with-hyphens'); commands[def.name] = def; },
    searchSource(def) { need('search'); if (!def || !/^[A-Za-z][A-Za-z0-9 ._-]{1,30}$/.test(def.name || '') || typeof def.run !== 'function') throw new Error('a search source needs a name and a run(query, opts) function'); sources[def.name] = def; },
    panel(def) { need('panel'); if (!def || !/^[A-Za-z][A-Za-z0-9 ._-]{1,30}$/.test(def.name || '') || typeof def.render !== 'function') throw new Error('a panel needs a name and a render() function that returns text'); panels[def.name] = def; },
    on(event, fn) { if (event === 'beforeRequest') need('request'); else if (event === 'afterReply' || event === 'userMessage') need('chat'); else if (event === 'beforeTool' || event === 'afterTool') need('toolhook'); else throw new Error('Unknown event ' + event); hooks[event] = fn; },
    status(text) { out({ type: 'status', text: String(text ?? '').slice(0, 40) }); },
    toast(text) { out({ type: 'toast', text: String(text ?? '').slice(0, 200) }); },
    log(...a) { out({ type: 'log', text: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 500) }); },
    storage: {
      get: (k) => (need('storage'), call('storage.get', { k: String(k) })),
      set: (k, v) => (need('storage'), call('storage.set', { k: String(k), v })),
      remove: (k) => (need('storage'), call('storage.remove', { k: String(k) })),
    },
    fetch: (url, opts) => call('fetch', { url: String(url), opts: opts || {} }),
  };
  Object.freeze(mod.storage);
  addEventListener('message', async (e) => {
    const m = e.data;
    if (e.source !== parent || !m || m.__host !== TOKEN) return;
    if (m.type === 'reply') {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.ok ? p.resolve(m.value) : p.reject(new Error(m.error || 'failed')); }
    } else if (m.type === 'invoke') {
      try {
        let value;
        if (m.kind === 'tool') value = await tools[m.name].run(m.args || {}, m.ctx || {});
        else if (m.kind === 'command') value = await commands[m.name].run(m.args || '', m.ctx || {});
        else if (m.kind === 'panel') value = await panels[m.name].render(m.args || {});
        else if (m.kind === 'source') value = await sources[m.name].run(String(m.args.query || ''), m.args.opts || {});
        else value = await hooks[m.name](m.payload);
        out({ type: 'result', id: m.id, ok: true, value: value === undefined ? null : value });
      } catch (err) {
        out({ type: 'result', id: m.id, ok: false, error: String((err && err.message) || err) });
      }
    }
  });
  // take away what could be used to reach outside (the CSP already blocks the network; this removes the obvious doors)
  for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'Worker', 'SharedWorker', 'indexedDB', 'caches', 'localStorage', 'sessionStorage', 'open', 'navigator']) {
    try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (e) { try { window[k] = undefined; } catch (e2) { /* ignore */ } }
  }
  Object.defineProperty(window, 'mod', { value: Object.freeze(mod), configurable: false, writable: false });
  window.__ocmBoot = (async () => { /*MODCODE*/ })();
  window.__ocmBoot.then(
    () => out({ type: 'ready', tools: Object.entries(tools).map(([n, t]) => ({ name: n, description: String(t.description || ''), parameters: t.parameters || { type: 'object', properties: {} } })), commands: Object.entries(commands).map(([n, c]) => ({ name: n, description: String(c.description || '') })), hooks: Object.keys(hooks), sources: Object.entries(sources).map(([n, s]) => ({ name: n, description: String(s.description || '') })), panels: Object.entries(panels).map(([n, p]) => ({ name: n, description: String(p.description || ''), icon: String(p.icon || '').slice(0, 4) })) }),
    (err) => out({ type: 'error', error: String((err && err.stack) || err).slice(0, 800) }),
  );
})();`;

/** The page the iframe loads: a CSP that forbids everything but this one inline script. */
export function modDocument(token, manifest, code) {
  const body = shim(token, manifest).replace('/*MODCODE*/', () => code.replace(/<\/script/gi, '<\\/script'));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'"></head><body><script>${body.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}

const TIMEOUT = { tool: 30000, command: 15000, hook: 2500 };

async function modFetch(url, opts) {
  const why = unsafe(url);
  if (why) throw new Error(`Won't open that address (${why})`);
  if (!/^https:\/\//i.test(url)) throw new Error('Only https:// addresses');
  const method = String(opts.method || 'GET').toUpperCase();
  const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [String(k), String(v)]));
  const body = opts.body == null ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  let status;
  let text;
  if (Capacitor.isNativePlatform()) {
    const r = await CapacitorHttp.request({ url, method, headers, data: body, responseType: 'text', connectTimeout: 15000, readTimeout: 20000 });
    status = r.status;
    text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  } else {
    const r = await fetch(url, { method, headers, body, credentials: 'omit' });
    status = r.status;
    text = await r.text();
  }
  if (text.length > 2_000_000) text = text.slice(0, 2_000_000);
  return { status, ok: status >= 200 && status < 300, body: text };
}

export class ModInstance {
  constructor(manifest, code, host) {
    this.manifest = manifest;
    this.code = code;
    this.host = host;
    this.token = 'm' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.pending = new Map();
    this.seq = 0;
    this.ready = false;
    this.error = '';
    this.tools = [];
    this.commands = [];
    this.hooks = [];
    this.sources = [];
    this.panels = [];
    this.status = '';
    this.logs = [];
    this.onMessage = (e) => this.handle(e);
  }

  start() {
    return new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts'); // no same-origin, no popups, no forms, no top navigation
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
      this.frame = f;
      this.resolveStart = resolve;
      window.addEventListener('message', this.onMessage);
      this.startTimer = setTimeout(() => this.fail('The mod did not finish starting within 6 seconds'), 6000);
      f.srcdoc = modDocument(this.token, this.manifest, this.code);
      document.body.append(f);
    });
  }
  fail(msg) {
    this.error = msg;
    this.ready = false;
    clearTimeout(this.startTimer);
    this.resolveStart?.({ ok: false, error: msg });
    this.resolveStart = null;
    this.host.changed();
  }
  stop() {
    window.removeEventListener('message', this.onMessage);
    clearTimeout(this.startTimer);
    for (const p of this.pending.values()) p.reject(new Error('The mod was stopped'));
    this.pending.clear();
    this.frame?.remove();
    this.ready = false;
  }
  post(m) {
    this.frame?.contentWindow?.postMessage({ __host: this.token, ...m }, '*');
  }
  has(p) {
    return this.manifest.permissions.includes(p);
  }
  async handle(e) {
    const m = e.data;
    if (!m || m.__mod !== this.token || e.source !== this.frame?.contentWindow) return;
    switch (m.type) {
      case 'ready':
        clearTimeout(this.startTimer);
        this.ready = true;
        this.tools = m.tools || [];
        this.commands = m.commands || [];
        this.hooks = m.hooks || [];
        this.sources = m.sources || [];
        this.panels = m.panels || [];
        this.resolveStart?.({ ok: true, tools: this.tools.length, commands: this.commands.length, hooks: this.hooks });
        this.resolveStart = null;
        this.host.changed();
        break;
      case 'error':
        this.fail(m.error || 'The mod failed to start');
        break;
      case 'status':
        this.status = m.text || '';
        this.host.changed();
        break;
      case 'toast':
        this.host.toast(`${this.manifest.name}: ${m.text}`);
        break;
      case 'log':
        this.logs.push(m.text);
        if (this.logs.length > 50) this.logs.shift();
        break;
      case 'result': {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          m.ok ? p.resolve(m.value) : p.reject(new Error(m.error || 'failed'));
        }
        break;
      }
      case 'storage.get':
      case 'storage.set':
      case 'storage.remove':
      case 'fetch':
        this.reply(m);
        break;
    }
  }
  async reply(m) {
    try {
      let value;
      if (m.type === 'fetch') {
        const host = (() => {
          try {
            return new URL(m.url).hostname.toLowerCase();
          } catch {
            return '';
          }
        })();
        if (!(this.has('net:*') || this.has('net:' + host))) throw new Error(`This mod may not connect to ${host || 'that address'} (it must list "net:${host}" in its permissions)`);
        value = await modFetch(m.url, m.opts || {});
      } else {
        if (!this.has('storage')) throw new Error('No storage permission');
        const data = this.host.data(this.manifest.id);
        if (m.type === 'storage.get') value = m.k in data ? data[m.k] : null;
        else if (m.type === 'storage.set') {
          const next = { ...data, [m.k]: m.v };
          if (JSON.stringify(next).length > 256_000) throw new Error('Storage is full (256 KB per mod)');
          this.host.setData(this.manifest.id, next);
          value = true;
        } else {
          const next = { ...data };
          delete next[m.k];
          this.host.setData(this.manifest.id, next);
          value = true;
        }
      }
      this.post({ type: 'reply', id: m.id, ok: true, value });
    } catch (err) {
      this.post({ type: 'reply', id: m.id, ok: false, error: String(err.message || err) });
    }
  }
  invoke(kind, name, payload, timeout) {
    if (!this.ready) return Promise.reject(new Error(this.error || 'The mod is not running'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.manifest.name} took too long (${Math.round(timeout / 1000)} s)`));
      }, timeout);
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.post({ type: 'invoke', id, kind, name, ...payload });
    });
  }
}

/** All running mods + what the app asks of them. */
export class ModHost {
  constructor({ getSettings, save, toast, onChange }) {
    this.getSettings = getSettings;
    this.save = save;
    this.toast = toast;
    this.onChange = onChange;
    this.running = new Map();
  }
  changed() {
    this.onChange?.();
  }
  list() {
    return this.getSettings().mods || [];
  }
  data(id) {
    return (this.getSettings().modData || {})[id] || {};
  }
  setData(id, v) {
    const s = this.getSettings();
    (s.modData ||= {})[id] = v;
    this.save();
  }
  async startAll() {
    for (const m of this.list()) if (m.enabled !== false) await this.startOne(m);
  }
  async startOne(rec) {
    this.stopOne(rec.id);
    const inst = new ModInstance({ id: rec.id, name: rec.name, version: rec.version, permissions: rec.permissions || [] }, rec.code, this);
    this.running.set(rec.id, inst);
    return inst.start();
  }
  stopOne(id) {
    this.running.get(id)?.stop();
    this.running.delete(id);
    this.changed();
  }
  instance(id) {
    return this.running.get(id);
  }
  // --- what the app uses ---
  toolDefs() {
    const out = [];
    for (const inst of this.running.values()) {
      if (!inst.ready) continue;
      for (const t of inst.tools) out.push({ type: 'function', function: { name: toolName(inst.manifest.id, t.name), description: `[mod: ${inst.manifest.name}] ${t.description}`.slice(0, 900), parameters: t.parameters } });
    }
    return out;
  }
  /** Search sources that mods added: asked alongside the built-in engines whenever the assistant uses web_search. */
  searchSources() {
    const out = [];
    for (const inst of this.running.values()) if (inst.ready) for (const s of inst.sources || []) out.push({ mod: inst.manifest.name, name: s.name, inst });
    return out;
  }
  /** → [{ source: 'Mod · name', results: [{title, url, snippet}] , error? }] (a failing source never breaks the search) */
  async runSearchSources(query, opts = {}) {
    const list = this.searchSources();
    return Promise.all(
      list.map(async (s) => {
        const label = `${s.mod} · ${s.name}`;
        try {
          const raw = await s.inst.invoke('source', s.name, { args: { query, opts } }, TIMEOUT.tool);
          const results = (Array.isArray(raw) ? raw : raw?.results || [])
            .map((r) => ({ title: String(r?.title || '').slice(0, 200), url: String(r?.url || '').slice(0, 500), snippet: String(r?.snippet || r?.text || '').slice(0, 500) }))
            .filter((r) => r.title || r.snippet)
            .slice(0, opts.max || 8);
          return { source: label, results };
        } catch (e) {
          return { source: label, results: [], error: String(e.message || e) };
        }
      }),
    );
  }
  async callTool(fullName, args, ctx = {}) {
    for (const inst of this.running.values()) {
      const t = inst.tools.find((x) => toolName(inst.manifest.id, x.name) === fullName);
      if (t) return stringify(await inst.invoke('tool', t.name, { args, ctx }, TIMEOUT.tool));
    }
    throw new Error(`No mod tool called ${fullName}`);
  }
  commands() {
    const out = [];
    for (const inst of this.running.values()) if (inst.ready) for (const c of inst.commands) out.push({ cmd: c.name, title: `${c.description || c.name} · ${inst.manifest.name}`, mod: inst.manifest.id });
    return out;
  }
  async runCommand(cmd, args, ctx = {}) {
    for (const inst of this.running.values()) {
      if (inst.ready && inst.commands.some((c) => c.name === cmd)) return inst.invoke('command', cmd, { args, ctx }, TIMEOUT.command);
    }
    return undefined;
  }
  chips() {
    return [...this.running.values()].filter((i) => i.ready && i.status).map((i) => ({ id: i.manifest.id, name: i.manifest.name, text: i.status }));
  }
  /** Run a hook through every mod that registered it, one after another. A slow or failing mod is skipped. */
  async runHook(event, payload) {
    let cur = payload;
    for (const inst of this.running.values()) {
      if (!inst.ready || !inst.hooks.includes(event)) continue;
      try {
        const r = await inst.invoke('hook', event, { payload: cur }, TIMEOUT.hook);
        if (r != null && event === 'userMessage' && typeof r === 'string') cur = r;
      } catch (e) {
        inst.logs.push('hook ' + event + ': ' + e.message);
        this.toast(`${inst.manifest.name}: ${e.message}`);
      }
    }
    return cur;
  }
  /** Let mods with the "request" permission adjust the prompt just before it is sent. */
  async beforeRequest(messages, info) {
    let cur = messages;
    for (const inst of this.running.values()) {
      if (!inst.ready || !inst.hooks.includes('beforeRequest')) continue;
      try {
        cur = applyRequestEdit(cur, await inst.invoke('hook', 'beforeRequest', { payload: requestView(cur, info) }, TIMEOUT.hook));
      } catch (e) {
        inst.logs.push('beforeRequest: ' + e.message);
        this.toast(`${inst.manifest.name}: ${e.message}`);
      }
    }
    return cur;
  }
  /** Panels mods added: [{ mod, name, description, icon, id }] */
  panelList() {
    const out = [];
    for (const inst of this.running.values()) if (inst.ready) for (const p of inst.panels || []) out.push({ id: inst.manifest.id, mod: inst.manifest.name, ...p });
    return out;
  }
  async renderPanel(id, name) {
    const inst = this.running.get(id);
    if (!inst?.ready) throw new Error('That mod is not running');
    return stringify(await inst.invoke('panel', name, { args: {} }, TIMEOUT.tool));
  }
  /**
   * Mods with the "toolhook" permission see each tool call before it runs. A hook may return
   * { block: 'reason' } to stop it, or { args: {...} } to change what it is called with.
   * → { block?: string, args: object }
   */
  async beforeTool(name, args) {
    let cur = args;
    for (const inst of this.running.values()) {
      if (!inst.ready || !inst.hooks.includes('beforeTool')) continue;
      try {
        const r = await inst.invoke('hook', 'beforeTool', { payload: { name, args: cur } }, TIMEOUT.hook);
        if (r && typeof r === 'object') {
          if (typeof r.block === 'string' && r.block.trim()) return { block: `${inst.manifest.name}: ${r.block.slice(0, 300)}`, args: cur };
          if (r.args && typeof r.args === 'object' && !Array.isArray(r.args)) cur = r.args;
        }
      } catch (e) {
        inst.logs.push('beforeTool: ' + e.message);
      }
    }
    return { args: cur };
  }
  /** After a tool ran: a hook may return { result: 'text' } to replace what the assistant sees. */
  async afterTool(name, args, result) {
    let cur = result;
    for (const inst of this.running.values()) {
      if (!inst.ready || !inst.hooks.includes('afterTool')) continue;
      try {
        const r = await inst.invoke('hook', 'afterTool', { payload: { name, args, result: cur } }, TIMEOUT.hook);
        if (r && typeof r === 'object' && typeof r.result === 'string') cur = r.result.slice(0, 60000);
      } catch (e) {
        inst.logs.push('afterTool: ' + e.message);
      }
    }
    return cur;
  }
  hasHook(event) {
    return [...this.running.values()].some((i) => i.ready && i.hooks.includes(event));
  }
}

export const toolName = (modId, tool) => `mod_${modId.replace(/-/g, '_')}__${tool}`.slice(0, 64);
const stringify = (v) => (v == null ? '(no output)' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/** A plain-text view of the request for a beforeRequest hook (images and tool turns are summarized, never exposed raw). */
export function requestView(messages, info = {}) {
  const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n') : '');
  const [first, ...rest] = messages;
  return {
    model: info.model || '',
    persona: info.persona || null,
    system: first?.role === 'system' ? text(first.content) : '',
    messages: (first?.role === 'system' ? rest : messages).map((m) => ({ role: m.role, content: m.role === 'tool' ? '[tool result]' : text(m.content) || (m.tool_calls ? '[tool call]' : '') })),
  };
}

/** What a beforeRequest hook may change: the system prompt, and messages added after it / at the end. Nothing else. */
export function applyRequestEdit(messages, edit) {
  if (!edit || typeof edit !== 'object') return messages;
  const out = [...messages];
  const ok = (m) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.length < 40000;
  const clean = (l) => (Array.isArray(l) ? l.filter(ok).slice(0, 10).map((m) => ({ role: m.role, content: m.content })) : []);
  if (typeof edit.system === 'string' && out[0]?.role === 'system' && typeof out[0].content === 'string') out[0] = { ...out[0], content: edit.system.slice(0, 200000) };
  const pre = clean(edit.prepend);
  if (pre.length) out.splice(out[0]?.role === 'system' ? 1 : 0, 0, ...pre);
  out.push(...clean(edit.append));
  return out;
}
