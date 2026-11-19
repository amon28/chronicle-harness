// 🖥 PC agents: a chat whose replies come from an ACP agent on your computer (through scripts/acp-bridge.py).
import { $, chatPersona, chatPrompt, el, enabledTools, hooks, state, toast, toolsOn, uid, userName } from './core.js';
import { saveSettings } from '../store.js';
import { httpRequest, setCcTextRunner } from '../api.js';
import { logError } from '../errorlog.js';
import { AcpClient, acpRounds, agentReplyText, readUpdate } from '../acp.js';
import { AGENT_ID, bridgeMcpToken, bridgeSecret, ccErrorText, chatCwd, diagnoseBridge, isAuthError, isOwnBridgeUrl } from '../claudecode.js';
import { chronicleServer, mcpResult, SERVER, toolsLine, userServers } from '../cctools.js';
import { flattenForCc, ORIGIN_MODEL, runClaudeCodeTask, taskSystemPrompt } from '../cctask.js';
import { hostPath, workDir } from '../shellfs.js';
import { effortStep, modelStep, withEarlierTurns } from '../ccmodels.js';
import { newChat, persist, renderConvList } from './chatlist.js';
import { rerenderLast, updateHeader } from './render.js';

const agents = () => (state.settings.acpAgents ||= []);
const clients = new Map(); // agent id → { client, ready: Promise }
const bySession = new Map(); // ACP session id → { conv, msg }
const STOPPED = new Error('stopped'); // Stop pressed before the message reached the agent
const STOP_WAIT = 6000; // after Stop, how long the agent has to end its turn before the chat moves on
const watchers = new Map(); // ACP session id → fn(update): sessions of the app's own (the hidden usage session), in no chat
const permits = new Map(); // ACP session id → fn(params): the permission questions of a hidden session (a model's claude_code task)
// Chronicle's MCP server for Claude Code (decision 166): each chat's session gets /mcp/<handle>; a handle is random,
// made once per chat and app run, and only ever means that chat
const mcpChats = new Map(); // handle → { conv, origin } ('' for the chat's own session, ORIGIN_MODEL for a model's task)
const mcpHandles = new Map(); // conv id → handle
const mcpRuns = new Map(); // conv id (or a task's handle) → Set(AbortController) of its tool calls running now
const newHandle = () => 'c' + uid().replace(/[^A-Za-z0-9]/g, '').slice(0, 20) + Math.random().toString(36).slice(2, 8);
function handleOf(conv) {
  let h = mcpHandles.get(conv.id);
  if (!h) {
    h = newHandle();
    mcpHandles.set(conv.id, h);
  }
  mcpChats.set(h, { conv, origin: '' });
  return h;
}
/** An MCP request Claude Code sent to the bridge: tools/list and tools/call for the chat its handle names. */
async function onMcp({ chat, method, params }) {
  const at = mcpChats.get(chat);
  const conv = at?.conv;
  if (!conv) throw Object.assign(new Error('This chat is not open in Chronicle any more – send the message again from the chat'), { code: -32002 });
  // a hidden task a model started (decision 167): the chat's tools, but no ask_model (no loops)
  const origin = at.origin || '';
  if (method === 'tools/list') return { tools: hooks.ccTools?.(conv, { origin }) || [] };
  if (method !== 'tools/call') throw Object.assign(new Error(`${method} is not offered`), { code: -32601 });
  const ac = new AbortController();
  const key = origin ? chat : conv.id;
  const set = mcpRuns.get(key) || new Set();
  mcpRuns.set(key, set.add(ac));
  try {
    return mcpResult(await hooks.ccRunTool(conv, String(params?.name || ''), params?.arguments || {}, { signal: ac.signal, origin }));
  } finally {
    set.delete(ac);
  }
}
/**
 * The folder a Claude Code chat works in: the chat's own workspace (/chats/<id>), when the app can bind it. `any`: also
 * for a chat that is not a Claude Code chat (a model's claude_code task works in the calling chat's files).
 */
async function chatFolder(conv, any = false) {
  if (!any && !(conv.acp?.agentId === AGENT_ID && (conv.acp.cc || conv.acp.model))) return ''; // the card's chats keep the card's folder
  const name = workDir(conv.id).slice('work/'.length);
  const cwd = await chatCwd(name).catch(() => '');
  if (!cwd) return '';
  await hostPath(workDir(conv.id)); // the folder exists before Claude Code is sent there
  return cwd;
}
hooks.ccChatMounted = (conv) => chatFolder(conv).catch(() => '');

function clientFor(agent) {
  let c = clients.get(agent.id);
  if (c && !c.client.closed) return c;
  // Claude Code in Linux: only the loopback bridge the app started, with the secret it holds in memory
  if (agent.phone && !isOwnBridgeUrl(agent.url)) throw new Error('Claude Code in Linux has no bridge address – start it in Settings › Account & models › Claude Code');
  // a loopback bridge that does not answer is gone (Linux stopped it, Claude Code crashed); a PC's may be a slow network
  const client = new AcpClient({ url: agent.url, secret: agent.phone ? bridgeSecret() : agent.secret, http: (url, o) => (globalThis.__ocmAcpHttp || httpRequest)(url, o), deadAfterMs: agent.phone ? 20000 : 60000 });
  // the phone's bridge: before giving up, Linux is asked whether it is still running, and why not (decision 216)
  if (agent.phone) client.probe = () => (globalThis.__ocmBridgeProbe || diagnoseBridge)();
  client.onUpdate = (u, sid) => {
    // the phone's Claude Code announces its slash commands right after a session opens – often before the app has
    // put that session with its chat (or its hidden job): taken here, whichever session it is (decision 173)
    if (agent.phone && u?.sessionUpdate === 'available_commands_update') {
      const r = readUpdate(u);
      if (r.commands) hooks.ccCommandsSeen?.(r.commands);
    }
    return onUpdate(u, sid);
  };
  client.onPermission = onPermission;
  if (agent.phone) client.onMcp = onMcp; // only the phone's own bridge has the MCP endpoint we hand out
  // a Chronicle tool answered after Claude Code had stopped waiting for it: into the error log (decision 178)
  client.onMcpLate = ({ tool, seconds, error }) => logError('claudecode', `Claude Code had stopped waiting for ${tool || 'a Chronicle tool'} – Chronicle finished it after ${seconds} s, but the answer could not be delivered (${error})`, { tool });
  client.onClose = () => clients.delete(agent.id);
  c = { client, ready: client.start() };
  c.ready.catch(() => clients.delete(agent.id));
  clients.set(agent.id, c);
  return c;
}

/** The reply's text: what the agent said, with its tool calls as lines in between. */
function compose(msg) {
  const { rounds, content } = acpRounds(msg.acpParts);
  msg.rounds = rounds;
  return content;
}
function onUpdate(u, sid) {
  if (watchers.has(sid)) return watchers.get(sid)(u);
  const at = bySession.get(sid);
  if (!at) return;
  const { conv, msg } = at;
  const r = readUpdate(u);
  if (r.text) {
    const last = msg.acpParts[msg.acpParts.length - 1];
    if (last?.t === 'text') last.s += r.text;
    else msg.acpParts.push({ t: 'text', s: r.text });
  }
  if (r.thought) msg.reasoning = (msg.reasoning || '') + r.thought;
  if (r.tool) {
    const t = msg.acpParts.find((p) => p.t === 'tool' && p.id === r.tool.id);
    if (t) Object.assign(t, r.tool);
    else msg.acpParts.push({ t: 'tool', ...r.tool });
  }
  if (r.plan) msg.note = r.plan;
  if (r.commands && conv.acp?.agentId === AGENT_ID) hooks.ccCommandsSeen?.(r.commands);
  if (r.ctx && conv.acp) {
    conv.acp.ctx = { ...r.ctx, at: Date.now() }; // the 🪟 chip shows the agent's own context, not Chronicle's estimate
    if (state.current === conv) hooks.updateContextChip?.();
  }
  if (r.config && at.phone) hooks.ccConfigSeen?.(r.config);
  msg.content = compose(msg);
  if (state.current === conv) rerenderLast();
}
/**
 * The ACP client of Claude Code in Linux, the bridge started (again) when it is not running – for the app's own
 * sessions (the model list, the subscription usage). `watch(sid, fn)` gets a session's updates; they go to no chat.
 */
hooks.ccClient = async () => {
  await hooks.claudeCodeEnsure?.();
  const agent = agents().find((a) => a.id === AGENT_ID);
  if (!agent) throw new Error('Claude Code in Linux is not started');
  const c = clientFor(agent);
  await c.ready;
  return { client: c.client, watch: (sid, fn) => (fn ? watchers.set(sid, fn) : watchers.delete(sid)) };
};
/** A chat let go of its Claude Code session (it picked a normal model): closed, if that connection is live. */
hooks.acpCloseSession = (agentId, sid) => {
  const c = clients.get(agentId);
  if (sid && c && !c.client.closed) c.ready.then(() => c.client.closeSession(sid)).catch(() => {});
  bySession.delete(sid);
};
/** The phone's own Claude Code: its connection is dropped when the bridge is restarted or stopped. */
hooks.acpForget = (agentId) => {
  clients.get(agentId)?.client.close();
  clients.delete(agentId);
};
async function onPermission(p) {
  if (permits.has(p.sessionId)) return permits.get(p.sessionId)(p); // a hidden task's question: its own wording, its chat
  const at = bySession.get(p.sessionId) || [...bySession.values()].at(-1);
  const opts = p.options || [];
  if (!opts.length) return null;
  const title = p.toolCall?.title || 'do something';
  const ans = await hooks.askUser({ questions: [{ question: `${at?.phone ? 'Claude Code wants to' : 'The agent on your PC wants to'}: ${title}`, options: opts.map((o) => o.name) }], convId: at?.conv.id, convTitle: at?.conv.title || 'PC agent' });
  const pick = opts.find((o) => o.name === ans?.[0]);
  return pick?.optionId || null;
}

/**
 * A task one of Chronicle's models handed to Claude Code with the claude_code tool (decision 167): a hidden session of
 * the user's Claude Code (in no chat's messages) in the calling chat's folder, with the chat's skills, its Chronicle
 * tools (without ask_model: no loops) and the user's MCP servers; Claude Code's permission questions go to the chat's
 * ask sheet; Stop cancels it; the session is closed afterwards. → { text, steps, stopReason, cancelled, model }
 */
hooks.ccTask = async (conv, { task, model = '', effort = '', signal, onProgress = () => {} }) => {
  onProgress({ phase: 'Starting Claude Code…', steps: [] });
  await hooks.claudeCodeEnsure?.();
  const agent = agents().find((a) => a.id === AGENT_ID);
  if (!agent) throw new Error('Claude Code in Linux did not start');
  const c = clientFor(agent);
  await c.ready;
  const folder = await chatFolder(conv, true);
  const cwd = folder || agent.cwd || '/root';
  await hooks.ccSyncSkills?.().catch(() => {});
  const handle = newHandle();
  mcpChats.set(handle, { conv, origin: ORIGIN_MODEL });
  let toolNames = (hooks.ccTools?.(conv, { origin: ORIGIN_MODEL }) || []).map((t) => t.name);
  const token = bridgeMcpToken();
  if (!token) toolNames = [];
  const own = userServers(state.settings.mcpServers, { on: toolsOn(conv) && enabledTools(conv).mcp !== false });
  const mcpServers = [...(toolNames.length ? [chronicleServer(agent.url, handle, token)] : []), ...own.list];
  const meta = { claudeCode: { options: { ...(toolNames.length ? { allowedTools: [`mcp__${SERVER}__*`] } : {}), ...(own.deny.length ? { disallowedTools: own.deny } : {}) } } };
  const stopTools = () => {
    for (const ac of mcpRuns.get(handle) || []) ac.abort(); // a Chronicle tool it is running stops too
  };
  signal?.addEventListener('abort', stopTools, { once: true });
  if (folder) await hooks.ccSyncWorkspace?.(conv, 'a').catch(() => {}); // the chat's files, into the folder
  try {
    return await runClaudeCodeTask({
      client: c.client,
      watch: (sid, fn) => (fn ? watchers.set(sid, fn) : watchers.delete(sid)),
      permit: (sid, fn) => (fn ? permits.set(sid, fn) : permits.delete(sid)),
      ask: (question, options, sig) => hooks.askUser({ questions: [{ question, options }], convId: conv.id, convTitle: conv.title || 'a chat', signal: sig }).then((a) => a?.[0]),
      cwd,
      task,
      model,
      effort: effort || '',
      systemPrompt: taskSystemPrompt({ toolsLine: toolsLine(toolNames, folder), cwd: folder }),
      mcpServers,
      meta,
      signal,
      onProgress,
    });
  } catch (e) {
    throw isAuthError(e) ? new Error(ccErrorText(e)) : e;
  } finally {
    signal?.removeEventListener?.('abort', stopTools);
    mcpChats.delete(handle);
    mcpRuns.delete(handle);
    if (folder) await hooks.ccSyncWorkspace?.(conv, 'b').catch(() => {}); // what Claude Code wrote, into the chat's 📁
  }
};

/**
 * Background jobs on the user's Claude Code (decision 169): learning, the helper's one-shot jobs, the advisor… each is
 * a hidden session with no tools at all (Claude Code only writes text), closed afterwards. One at a time: every job is
 * a Claude Code process under proot, and several at once would only slow each other down.
 */
let ccTextQueue = Promise.resolve();
setCcTextRunner(({ value, messages }, h) => {
  const ac = new AbortController();
  const job = async () => {
    if (ac.signal.aborted) throw new Error('Stopped');
    await hooks.claudeCodeEnsure?.();
    const agent = agents().find((a) => a.id === AGENT_ID);
    if (!agent) throw new Error('Claude Code in Linux did not start');
    const c = clientFor(agent);
    await c.ready;
    const { system, task } = flattenForCc(messages);
    const r = await runClaudeCodeTask({
      client: c.client,
      watch: (sid, fn) => (fn ? watchers.set(sid, fn) : watchers.delete(sid)),
      permit: (sid, fn) => (fn ? permits.set(sid, fn) : permits.delete(sid)),
      ask: async () => null, // nothing to allow: it has no tools
      cwd: agent.cwd || '/root',
      task,
      model: value && value !== 'default' ? value : '',
      systemPrompt: [system, 'This is a background text job for the Chronicle app: answer with the requested text only, without tools.'].filter(Boolean).join('\n\n'),
      meta: { claudeCode: { options: { tools: [] } } },
      signal: ac.signal,
    });
    if (r.cancelled) throw new Error('Stopped');
    if (!r.text) throw new Error('Claude Code gave no answer');
    return r.text;
  };
  const run = ccTextQueue.then(job);
  ccTextQueue = run.catch(() => {});
  run.then(
    (text) => {
      h.onContent?.(text);
      h.onDone?.();
    },
    (e) => h.onError?.(isAuthError(e) ? new Error(ccErrorText(e)) : e),
  );
  return { cancel: () => ac.abort() };
});

hooks.acpRespond = async (conv) => {
  let agent = agents().find((a) => a.id === conv.acp.agentId);
  // a chat that picked Claude Code in the model picker: the bridge is started on the first message (no card needed)
  const picked = conv.acp.agentId === AGENT_ID && (conv.acp.cc || conv.acp.model);
  const ccName = picked ? hooks.ccModelName?.(conv.acp.model) : '';
  const msg = { role: 'assistant', content: '', streaming: true, at: Date.now(), model: ccName ? (ccName.startsWith('Claude Code') ? 'Claude Code' : `Claude Code · ${ccName}`) : agent?.name || (picked ? 'Claude Code' : 'PC agent'), personaId: conv.personaId, acpParts: [] };
  conv.messages.push(msg);
  rerenderLast();
  // Stop works at every step: while Claude Code is still starting nothing is sent; while it answers it is asked to
  // stop, and the reply ends here after a short wait even if the agent never says it stopped
  let onStop = null;
  let wake = null;
  const stopped = new Promise((res) => (wake = res));
  const run = {
    stopped: false,
    cancel() {
      run.stopped = true;
      onStop?.();
      wake();
    },
  };
  const stopP = stopped.then(() => Promise.reject(STOPPED));
  stopP.catch(() => {}); // only ever awaited through step()
  const step = (p) => Promise.race([p, stopP]);
  hooks.beginRun(conv, run);
  let folder = '';
  let sent = false; // the message reached Claude Code's session
  try {
    if (!agent && !picked) throw new Error('This PC agent was removed in Settings');
    // Claude Code in Linux: started (again) when it is not running – after the app restarted the secret is gone
    if (picked || agent.phone) {
      await step(hooks.claudeCodeEnsure?.());
      agent = agents().find((a) => a.id === conv.acp.agentId) || agent;
      if (!agent) throw new Error('it did not start');
    }
    const cc = !!(picked || agent.phone);
    // a picker chat works in its own workspace (its files show in 📁); the card's chats in the card's folder
    folder = cc ? await step(chatFolder(conv)) : '';
    const cwd = agent.phone ? folder || agent.cwd || '/root' : '.';
    const c = clientFor(agent);
    await step(c.ready);
    // Claude Code gets Chronicle's skills (~/.claude/skills), its phone tools (the "chronicle" MCP server on the
    // bridge) and the user's own MCP servers (decision 166)
    let mcpServers = [];
    let meta = null;
    let toolNames = [];
    if (cc) {
      await step(hooks.ccSyncSkills?.().catch(() => {}));
      toolNames = (hooks.ccTools?.(conv) || []).map((t) => t.name);
      const token = bridgeMcpToken();
      const own = userServers(state.settings.mcpServers, { on: toolsOn(conv) && enabledTools(conv).mcp !== false });
      mcpServers = [...(token && toolNames.length ? [chronicleServer(agent.url, handleOf(conv), token)] : []), ...own.list];
      if (!token) toolNames = [];
      // Chronicle asks for its own tools itself (your permissions, Ask first, Bypass): Claude Code need not ask again
      meta = { claudeCode: { options: { ...(toolNames.length ? { allowedTools: [`mcp__${SERVER}__*`] } : {}), ...(own.deny.length ? { disallowedTools: own.deny } : {}) } } };
      if (folder) await step(hooks.ccSyncWorkspace?.(conv, 'a').catch(() => {})); // files the user added, into the folder
    }
    let sid = conv.acp.sessionId;
    if (sid && !c.client.sessions?.has(sid)) {
      // the app (or the bridge) restarted: pick the session up again if the agent can, else start a new one
      const loaded = await step(c.client.loadSession(sid, cwd, { mcpServers, meta }).catch(() => false));
      if (!loaded) sid = null;
    }
    // the chat's persona (Lia, a custom assistant…) goes with the session: Claude Code otherwise only answers as
    // itself. A persona or prompt changed since the session began: a new session, with the chat so far as context
    // (also when the folder, the tools or the MCP servers changed: Claude Code reads those when a session starts)
    const persona = cc ? personaPrompt(conv, { tools: toolNames, cwd: folder }) : '';
    const shape = cc ? [cwd, toolNames.join(','), mcpServers.map((x) => x.name + '@' + (x.url || x.args?.join(' ') || '')).join(',')].join('|') : '';
    const sigOf = (t) => (t ? String(t.length) + ':' + t.slice(0, 64) + t.slice(-64) : '');
    const sig = sigOf(persona) + (cc ? '#' + sigOf(shape) : '');
    if (sid && (conv.acp.promptSig || '') !== sig) {
      c.client.closeSession?.(sid).catch?.(() => {});
      sid = null;
    }
    // the chat changed since the session last saw it (a message edited and resent, a reply retried or edited, a
    // swipe, messages deleted): Claude Code would answer from a conversation the chat no longer has – a new session,
    // with the chat as it is now as context
    const li = conv.messages.findLastIndex((m) => m.role === 'user');
    if (sid && cc && conv.acp.seen && conv.acp.seen !== historySig(conv.messages.slice(0, Math.max(0, li)))) {
      c.client.closeSession?.(sid).catch?.(() => {});
      sid = null;
    }
    let fresh = false;
    if (!sid) {
      sid = await step(c.client.newSession(cwd, { systemPrompt: persona, mcpServers, meta }));
      conv.acp.promptSig = sig;
      fresh = true;
      if (conv.acp.sessionId && !picked && !agent.phone) msg.acpParts.push({ t: 'text', s: `_(A new session ${agent.phone ? 'of Claude Code' : 'on the PC'} – it does not remember the earlier turns.)_\n\n` });
      conv.acp.sessionId = sid;
    }
    if (picked) {
      // the model picked for this chat, then the 🧠 effort for it (when that model has effort levels)
      const ms = modelStep(c.client.configs.get(sid), conv.acp.model);
      if (ms) await step(c.client.setConfigOption(sid, ...ms));
      const eff = effortStep(c.client.configs.get(sid), state.settings.effort?.[`cc:${conv.acp.model || 'default'}`]);
      if (eff) await step(c.client.setConfigOption(sid, ...eff).catch(() => {}));
      if (c.client.configs.get(sid)) hooks.ccConfigSeen?.(c.client.configs.get(sid));
    }
    (c.client.sessions ||= new Set()).add(sid);
    bySession.set(sid, { conv, msg, phone: !!agent.phone });
    onStop = () => {
      c.client.cancel(sid);
      for (const ac of mcpRuns.get(conv.id) || []) ac.abort(); // a Chronicle tool it is running stops too
    };
    if (run.stopped) throw STOPPED;
    const last = conv.messages[li];
    // a chat that comes to Claude Code with messages already in it: the new session gets them as context
    let text = (picked || agent.phone) && fresh ? withEarlierTurns(conv.messages.slice(0, Math.max(0, li)).map((m) => (m.acpParts?.length ? { ...m, content: agentReplyText(m.acpParts) } : m)), last?.content || '') : last?.content || '';
    // an agent that takes no system prompt: the persona at the top of the session's first message instead
    if (fresh && persona && !c.client.takesSystemPrompt) text = `[How to act in this chat]\n${persona}\n\n${text}`;
    // pictures attached to this message are in the chat's own folder (synced before the turn): Claude Code opens them
    if (picked && folder && last?.imagePaths?.length) text += `\n\n[Pictures attached to this message, saved in this folder: ${last.imagePaths.join(', ')} – open them with your Read tool to see them]`;
    sent = cc;
    // after Stop: the agent's own end of the turn, or this chat moves on after a few seconds without it
    const r = await Promise.race([c.client.prompt(sid, text), stopped.then(() => new Promise((res) => setTimeout(() => res({ stopReason: 'cancelled' }), STOP_WAIT)))]);
    if (r?.stopReason && r.stopReason !== 'end_turn') msg.acpParts.push({ t: 'text', s: `\n\n_(stopped: ${r.stopReason})_` });
  } catch (e) {
    if (e === STOPPED) {
      if (!msg.acpParts.length) msg.acpParts.push({ t: 'text', s: '_(stopped before it was sent)_' });
    } else msg.error = picked || agent?.phone ? ccErrorText(e) : `The agent on your PC: ${e.message}`;
    if (msg.error) logError(picked || agent?.phone ? 'claudecode' : 'reply', msg.error, { conv: conv.id, title: conv.title, model: msg.model });
  } finally {
    if (folder) await hooks.ccSyncWorkspace?.(conv, 'b').catch(() => {}); // what Claude Code wrote, into the chat's 📁
    msg.content = compose(msg);
    msg.streaming = false;
    delete msg.note;
    if (sent && conv.acp) conv.acp.seen = historySig(conv.messages); // the chat as this session knows it
    hooks.endRun(conv, run, { finished: true });
    persist(conv);
    if (state.current === conv) rerenderLast();
    hooks.replyDone?.(msg);
  }
  return msg;
};

/** A short fingerprint of a chat's messages as an agent's session saw them (what was said, by whom, hidden or not). */
export function historySig(messages) {
  let h = 2166136261;
  let n = 0;
  for (const m of messages || []) {
    if (m.greeting) continue;
    const t = `${m.role}|${m.hidden ? 1 : 0}|${m.content || ''}\n`;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
    n++;
  }
  return `${n}:${(h >>> 0).toString(36)}`;
}

/**
 * What the chat's persona asks of Claude Code: its name and prompt, framed so Claude Code keeps working as itself
 * (tools, rules) but speaks as the persona. The default assistant with no prompt adds nothing.
 */
export function personaPrompt(conv, { tools = [], cwd = '' } = {}) {
  const p = chatPersona(conv);
  const prompt = String(chatPrompt(conv) || '').trim();
  // Chronicle's phone tools, as the "chronicle" MCP tools (decision 166) – and whether a phone folder is linked, so it is
  // known before the first phone_* call fails (harness report G6)
  const folderLine = tools.includes('phone_folder') ? (conv.phoneFolder ? ` The phone folder "${conv.phoneFolder.name}" is linked to this chat.` : ' No phone folder is linked to this chat yet: phone_folder (action link) asks the user to pick one, and it stays linked in this chat.') : '';
  const line = toolsLine(tools, cwd) + (toolsLine(tools, cwd) ? folderLine : '');
  if (!p || (!prompt && (p.id === 'general' || !p.name))) return line;
  const name = p.name || 'the assistant';
  return [
    `In this chat you are ${name}${p.description ? ` – ${p.description}` : ''}. When asked who you are, you are ${name}. Speak and behave as ${name} throughout; you can still use all your tools and follow your working rules.`,
    prompt ? `${name}'s instructions:\n${prompt}` : '',
    userName(conv) !== 'User' ? `The user is called ${userName(conv)}.` : '',
    line,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderAgents() {
  const list = $('#acp-list');
  list.innerHTML = '';
  if (!agents().length) list.append(el('p', 'hint pad', 'No PC agents yet.'));
  for (const a of agents()) {
    const row = el('div', 'persona-item');
    const t = el('div', 'persona-text');
    t.append(el('div', 'persona-title', a.name), el('div', 'persona-desc', a.phone ? `🐧 in this phone's Linux · ${a.cwd || '/root'}` : a.url));
    const chat = el('button', 'act', 'New chat');
    chat.onclick = () => hooks.acpNewChat(a);
    const rm = el('button', 'act', 'Remove');
    rm.onclick = () => {
      state.settings.acpAgents = agents().filter((x) => x !== a);
      clients.get(a.id)?.client.close();
      clients.delete(a.id);
      saveSettings(state.settings);
      renderAgents();
    };
    row.append(t, chat, rm);
    list.append(row);
  }
}
/** A new chat whose messages go to this ACP agent. */
hooks.acpNewChat = (a) => {
  document.querySelectorAll('.sheet.open [data-close]').forEach((x) => x.click());
  newChat({ focus: true });
  state.current.acp = { agentId: a.id };
  state.current.title = a.phone ? a.name : `🖥 ${a.name}`;
  updateHeader();
  renderConvList();
  toast(`Messages in this chat go to ${a.name}`);
};
hooks.renderAcpAgents = () => $('#acp-list') && renderAgents();
$('#acp-add').onclick = () => {
  const url = $('#acp-url').value.trim().replace(/\/+$/, '');
  const secret = $('#acp-secret').value.trim();
  if (!/^https?:\/\/[^\s]+$/.test(url)) return toast('Enter the address acp-bridge printed (http://…:8765)');
  if (!secret) return toast('Enter the secret acp-bridge printed');
  agents().push({ id: 'acp_' + uid().slice(0, 8), name: $('#acp-name').value.trim() || 'PC agent', url, secret });
  saveSettings(state.settings);
  $('#acp-url').value = $('#acp-secret').value = $('#acp-name').value = '';
  renderAgents();
};
$('#acp-box').addEventListener('toggle', () => $('#acp-box').open && renderAgents());
