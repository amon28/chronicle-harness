// Claude Code as a tool of Chronicle's own models (decision 167): "claude_code" hands a substantial coding or
// agentic task to the user's Claude Code in the app's Linux, in a hidden ACP session (in no chat's message list) that
// works in the calling chat's folder, and returns its final text. Pure: when the tool is offered, its definition, the
// runner over an ACP client (session, model/effort, progress, permission questions, cancel, close), and the result.
// The other direction (Claude Code calling Chronicle's models) is cctools.js crossTools.
import { readUpdate } from './acp.js';
import { effortStep, modelStep, readConfig } from './ccmodels.js';

export const TOOL = 'claude_code';
/** Who started a Claude Code session: a hidden task started by one of Chronicle's models gets no ask_model (no loops). */
export const ORIGIN_MODEL = 'model';

/**
 * Is the claude_code tool offered to this chat, and with which models and efforts? → { models, efforts } or null.
 *   on: Settings › Tools & agent › "Claude Code as a tool" (off by default); ready: the cached status (installed, auth)
 *   rp: a roleplay or group chat; origin: the caller is itself a session or helper started across (no second hop)
 *   cache: the cached Claude Code model list (ccmodels.js mergeModelCache)
 * The chat's tools switch and the persona's toolset are applied by the caller (toolsOn, applyToolset).
 */
export function ccTaskInfo({ on = false, ready = null, rp = false, origin = '', cache = null } = {}) {
  if (!on || rp || origin) return null;
  if (!ready?.installed || ready.auth !== 'yes') return null;
  const models = (cache?.models || []).filter((m) => m && typeof m.value === 'string').map((m) => ({ value: m.value, name: m.name || m.value, ...(m.description ? { description: m.description } : {}) }));
  const efforts = [...new Set(Object.values(cache?.effort || {}).flat().filter((x) => typeof x === 'string'))];
  return { models, efforts };
}

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });

/** The tool definition, with the model and effort choices the user's Claude Code offered last. */
export function claudeCodeDefs(info) {
  const props = {
    task: { type: 'string', description: 'A complete, self-contained task: what to build or change, where, how to check it, and what to report back. Claude Code cannot see this chat.' },
  };
  if (info?.models?.length) {
    props.model = { type: 'string', enum: info.models.slice(0, 20).map((m) => m.value), description: 'Leave out for Claude Code\'s own default. Available:\n' + info.models.slice(0, 20).map((m) => `- ${m.value}: ${m.name}${m.description ? ` (${m.description})` : ''}`).join('\n') };
  }
  if (info?.efforts?.length) props.effort = { type: 'string', enum: info.efforts, description: 'How hard it thinks (leave out for its own setting)' };
  return [
    fn(
      TOOL,
      "Hand a substantial coding or agentic task to the user's own Claude Code (the official CLI in this phone's Linux, signed in to their Claude plan). It works on its own in THIS chat's files (/workspace here is its working directory), with its own Bash, Read, Edit and Write tools and this chat's skills and phone tools, and returns its final answer; files it writes appear in the chat's 📁. It uses the user's Claude subscription (its usage limits), not this model's – use it for substantial coding or agentic work (a feature, a refactor, debugging across files, a multi-step job in the shell), not for small questions or a single edit you can do yourself. It may ask the user for permission on the way. It takes minutes; check what it reports.",
      props,
      ['task'],
    ),
  ];
}

export const claudeCodePrompt = () => "- For substantial coding or agentic work (a feature, a refactor, debugging across many files, a long job in the shell), claude_code hands the task to the user's own Claude Code, which works in this chat's files and returns its answer. It uses the user's Claude plan, so do not use it for small things you can do yourself.";

/** The text added to Claude Code's own instructions in a hidden task session. */
export function taskSystemPrompt({ toolsLine = '', cwd = '' } = {}) {
  return [
    "You are working for another AI assistant in the Chronicle app, not talking with the user directly: it handed you this task. Do it with your tools, then reply with ONLY the result – what you did, the files you created or changed (by path), how you checked it, and anything left undone – concise.",
    cwd ? `Your working directory ${cwd} is the chat's own folder; the assistant and the user see what you write there.` : '',
    toolsLine,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const KIND = { execute: 'shell', read: 'read', edit: 'edit', delete: 'delete', move: 'move', search: 'search', fetch: 'fetch', think: 'think' };
const STATUS = { pending: 'running', in_progress: 'running', completed: 'done', failed: 'error' };
/** Claude Code's tool calls as the card's steps ({ name, label, status }, like a helper's). */
export function stepOf(t, old = {}) {
  const status = STATUS[t.status] || old.status || 'running';
  return { id: t.id, name: KIND[t.kind] || old.name || 'tool', label: String(t.title || old.label || '').replace(/\s+/g, ' ').slice(0, 120), status };
}

/** The card's live status line. */
export function progressLine(p) {
  const s = p?.steps?.at(-1);
  if (p?.waiting) return `Claude Code is waiting for your OK: ${String(p.waiting).slice(0, 60)}`;
  if (s && s.status === 'running') return `Claude Code · step ${p.steps.length}: ${s.name}${s.label ? ' ' + s.label.slice(0, 50) : ''}`;
  if (p?.text) return `Claude Code is writing its answer… (${p.steps?.length || 0} step${p.steps?.length === 1 ? '' : 's'})`;
  if (p?.steps?.length) return `Claude Code · ${p.steps.length} step${p.steps.length === 1 ? '' : 's'} done`;
  return p?.phase || 'Claude Code is working…';
}

/**
 * Runs one task in a hidden session and closes it afterwards.
 *   client: an AcpClient (newSession, setConfigOption, prompt, cancel, closeSession, configs)
 *   watch(sid, fn | null): the session's updates go to fn (to no chat)
 *   permit(sid, fn | null): the session's permission questions go to fn(params) → optionId | null
 *   ask(question, options, signal) → the option name the user chose (the app's ask sheet)
 * → { text, steps, stopReason, cancelled, model }
 */
export async function runClaudeCodeTask({ client, watch, permit, ask, cwd = '/root', task, model = '', effort = '', systemPrompt = '', mcpServers = [], meta = null, signal, onProgress = () => {} }) {
  if (signal?.aborted) throw new Error('Stopped');
  const p = { phase: 'Starting Claude Code…', steps: [], text: '', waiting: '' };
  const tell = () => {
    try {
      onProgress({ ...p, steps: p.steps.slice() });
    } catch {
      /* the card is extra */
    }
  };
  tell();
  const sid = await client.newSession(cwd, { systemPrompt, mcpServers, meta });
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    client.cancel(sid);
  };
  try {
    watch(sid, (u) => {
      const r = readUpdate(u);
      if (r.text) p.text += r.text;
      if (r.tool) {
        const i = p.steps.findIndex((s) => s.id === r.tool.id);
        if (i >= 0) p.steps[i] = stepOf(r.tool, p.steps[i]);
        else p.steps.push(stepOf(r.tool));
      }
      if (r.text || r.tool) tell();
    });
    permit(sid, async (q) => {
      const opts = q?.options || [];
      if (!opts.length) return null;
      const title = q.toolCall?.title || 'do something';
      p.waiting = title;
      tell();
      try {
        const ans = await ask(`Claude Code (in Linux, working for the assistant) wants to: ${title}`, opts.map((o) => o.name), signal);
        return opts.find((o) => o.name === ans)?.optionId || null;
      } finally {
        p.waiting = '';
        tell();
      }
    });
    // the model asked for, then the effort (checked against the options as the model step left them)
    // a model that is not offered is refused, not quietly swapped for the default: the caller would never know
    const offered = readConfig(client.configs?.get(sid)).models.map((m) => m.value);
    if (model && !offered.includes(model)) throw new Error(offered.length ? `Claude Code has no model "${model}" – use one of: ${offered.join(', ')}, or leave model out` : `Claude Code did not offer a model list, so "${model}" cannot be set – leave model out`);
    const step = modelStep(client.configs?.get(sid), model);
    if (step) await client.setConfigOption(sid, ...step);
    const eff = effort ? effortStep(client.configs?.get(sid), effort) : null;
    if (eff) await client.setConfigOption(sid, ...eff).catch(() => {});
    if (signal?.aborted) throw new Error('Stopped');
    signal?.addEventListener('abort', onAbort, { once: true });
    p.phase = 'Claude Code is working…';
    tell();
    const r = await client.prompt(sid, task);
    const cur = (client.configs?.get(sid) || []).find((o) => o?.id === 'model')?.currentValue || '';
    return { text: p.text.replace(/\n{3,}/g, '\n\n').trim(), steps: p.steps.map(({ name, label, status }) => ({ name, label, status: status === 'running' ? (cancelled ? 'error' : 'done') : status })), stopReason: r?.stopReason || '', cancelled: cancelled || r?.stopReason === 'cancelled', model: cur };
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    watch(sid, null);
    permit(sid, null);
    client.closeSession(sid).catch(() => {});
  }
}

/** The tool: runs the task through ctx.claudeCode (the app's runner) and turns the outcome into a tool result. */
export async function runClaudeCodeTool(args, ctx) {
  const task = String(args?.task || '').trim();
  if (!task) throw new Error('task is required');
  if (!ctx.claudeCode) return { ok: false, result: ctx.claudeCodeWhy || 'Claude Code is not available here.', display: { error: 'unavailable' } };
  ctx.onStatus?.('Starting Claude Code…');
  const r = await ctx.claudeCode({ task, model: args.model ? String(args.model) : '', effort: args.effort ? String(args.effort) : '' }, ctx.signal, (p) => ctx.onStatus?.(progressLine(p)));
  const steps = r.steps || [];
  const notes = [`Claude Code${r.model ? ` (model ${r.model})` : ''}, on the user's Claude plan`];
  if (steps.length) notes.push(`it took ${steps.length} step${steps.length === 1 ? '' : 's'}: ${steps.slice(0, 30).map((s) => s.name + (s.status === 'error' ? ' (failed)' : '')).join(', ')}`);
  if (r.cancelled) notes.push('it was stopped before it finished');
  else if (r.stopReason && r.stopReason !== 'end_turn') notes.push(`it stopped: ${r.stopReason}`);
  const text = r.text || '(Claude Code sent no answer)';
  return { ok: !r.cancelled, result: `${text}\n\n[${notes.join('; ')}]`, display: { path: r.model ? `Claude Code · ${r.model}` : 'Claude Code', task: task.slice(0, 300), output: text.slice(0, 6000), steps } };
}

/**
 * A chat request as one Claude Code turn (decision 169): the system messages become the appended system prompt, the
 * rest the prompt – a single user message as it is, a longer exchange as a labelled transcript ending with the last
 * message. Images and other non-text parts are left out (these are text jobs).
 */
export function flattenForCc(messages = []) {
  const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : '');
  const system = messages.filter((m) => m.role === 'system').map((m) => text(m.content)).filter(Boolean).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system' && text(m.content).trim());
  if (rest.length === 1 && rest[0].role === 'user') return { system, task: text(rest[0].content) };
  const label = { user: 'USER', assistant: 'ASSISTANT', tool: 'TOOL RESULT' };
  const task = rest.map((m) => `${label[m.role] || m.role.toUpperCase()}:\n${text(m.content)}`).join('\n\n');
  return { system, task: `${task}\n\n(Answer the last message above, following the instructions you were given. Reply with the answer only.)` };
}
