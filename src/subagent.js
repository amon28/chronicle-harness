// Helper agents with their own tools: the main assistant hands a side job to a helper (usually a cheaper
// model), which works through it with a limited tool set in its own short loop and returns only its final
// answer. The helper's steps never enter the main chat's context.

/** What a helper may use. "none" = a single answer, no tools (the old delegate). */
export const HELPER_MODES = ['none', 'read', 'full'];

// Tools that only look: safe to give a helper that may run beside other helpers.
const READ_TOOLS = new Set([
  'web_search',
  'fetch_url',
  'list_files',
  'read_file',
  'grep_files',
  'glob_files',
  'repo_map',
  'read_lorebook',
  'view_images',
  'doctor',
  'use_skill',
  'list_personas',
  'read_persona',
  'list_mods',
  'read_mod',
  'screenshot_page',
]);
// Tools a helper never gets: it cannot talk to the user, spawn helpers of its own, change the main
// assistant's plan, install things for future chats, or change the phone folder (that needs the user's review).
const NEVER = new Set([
  'delegate',
  'claude_code', // the user's Claude Code (decision 167): only the main assistant hands it work – its questions and plan cost are the user's
  'ask_user',
  'todo_write',
  'reload_tools',
  'load_tools',
  'save_tool',
  'save_mod',
  'save_skill',
  'save_persona',
  'shortcuts',
  'manage_mcp',
  'save_character',
  'save_lorebook',
  'edit_persona',
  'edit_lorebook',
  'edit_skill',
  'memory',
  'saved_tools',
  'manage_mod',
  'phone_folder',
  'show_image', // only the main reply is on screen
  'phone_write',
  'phone_delete',
  'pc_write',
  'pc_shell',
  'pc_job',
  'goal',
  'ralph_loop',
  'schedule_task',
  'search_chats',
  'read_chat',
  'propose_plan',
  // other people's texts and notifications: only with the user at the phone, saying yes – never through a helper
  'notifications',
  'messages',
  'advisor',
  // the phone and the user's personal data (decision 181): a helper with tools "full" is for work in the chat's files –
  // files, code, the shell, the web, the browser – not for the phone, its sensors or the user's contacts and calendar
  'phone_control',
  'phone_status',
  'android_intent',
  'list_apps',
  'take_photo',
  'location',
  'places',
  'contacts',
  'calendar',
  'phone_import',
  'phone_list',
  'phone_read',
]);

export const helperMode = (m) => (HELPER_MODES.includes(m) ? m : 'none');
export const helperMayUse = (name, mode) => mode !== 'none' && !NEVER.has(name) && (mode === 'full' || READ_TOOLS.has(name));
/** The tool definitions a helper in this mode is offered. */
export const helperToolDefs = (defs, mode) => (mode === 'none' ? [] : (defs || []).filter((d) => helperMayUse(d.function?.name, mode)));
/** Helpers that only read can run at the same time; a helper that writes or runs the shell goes alone. */
export const runsInParallel = (mode) => mode !== 'full';

export const HELPER_SYSTEM =
  'You are a helper agent working for another assistant, not for the user directly. You cannot ask anyone anything: do the task you are given with the tools you have, step by step, then reply with ONLY the result, concise and in the format asked for. If something could not be done, say exactly what and why – do not pretend. Mention any files you created or changed by path.';

const MAX_RESULT = 12000; // characters of one tool result kept in the helper's context
const OUT_PATH = /\.out\/[^\s"'`)\]]+/g;
// Head 70% + tail 30%, cut at line boundaries; any .out/… path that falls in the cut-out middle is kept in the marker.
const clip = (s) => {
  if (s.length <= MAX_RESULT) return s;
  const headMax = Math.floor(MAX_RESULT * 0.7);
  const tailMax = MAX_RESULT - headMax;
  let head = s.slice(0, headMax);
  const hn = head.lastIndexOf('\n');
  if (hn > headMax * 0.5) head = head.slice(0, hn);
  let tail = s.slice(s.length - tailMax);
  const tn = tail.indexOf('\n');
  if (tn >= 0 && tn < tailMax * 0.5) tail = tail.slice(tn + 1);
  const middle = s.slice(head.length, s.length - tail.length);
  const paths = [...new Set(middle.match(OUT_PATH) || [])].slice(0, 5);
  return `${head}\n… [truncated ${middle.length} chars${paths.length ? '; saved: ' + paths.join(', ') : ''}] …\n${tail}`;
};

const KEEP_TOOL_MSGS = 5;
const COLLAPSE_STEP = 4;
const OLD_STEP_CHARS = 400;
// The copy of the history sent to the model: tool results older than the newest 5 are collapsed, in groups of 4 so the
// collapsed prefix changes only now and then and the provider's prompt cache keeps hitting. The real history is untouched.
const collapseOld = (messages) => {
  const idx = [];
  messages.forEach((m, i) => m.role === 'tool' && idx.push(i));
  const over = Math.max(0, idx.length - KEEP_TOOL_MSGS);
  const old = new Set(idx.slice(0, Math.floor(over / COLLAPSE_STEP) * COLLAPSE_STEP));
  if (!old.size) return messages;
  return messages.map((m, i) => {
    if (!old.has(i)) return m;
    const c = String(m.content ?? '');
    return c.length <= OLD_STEP_CHARS && c.endsWith('[older helper step trimmed]') ? m : { ...m, content: c.slice(0, OLD_STEP_CHARS) + ' [older helper step trimmed]' };
  });
};

/** A short label for a helper's step, for the tool card. */
function stepLabel(name, raw) {
  let a = {};
  try {
    a = JSON.parse(raw || '{}');
  } catch {
    /* shown as the name only */
  }
  const what = a.path || a.query || a.url || a.command || a.name || (Array.isArray(a.paths) ? a.paths.join(', ') : '') || a.code?.split('\n')[0] || '';
  return String(what).replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * Runs a helper to the end.
 *   chat({ messages, tools, signal }) -> { content, toolCalls, reasoning }   one model request
 *   runTool(call) -> { ok, result }                                          runs one of the helper's tool calls
 * Returns { text, steps, stoppedAtLimit }.
 */
export async function runSubagent({ task, system, tools = [], mode = 'none', maxSteps = 8, chat, runTool, signal, onStep, reasoningField }) {
  const messages = [{ role: 'system', content: system || HELPER_SYSTEM }, { role: 'user', content: task }];
  const steps = [];
  const offered = mode === 'none' ? [] : tools;
  for (let step = 0; ; step++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const last = step >= maxSteps;
    if (last) messages.push({ role: 'user', content: `You have used all ${maxSteps} tool steps. Stop calling tools and give your final answer now, saying what is left undone.` });
    const r = await chat({ messages: collapseOld(messages), tools: last ? undefined : offered.length ? offered : undefined, signal });
    const calls = last ? [] : r.toolCalls || [];
    if (!calls.length) return { text: String(r.content || '').trim() || '(the helper sent no answer)', steps, stoppedAtLimit: last };
    const a = { role: 'assistant', content: r.content || '', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) };
    if (reasoningField && r.reasoning) a[reasoningField] = r.reasoning;
    messages.push(a);
    // the calls of one turn run one after another: the ones after the first wait their turn, and are listed as waiting
    // (decision 189) – a cancel drops them, and they are said as "not run", never started later
    const planned = calls.map((c) => ({ name: c.name, label: stepLabel(c.name, c.arguments), status: 'waiting' }));
    steps.push(...planned);
    onStep?.(steps);
    for (const [i, c] of calls.entries()) {
      if (signal?.aborted) {
        for (const p of planned.slice(i)) p.status = 'not run';
        onStep?.(steps);
        throw new Error('Cancelled');
      }
      const s = planned[i];
      s.status = 'running';
      onStep?.(steps);
      let res;
      if (!helperMayUse(c.name, mode)) res = { ok: false, result: `Error: the tool "${c.name}" is not available to a helper${mode === 'read' ? ' that may only read' : ''}.` };
      else {
        try {
          res = await runTool(c);
        } catch (e) {
          res = { ok: false, result: `Error: ${e?.message || e}` };
        }
      }
      s.status = res.ok ? 'done' : 'error';
      onStep?.(steps);
      messages.push({ role: 'tool', tool_call_id: c.id, content: clip(String(res.result ?? '')) });
    }
  }
}
