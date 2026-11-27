// 🖥 PC agents: a chat whose replies come from an ACP agent on your computer (through scripts/acp-bridge.py).
import { $, chatPersona, chatPrompt, el, enabledTools, hooks, pref, state, toast, toolsOn, uid, userName } from './core.js';
import { perfReport } from '../perf.js';
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
/** Claude Code in Linux is running (its bridge answers): Linux is up, a look at its processes starts nothing new. */
hooks.ccBridgeUp = () => !!clients.get(AGENT_ID) && !clients.get(AGENT_ID).client.closed;
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
    const r = await hooks.ccRunTool(conv, String(params?.name || ''), params?.arguments || {}, { signal: ac.signal, origin });
    // a picture Claude Code showed you (show_image, decision 225): under its reply, like in any chat
    if (!origin && r?.display?.shown?.length) {
      const m = conv.messages.at(-1);
      if (m?.role === 'assistant') {
        (m.shownImages ||= []).push(r.display);
        if (state.current === conv) rerenderLast();
      }
    }
    return mcpResult(r);
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
  // the answer to a permission question could not be delivered, even after retries: said, not left hanging (decision 254)
  client.onPermissionLost = (p) => {
    logError('claudecode', `Your answer to "${p?.toolCall?.title || 'a permission question'}" did not reach Claude Code – it may still be waiting for it. Stop the reply and send again.`);
    toast('Your answer did not reach Claude Code – Stop the reply and send again', 6000);
  };
  if (agent.phone) client.onMcp = onMcp; // only the phone's own bridge has the MCP endpoint we hand out
  // a Chronicle tool answered after Claude Code had stopped waiting for it: into the error log (decision 178)
  client.onMcpLate = ({ tool, seconds, error }) => logError('claudecode', `Claude Code had stopped waiting for ${tool || 'a Chronicle tool'} – Chronicle finished it after ${seconds} s, but the answer could not be delivered (${error})`, { tool });
  client.onClose = () => clients.delete(agent.id);
  c = { client, ready: client.start() };
  c.ready.catch(() => clients.delete(agent.id));
  clients.set(agent.id, c);
  return c;
}

/** What Claude Code reads when a session starts – its MCP servers and the tool options (a model's hidden task passes
 * its own handle and origin): one place for a send's new session, the ladder's reopen and the prewarm, so a session picked up early is the one the send would have made. */
function ccSessionArgs(conv, agent, origin = '', handle = null) {
  const all = (hooks.ccTools?.(conv, { origin }) || []).map((t) => t.name);
  const token = bridgeMcpToken();
  const own = userServers(state.settings.mcpServers, { on: toolsOn(conv) && enabledTools(conv).mcp !== false });
  const toolNames = token ? all : []; // without the bridge's token the phone tools do not reach Claude Code
  const mcpServers = [...(toolNames.length ? [chronicleServer(agent.url, handle || handleOf(conv), token)] : []), ...own.list];
  // Chronicle asks for its own tools itself (your permissions, Ask first, Bypass): Claude Code need not ask again
  const meta = { claudeCode: { options: { ...(toolNames.length ? { allowedTools: [`mcp__${SERVER}__*`] } : {}), ...(own.deny.length ? { disallowedTools: own.deny } : {}) } } };
  return { toolNames, mcpServers, meta };
}

/** A session that died (the app's Linux was stopped while the chat was away) is picked up when the chat is shown,
 * not when you press send – quiet, and a failure changes nothing: the send's own ladder says what is wrong then.
 * cGiven ({ client, ready, cwd }: tests) stands in for the looked-up client. */
const prewarming = new WeakMap(); // conv → the pick-up in progress: a send waits for it instead of doing it twice
hooks.ccPrewarm = (conv, cGiven = null) => {
  if (!conv?.acp?.sessionId || prewarming.has(conv) || state.runs?.has?.(conv.id)) return prewarming.get(conv);
  const p = prewarm(conv, cGiven);
  prewarming.set(conv, p);
  return p;
};
async function prewarm(conv, cGiven) {
  try {
    const agent = cGiven ? null : agents().find((a) => a.id === conv.acp.agentId);
    if (!cGiven && !agent) return;
    const c = cGiven || clientFor(agent);
    await c.ready; // the initialize reply (what this adapter can do) is only there after this
    const sid = conv.acp.sessionId;
    if (c.client.sessions?.has(sid)) return;
    const folder = agent?.phone ? await chatFolder(conv).catch(() => '') : '';
    const cwd = cGiven?.cwd ?? (agent?.phone ? folder || agent.cwd || '/root' : '.');
    const { mcpServers, meta } = agent?.phone ? ccSessionArgs(conv, agent) : { mcpServers: [], meta: null };
    const quiet = (p, secs) => {
      let t;
      return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`did not finish in ${secs} s`)), secs * 1000)))]).finally(() => clearTimeout(t));
    };
    // the send's ladder, its order: acp.js answers false at once when the adapter cannot load or resume, so a
    // capability that is not there costs nothing here either
    const a = await quiet(c.client.loadSession(sid, cwd, { mcpServers, meta }), 120).then((ok) => ({ ok: !!ok }), () => ({ ok: false }));
    const b = a.ok ? a : await quiet(c.client.resumeSession?.(sid, cwd, { mcpServers, meta }) ?? false, 120).then((ok) => ({ ok: !!ok }), () => ({ ok: false }));
    if (b.ok) (c.client.sessions ||= new Set()).add(sid); // what the send checks: with the sid here it skips its ladder
  } catch {
    /* quiet: the send's own ladder says what is wrong */
  } finally {
    prewarming.delete(conv);
  }
}

/** The reply's text: what the agent said, with its tool calls as lines in between. */
function compose(msg) {
  const { rounds, content } = acpRounds(msg.acpParts);
  msg.rounds = rounds;
  return content;
}
/** One rebuild and render per burst of chunks (the parts themselves are kept at once): a long turn is linear now. */
const composing = new Map(); // msg → its pending compose timer
function composeSoon(msg, conv) {
  if (composing.has(msg)) return;
  composing.set(msg, setTimeout(() => {
    composing.delete(msg);
    msg.content = compose(msg);
    if (state.current === conv) rerenderLast();
  }, 120));
}
function onUpdate(u, sid) {
  if (watchers.has(sid)) return watchers.get(sid)(u);
  const at = bySession.get(sid);
  if (!at) return;
  const { conv, msg } = at;
  const r = readUpdate(u);
  if (at.timing && !at.timing.first && (r.text || r.thought || r.tool)) at.timing.first = performance.now();
  // the point before the message this turn answers: a retry or an edit of it forks the session there (decision 253)
  // (with the session it belongs to: a turn that announces none – the first one in a forked or resumed session, which
  // holds nothing to anchor it to – keeps the one before, and a fork goes back to that session's stored history, 255)
  if (r.cursor && at.user && !at.cursorTaken) {
    at.cursorTaken = true;
    at.user.acpCursor = r.cursor;
    at.user.acpCursorSid = sid;
  }
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
  composeSoon(msg, conv);
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
hooks.acpCloseSession = (agentId, sid, conv = null) => {
  const c = clients.get(agentId);
  if (sid && c && !c.client.closed) c.ready.then(() => c.client.closeSession(sid)).catch(() => {});
  bySession.delete(sid);
  // the chat's handle and its tool runs go with the session: a deleted chat's conv is not kept alive
  if (conv) {
    const h = mcpHandles.get(conv.id);
    if (h) mcpChats.delete(h);
    mcpHandles.delete(conv.id);
    mcpRuns.delete(conv.id);
  }
};
/** The phone's own Claude Code: its connection is dropped when the bridge is restarted or stopped. */
hooks.acpForget = (agentId) => {
  clients.get(agentId)?.client.close();
  clients.delete(agentId);
};
async function onPermission(p) {
  if (permits.has(p.sessionId)) return permits.get(p.sessionId)(p); // a hidden task's question: its own wording, its chat
  // a question goes to the chat that owns its session – never to whichever chat was touched last
  let at = bySession.get(p.sessionId);
  if (!at) {
    const conv = state.convs.find((x) => x.acp?.sessionId === p.sessionId);
    if (conv) at = { conv, phone: conv.acp.agentId === AGENT_ID };
  }
  if (!at) {
    logError('claudecode', 'A permission question came from a session no chat owns – answered "cancelled"', { session: p.sessionId });
    return null;
  }
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
  // the chat's own session's shape, with this task's handle and tools (origin: without ask_model)
  const { toolNames, mcpServers, meta } = ccSessionArgs(conv, agent, ORIGIN_MODEL, handle);
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
const CC_TEXT_LIMIT_MS = globalThis.__ocmCcTextLimitMs || 5 * 60 * 1000;
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
  // one job at a time – and a job that never answers (a session that does not start, a prompt with no end) gives up
  // after 5 minutes or on its Stop, so the jobs after it are not held up for good (decision 256)
  const limited = () =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => (reject(new Error('Claude Code did not answer this background job in 5 minutes')), ac.abort()), CC_TEXT_LIMIT_MS);
      const onAbort = () => reject(new Error('Stopped'));
      ac.signal.addEventListener('abort', onAbort, { once: true });
      job().then(resolve, reject).finally(() => (clearTimeout(t), ac.signal.removeEventListener('abort', onAbort)));
    });
  const run = ccTextQueue.then(limited);
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

// the inspector's "Next reply" for a chat on Claude Code: the prompt its session starts with, and what goes with your
// next message (decision 241). A session already running keeps the prompt it started with.
hooks.agentPreview = (conv) => {
  const picked = conv.acp.agentId === AGENT_ID && (conv.acp.cc || conv.acp.model);
  const ccName = picked ? hooks.ccModelName?.(conv.acp.model) : '';
  const label = ccName ? (ccName.startsWith('Claude Code') ? ccName : `Claude Code · ${ccName}`) : agents().find((a) => a.id === conv.acp.agentId)?.name || 'PC agent';
  const turn = picked ? hooks.rpTurnContext?.(conv) || '' : '';
  const next = (turn ? `[Roleplay context for this reply – follow it, never mention it]\n${turn}\n[End of context]\n\n` : '') + '(your next message)';
  const system = picked ? personaPrompt(conv) : '';
  return {
    label,
    preview: true,
    persona: chatPersona(conv)?.name,
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: next }],
    note: conv.acp.sessionId ? 'The session is already running: it keeps the prompt it started with (a changed prompt starts a new one).' : 'The first message starts a session with this prompt.',
  };
};
hooks.acpRespond = async (conv) => {
  let agent = agents().find((a) => a.id === conv.acp.agentId);
  // the turn begins: the last turn's entry is dropped, so history replayed by a session/load cannot land in a finished reply
  bySession.delete(conv.acp?.sessionId);
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
  // what it is doing, under the dots – a step that hangs is seen, and ends with its name instead of spinning forever
  const stage = (s) => {
    msg.note = s;
    if (state.current === conv) rerenderLast();
  };
  const within = (p, secs, what) => {
    let t;
    const late = new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what} did not finish in ${secs} s`)), secs * 1000)));
    return step(Promise.race([p, late]).finally(() => clearTimeout(t)));
  };
  let watch = null;
  // 🩺 how long each step took (decision 251): kept in the Timing history when Timings is on
  const timing = { t0: performance.now(), marks: [], first: 0, others: [...state.runs.keys()].filter((id) => id !== conv.id && state.convs.find((x) => x.id === id)?.acp).length };
  const mark = (name) => timing.marks.push([name, performance.now()]);
  hooks.beginRun(conv, run);
  let folder = '';
  let sent = false; // the message reached Claude Code's session
  let entryKey = null; // this turn's bySession key, taken back when the turn ends
  let forked = false; // this turn forked the session; rolled back if the send failed
  let priorSid = null; // the session id the fork came from
  const liAt = conv.messages.findLast((m) => m.role === 'user'); // the user message this reply answers, pinned before any step (edits mid-turn must not retarget it)
  try {
    if (!agent && !picked) throw new Error('This PC agent was removed in Settings');
    // Claude Code in Linux: started (again) when it is not running – after the app restarted the secret is gone
    if (picked || agent.phone) {
      stage('starting Claude Code…');
      const wasUp = !!hooks.ccBridgeUp?.();
      await within(Promise.resolve(hooks.claudeCodeEnsure?.()), 180, 'Starting Claude Code');
      mark(wasUp ? 'Claude Code was running' : 'Claude Code started (it was not running)');
      agent = agents().find((a) => a.id === conv.acp.agentId) || agent;
      if (!agent) throw new Error('it did not start');
    }
    const cc = !!(picked || agent.phone);
    // a picker chat works in its own workspace (its files show in 📁); the card's chats in the card's folder
    folder = cc ? await within(chatFolder(conv), 60, "Finding this chat's folder in Linux") : '';
    mark("chat's folder found");
    const cwd = agent.phone ? folder || agent.cwd || '/root' : '.';
    const c = clientFor(agent);
    stage(cc ? 'connecting to Claude Code…' : 'connecting to the agent on your PC…');
    await within(c.ready, 90, cc ? 'Connecting to Claude Code' : 'Connecting to the PC agent');
    mark('connected');
    // Claude Code gets Chronicle's skills (~/.claude/skills), its phone tools (the "chronicle" MCP server on the
    // bridge) and the user's own MCP servers (decision 166)
    let mcpServers = [];
    let meta = null;
    let toolNames = [];
    if (cc) {
      await within(Promise.resolve(hooks.ccSyncSkills?.()).catch(() => {}), 60, 'Copying the skills').catch((e) => (e === STOPPED ? Promise.reject(e) : null));
      mark('skills copied');
      ({ toolNames, mcpServers, meta } = ccSessionArgs(conv, agent));
      if (folder) {
        stage("syncing this chat's files with Linux…");
        await within(Promise.resolve(hooks.ccSyncWorkspace?.(conv, 'a')).catch(() => {}), 180, "Syncing this chat's files"); // files the user added, into the folder
        mark("chat's files synced");
      }
    }
    // a pick-up of this chat's session started when it was shown: waited for, not done a second time beside it (254)
    const warming = prewarming.get(conv);
    if (warming) {
      stage('picking up the earlier session…');
      await within(warming.catch(() => {}), 250, 'Picking up the session').catch((e) => (e === STOPPED ? Promise.reject(e) : null));
    }
    let sid = conv.acp.sessionId;
    // why a new session starts, when one does (decision 234): said in the reply and kept in the error log – it costs the
    // whole chat as context again, so "the chat changed" must not stand in for every reason
    let why = '';
    if (sid && !c.client.sessions?.has(sid)) {
      // Claude Code was started again (Android stops the app's Linux after a while in the background), or the app was:
      // the session is still on disk – reopened by session/load, else session/resume
      stage('picking up the earlier session…');
      const tryBack = (fn) => within(fn(), 120, 'Picking up the session').then((ok) => ({ ok }), (e) => (e === STOPPED ? Promise.reject(e) : { ok: false, err: String(e?.message || e) }));
      // session/load is paid only when the adapter said it can load: an adapter that cannot only answers after its
      // whole budget, for nothing. No capabilities reported (an older adapter): both are tried, as before.
      const caps = c.client.info?.agentCapabilities;
      const a = caps && caps.loadSession === false ? { ok: false } : await tryBack(() => c.client.loadSession(sid, cwd, { mcpServers, meta }));
      const b = a.ok ? a : await tryBack(() => c.client.resumeSession?.(sid, cwd, { mcpServers, meta }) ?? Promise.resolve(false));
      mark(b.ok ? 'earlier session reopened' : 'earlier session could not be reopened');
      if (!b.ok) {
        const err = a.err || b.err || '';
        why = `Claude Code had been restarted (Android stops the app's Linux after a while in the background) and could not reopen this chat's session${err ? ` (${err.slice(0, 160)})` : c.client.info?.agentCapabilities?.loadSession || c.client.info?.agentCapabilities?.sessionCapabilities?.resume ? '' : ' – this Claude Code cannot reopen sessions'}`;
        sid = null;
      }
    }
    // the chat's persona (Lia, a custom assistant…) goes with the session: Claude Code otherwise only answers as
    // itself. A persona or prompt changed since the session began: a new session, with the chat so far as context
    // (also when the folder, the tools or the MCP servers changed: Claude Code reads those when a session starts)
    const persona = cc ? personaPrompt(conv, { tools: toolNames, cwd: folder }) : '';
    // what Claude Code reads when a session starts. Chronicle's own MCP server only by its name: its address carries the
    // bridge's port and this run's handle, which are new after every restart – and a session reopened later is handed
    // the new address anyway (decision 235). Tools sorted: a different order is no change.
    const servers = mcpServers.map((x) => (x.name === SERVER ? x.name : x.name + '@' + (x.url || x.args?.join(' ') || ''))).sort().join(',');
    const shape = cc ? [cwd, [...toolNames].sort().join(','), servers] : [];
    const sigOf = (t) => (t ? String(t.length) + ':' + t.slice(0, 64) + t.slice(-64) : '');
    // 'v2:' marks this form (folder | tools | servers, each on its own): an earlier one-piece form is told apart by it
    const sig = sigOf(persona) + (cc ? '#v2:' + shape.map(sigOf).join('|') : '');
    // a chat saved by an earlier version (its setup in one piece): taken as it is when the persona is the same – updating
    // the app should not cost a new session
    const old = String(conv.acp.promptSig || '').split('#');
    if (sid && cc && old[1] && !old[1].startsWith('v2:') && old[0] === sig.split('#')[0]) conv.acp.promptSig = sig;
    if (sid && (conv.acp.promptSig || '') !== sig) {
      c.client.closeSession?.(sid).catch?.(() => {});
      sid = null;
      const was = String(conv.acp.promptSig || '').split('#');
      const now = sig.split('#');
      const [wf, wt, wm] = String(was[1] || '').replace(/^v2:/, '').split('|');
      const [nf, nt, nm] = String(now[1] || '').replace(/^v2:/, '').split('|');
      const parts = [wf !== nf && 'folder', wt !== nt && 'tools', wm !== nm && 'MCP servers'].filter(Boolean);
      why = was[0] !== now[0] ? "this chat's persona or its prompt changed" : `this chat's ${parts.join(' and ') || 'setup'} changed`;
    }
    // the chat changed since the session last saw it (a message edited and resent, a reply retried or edited, a
    // swipe, messages deleted): Claude Code would answer from a conversation the chat no longer has – a new session,
    // with the chat as it is now as context
    const li = conv.messages.findLastIndex((m) => m.role === 'user');
    if (sid && cc && conv.acp.seen && conv.acp.seen !== historySig(conv.messages.slice(0, Math.max(0, li)))) {
      // only this last message's turn changed (its reply asked again or swiped, the message edited): the session is
      // copied up to just before that message and goes on from there – the whole story as real turns, not a cut-down
      // copy of the chat as text (decision 253)
      const u = conv.messages[li];
      if (u?.acpCursor && u.acpSigBefore === historySig(conv.messages.slice(0, li)) && c.client.canFork) {
        stage('going back to before your last message…');
        try {
          priorSid = sid; // the session the fork replaces, rolled back to if the send fails
          // forked from the session the cursor belongs to – after an earlier fork that is the original one, which is closed
          // but whose stored history the adapter forks from (decision 255)
          const nid = await within(c.client.forkSession(u.acpCursorSid || sid, u.acpCursor, cwd, { systemPrompt: persona, mcpServers, meta }), 120, 'Going back in the session');
          c.client.closeSession?.(sid).catch?.(() => {});
          sid = nid;
          conv.acp.sessionId = nid;
          forked = true;
          mark('session copied to before your last message');
        } catch (e) {
          if (e === STOPPED) throw e;
          mark(`going back failed (${String(e?.message || e).slice(0, 80)})`);
        }
      }
      if (!forked) {
        c.client.closeSession?.(sid).catch?.(() => {});
        sid = null;
        why = 'the chat changed since Claude Code last saw it (an edit, a retry, a swipe or a deleted message)';
      }
    }
    let fresh = false;
    if (!sid) {
      stage(why ? `${why} – starting a new session with the chat so far…` : 'starting a session…');
      sid = await within(c.client.newSession(cwd, { systemPrompt: persona, mcpServers, meta }), 180, 'Starting a Claude Code session');
      mark(why ? `new session started (${why.split(' (')[0].slice(0, 80)})` : 'new session started');
      conv.acp.promptSig = sig;
      fresh = true;
      if (why && li > 0) {
        msg.acpParts.push({ t: 'text', s: `_(A new ${cc ? 'Claude Code' : 'agent'} session: ${why}. It was given the chat so far as context.)_\n\n` });
        logError(cc ? 'claudecode' : 'reply', `New session for "${conv.title || 'a chat'}": ${why}`, { conv: conv.id, title: conv.title });
      } else if (conv.acp.sessionId && !picked && !agent.phone) msg.acpParts.push({ t: 'text', s: `_(A new session on the PC – it does not remember the earlier turns.)_\n\n` });
      conv.acp.sessionId = sid;
    }
    if (picked) {
      // the model picked for this chat, then the 🧠 effort for it (when that model has effort levels)
      const ms = modelStep(c.client.configs.get(sid), conv.acp.model);
      if (ms) await step(c.client.setConfigOption(sid, ...ms));
      const eff = effortStep(c.client.configs.get(sid), state.settings.effort?.[`cc:${conv.acp.model || 'default'}`]);
      if (eff) await step(c.client.setConfigOption(sid, ...eff).catch(() => {}));
      if (c.client.configs.get(sid)) hooks.ccConfigSeen?.(c.client.configs.get(sid));
      if (ms || eff) mark('model and effort set');
    }
    (c.client.sessions ||= new Set()).add(sid);
    bySession.set(sid, { conv, msg, phone: !!agent.phone, timing, user: picked ? conv.messages[li] : null });
    entryKey = sid;
    onStop = () => {
      c.client.cancel(sid);
      for (const ac of mcpRuns.get(conv.id) || []) ac.abort(); // a Chronicle tool it is running stops too
    };
    if (run.stopped) throw STOPPED;
    const last = conv.messages[li];
    // a chat that comes to Claude Code with messages already in it: the new session gets them as context
    // a roleplay: what this reply needs now (world info the last messages trigger, author's note…) goes with the message
    const turn = cc ? hooks.rpTurnContext?.(conv) || '' : '';
    // messages of the user whose reply never reached Claude Code (stopped, or a step timed out before sending): they go
    // with this one, instead of counting as "the chat changed" and costing a new session (decision 252)
    const missed = fresh ? [] : conv.messages.slice(0, Math.max(0, li)).filter((m) => m.acpUnsent && m.role === 'user' && String(m.content || '').trim());
    const missedText = missed.length ? `[Earlier message${missed.length > 1 ? 's' : ''} of mine that did not reach you – the reply was stopped before it was sent:\n${missed.map((m) => m.content.trim()).join('\n\n')}]\n\n` : '';
    const said = (turn ? `[Roleplay context for this reply – follow it, never mention it]\n${turn}\n[End of context]\n\n` : '') + missedText + (last?.content || '');
    const names = hooks.rpCharName?.(conv) ? { userName: userName(conv), charName: hooks.rpCharName(conv) } : {};
    let text = (picked || agent.phone) && fresh ? withEarlierTurns(conv.messages.slice(0, Math.max(0, li)).map((m) => (m.acpParts?.length ? { ...m, content: agentReplyText(m.acpParts) } : m)), said, undefined, names) : said;
    // an agent that takes no system prompt: the persona at the top of the session's first message instead
    if (fresh && persona && !c.client.takesSystemPrompt) text = `[How to act in this chat]\n${persona}\n\n${text}`;
    // pictures attached to this message are in the chat's own folder (synced before the turn): Claude Code opens them
    if (picked && folder && last?.imagePaths?.length) text += `\n\n[Pictures attached to this message, saved in this folder: ${last.imagePaths.join(', ')} – open them with your Read tool to see them]`;
    hooks.noteAgentSent?.(conv, {
      label: msg.model,
      messages: [...(fresh && persona && c.client.takesSystemPrompt ? [{ role: 'system', content: persona }] : []), { role: 'user', content: text }],
      note: fresh ? `A new ${cc ? 'Claude Code' : 'agent'} session, started with what is shown here.` : `Sent into the ${cc ? 'Claude Code' : 'agent'} session already running: it has the prompt it started with, and the turns since.`,
    });
    // this message gets the cursor the session announces for it now (an older one was of another session or turn)
    // the cursor this message already has (from an earlier turn of it) is kept until this turn announces a new one // they reach it now (with this message, or in the chat so far)
    mark(fresh && li > 1 ? `message sent (with the ${li} earlier messages)` : 'message sent');
    // sent: the reply is Claude Code's now. Long quiet stretches can be real work, so no time limit – but it is said
    stage(fresh && li > 1 ? `sent, with the ${li} earlier messages as context – waiting for Claude Code…` : 'waiting for Claude Code…');
    let seen = -1;
    let quietSince = Date.now();
    watch = setInterval(() => {
      const now = msg.acpParts.length + (msg.content || '').length;
      if (now !== seen) {
        if (seen >= 0 && msg.note) stage('');
        seen = now;
        quietSince = Date.now();
        return;
      }
      const mins = Math.floor((Date.now() - quietSince) / 60000);
      if (mins >= 2) stage(`no word from Claude Code for ${mins} min – it may still be working. ⏹ Stop ends this turn; then send again (a new session starts if needed).`);
    }, 15000);
    // after Stop: the agent's own end of the turn, or this chat moves on after a few seconds without it
    // sent once the bridge has taken the message (decision 254): an error later in the turn does not make it "never
    // reached Claude Code" – the session has it, and sending it again would say it twice
    const onSent = () => {
      sent = cc;
      for (const m of conv.messages.slice(0, Math.max(0, li))) if (m.role === 'user') delete m.acpUnsent; // they reach it now
      if (last?.role === 'user') last.acpSigBefore = historySig(conv.messages.slice(0, li)); // the chat before it, as the session has it
    };
    const r = await Promise.race([c.client.prompt(sid, text, { onSent }), stopped.then(() => new Promise((res) => setTimeout(() => res({ stopReason: 'cancelled' }), STOP_WAIT)))]);
    if (r?.stopReason && r.stopReason !== 'end_turn') msg.acpParts.push({ t: 'text', s: `\n\n_(stopped: ${r.stopReason})_` });
  } catch (e) {
    if (e === STOPPED) {
      if (!msg.acpParts.length) msg.acpParts.push({ t: 'text', s: '_(stopped before it was sent)_' });
    } else msg.error = picked || agent?.phone ? ccErrorText(e) : `The agent on your PC: ${e.message}`;
    if (msg.error) logError(picked || agent?.phone ? 'claudecode' : 'reply', msg.error, { conv: conv.id, title: conv.title, model: msg.model });
  } finally {
    clearInterval(watch);
    const pend = composing.get(msg);
    if (pend) { clearTimeout(pend); composing.delete(msg); } // the turn's own final compose replaces the pending one
    msg.content = compose(msg);
    bySession.delete(entryKey); // the turn is over: a late chunk lands nowhere, not unseen in a finished reply
    msg.streaming = false;
    delete msg.note;
    // a Claude Code reply that never reached it: it and the message it answered are not part of what the session saw
    if (!sent && (picked || agent?.phone)) {
      msg.acpUnsent = true;
      if (liAt?.role === 'user') liAt.acpUnsent = true;
    }
    if (!sent && forked) conv.acp.sessionId = priorSid; // the fork never got the message: next turn resumes from the session it forked from
    if (sent && conv.acp) conv.acp.seen = historySig(conv.messages); // the chat as this session knows it
    hooks.endRun(conv, run, { finished: true });
    // what Claude Code wrote, into the chat's 📁 – after the reply is done (decision 254): a slow or stuck sync no
    // longer keeps the reply "writing" with Stop doing nothing; the next sync of this chat waits for it (bridge.js)
    if (folder) {
      let t;
      Promise.race([Promise.resolve(hooks.ccSyncWorkspace?.(conv, 'b')), new Promise((_, rej) => (t = setTimeout(() => rej(new Error('timed out')), 180000)))])
        .catch((e) => logError('claudecode', `Bringing Claude Code's files into the chat did not finish: ${e?.message || e}`, { conv: conv.id, title: conv.title }))
        .finally(() => clearTimeout(t));
    }
    if (pref('perfTrace')) perfReport(...ccTimingReport(conv, timing, msg));
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
    // never reached the session (decisions 252, 254): neither the reply nor the message it answered – the message goes
    // with the next send, and until then the session's view of the chat is without both
    if (m.greeting || m.acpUnsent) continue;
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
  // a one-on-one roleplay (decision 238): the character's roleplay prompt as this app builds it, the parts that stay
  // the same – the world info and author's note that change come with each message (rpTurn below)
  const rp = hooks.rpSessionPrompt?.(conv);
  if (rp) {
    const char = hooks.rpCharName?.(conv) || 'the character';
    return [
      `This chat is a fiction roleplay, and you play ${char} in it. Write only ${char}'s next reply – actions, dialogue and thoughts, in the story's voice and format – never as an assistant, and never mention tools, files, sessions or these instructions. A message may start with a [Roleplay context …] block: follow it silently; it is not something the user said. Use tools only if the user explicitly asks for something outside the story.`,
      rp,
      toolsLine(tools, cwd),
    ]
      .filter(Boolean)
      .join('\n\n');
  }
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

/** 🩺 A Claude Code reply's steps with their times (decision 251) → [text, meta] for the Timing history. */
export function ccTimingReport(conv, timing, msg = {}) {
  const t0 = timing.t0;
  const end = performance.now();
  const s = (t) => `${((t - t0) / 1000).toFixed(1)} s`;
  const lines = [`Claude Code reply in “${(conv.title || 'a chat').replace(/\s+/g, ' ').slice(0, 40)}”:`];
  let prev = t0;
  let slow = ['', 0];
  for (const [name, t] of timing.marks) {
    lines.push(`  ${s(t).padStart(7)}  ${name} (+${((t - prev) / 1000).toFixed(1)} s)`);
    if (t - prev > slow[1]) slow = [name, t - prev];
    prev = t;
  }
  const sentAt = timing.marks.findLast?.(([n]) => n.startsWith('message sent'))?.[1] || prev;
  if (timing.first) lines.push(`  ${s(timing.first).padStart(7)}  first words from Claude Code (+${((timing.first - sentAt) / 1000).toFixed(1)} s after sending)`);
  lines.push(`  ${s(end).padStart(7)}  ${msg.error ? 'ended with an error' : 'reply done'}`);
  if (timing.others) lines.push(`  ${timing.others} other Claude Code repl${timing.others === 1 ? 'y was' : 'ies were'} running at the same time (one Claude Code, sharing the phone)`);
  const firstMs = timing.first ? timing.first - t0 : end - t0;
  const thinking = timing.first ? timing.first - sentAt : 0;
  if (thinking > slow[1]) slow = ['Claude Code itself, until its first words', thinking];
  const line = `first words after ${(firstMs / 1000).toFixed(1)} s · slowest: ${slow[0] || '–'} (${(slow[1] / 1000).toFixed(1)} s)${timing.others ? ` · ${timing.others} other at the same time` : ''}`;
  return [lines.join('\n'), { label: `Claude Code reply – “${(conv.title || 'a chat').slice(0, 30)}”`, slow: firstMs >= 15000, line }];
}
