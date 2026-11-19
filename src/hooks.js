// Hooks, as in Claude Code: your own shell commands that run at fixed points of the agent loop, in the chat's Linux
// (with /workspace mounted). They make rules the model cannot forget: format after every edit, refuse a dangerous
// command, run the tests before the agent may say it is done.
//   pre_tool  – before a tool runs.   exit 2 = the call is blocked and the output tells the agent why.
//   post_tool – after a tool ran.     Any output (or a non-zero exit) is added to the tool's result.
//   stop      – when the agent would end its reply. exit 2 = it is told the output and must carry on (at most 3 times).
//   prompt    – when you send a message. Its output is given to the agent as context for that message.
// Any other non-zero exit is reported but does not block. The hook sees CHRONICLE_EVENT, TOOL_NAME, TOOL_ARGS (JSON)
// and TOOL_RESULT (first 4000 chars) as environment variables, and the shell starts in /workspace.

export const HOOK_EVENTS = [
  ['pre_tool', 'Before a tool runs'],
  ['post_tool', 'After a tool ran'],
  ['stop', 'When the reply would end'],
  ['prompt', 'When you send a message'],
];

export const newHook = () => ({ id: 'hk_' + Math.random().toString(36).slice(2, 10), name: '', event: 'post_tool', matcher: '', command: '', timeout: 60, enabled: true });

/** The enabled hooks for an event; tool events also filter on the tool name (matcher: a regex, empty = every tool). */
export function hooksFor(list, event, toolName = '') {
  return (list || []).filter((h) => {
    if (!h || h.enabled === false || h.event !== event || !String(h.command || '').trim()) return false;
    if (!h.matcher || !/tool/.test(event)) return true;
    try {
      return new RegExp(`^(?:${h.matcher})$`).test(toolName);
    } catch {
      return false;
    }
  });
}

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** The command as run: variables exported first, then cd /workspace (when there is one). */
export function hookScript(hook, { event, toolName = '', args = '', result = '' } = {}) {
  const env = { CHRONICLE_EVENT: event, TOOL_NAME: toolName, TOOL_ARGS: typeof args === 'string' ? args : JSON.stringify(args || {}), TOOL_RESULT: String(result || '').slice(0, 4000) };
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`).join('; ');
  return `${exports}; [ -d /workspace ] && cd /workspace; ${hook.command}`;
}

/**
 * Run hooks one after another. run(script, timeoutSeconds) → { exit, output }.
 * → { blocked: { hook, output } | null, notes: [text…] }
 */
export async function runHooks(list, info, run) {
  const notes = [];
  for (const h of list) {
    let r;
    try {
      r = await run(hookScript(h, info), Math.max(1, Math.min(600, Number(h.timeout) || 60)));
    } catch (e) {
      notes.push(`[hook "${h.name || h.command.slice(0, 30)}" could not run: ${e?.message || e}]`);
      continue;
    }
    const label = h.name || h.command.split('\n')[0].slice(0, 40);
    const out = String(r.output || '').trim().slice(-4000);
    if (r.exit === 2) return { blocked: { hook: label, output: out || '(no output)' }, notes };
    if (r.exit !== 0) notes.push(`[hook "${label}" exited ${r.exit}]${out ? '\n' + out : ''}`);
    else if (out && info.event !== 'pre_tool') notes.push(`[hook "${label}"]\n${out}`);
  }
  return { blocked: null, notes };
}
