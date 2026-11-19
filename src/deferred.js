// Deferred tools, like Claude Code's tool search: when saved tools, MCP tools and mod tools together would make every
// request big – and for the built-in tools a chat seldom needs – only their names and one line each are sent (in the
// load_tools description). The agent calls
// load_tools to get the full definitions of the ones it needs; they stay loaded for the rest of the chat.

export const DEFER_CHARS = 8000; // above this many characters of extra tool definitions, they are deferred
export const DEFER_COUNT = 12; // …or above this many extra tools

const nameOf = (d) => d.function?.name || '';
const summary = (d) => String(d.function?.description || '').replace(/^\[[^\]]*\]\s*/, '').split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ').slice(0, 110);

/**
 * Built-in tools a chat seldom needs (decision 175): sent as a name and a line in load_tools until the model loads
 * them – about 9K tokens off every request. Files, shell, web, browser, Python, the phone folder, memory and the
 * like stay loaded. A direct call of one still works and loads it for the rest of the chat.
 */
export const ON_DEMAND = new Set(['screenshot_page', 'doctor', 'deep_research', 'claude_code', 'goal', 'schedule_task', 'ralph_loop', 'reload_tools', 'edit_persona', 'edit_lorebook', 'list_personas', 'read_persona', 'save_character', 'save_lorebook', 'save_persona', 'shortcuts', 'manage_mcp', 'saved_tools', 'manage_mod', 'read_lorebook', 'android_intent', 'calendar', 'contacts', 'location', 'places', 'phone_status', 'phone_control', 'take_photo', 'save_skill', 'save_tool']);

/**
 * A small model's lighter tool set (decision 201): fewer tools make small models call the right one more often and
 * keep their prompt short ("Less is More", 2025). The big ones wait in load_tools too: the browser (about a quarter
 * of all tool text), page previews, scripts and helper agents. → is it small: on-device, a name with ≤ 14B
 * parameters, or mini / nano / lite / tiny in its name.
 */
export const LEAN_DEMAND = new Set(['browser', 'preview_page', 'run_script', 'delegate']);
export function isSmallModel(m) {
  if (!m) return false;
  if (m.source === 'local') return true;
  const t = `${m.id || ''} ${m.name || ''}`.toLowerCase();
  const b = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*b(?:\b|-)/.exec(t);
  if (b && Number(b[1]) <= 14) return true;
  return /\b(mini|nano|lite|tiny)\b/.test(t);
}

/** The chat's built-in tools: the on-demand ones not loaded yet are held back. → { active, deferred } */
export function splitBuiltins(defs, loaded = [], { lean = false } = {}) {
  const keep = new Set(loaded);
  const held = (d) => (ON_DEMAND.has(nameOf(d)) || (lean && LEAN_DEMAND.has(nameOf(d)))) && !keep.has(nameOf(d));
  return { active: (defs || []).filter((d) => !held(d)), deferred: (defs || []).filter(held) };
}

/** → { active: definitions to send, deferred: definitions held back } */
export function splitDeferred(extra, loaded = []) {
  const list = extra || [];
  if (list.length <= DEFER_COUNT && JSON.stringify(list).length <= DEFER_CHARS) return { active: list, deferred: [] };
  const keep = new Set(loaded);
  return { active: list.filter((d) => keep.has(nameOf(d))), deferred: list.filter((d) => !keep.has(nameOf(d))) };
}

export function loadToolsDef(deferred) {
  const lines = deferred.map((d) => `- ${nameOf(d)}: ${summary(d)}`).join('\n');
  return {
    type: 'function',
    function: {
      name: 'load_tools',
      description: `More tools are available but not loaded yet (to keep requests small). Call load_tools with the names you need (or a search word that matches names and descriptions); their full definitions are added and you can call them from your next step on. Available:\n${lines}`.slice(0, 9000),
      parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names' }, query: { type: 'string', description: 'Or: load every tool whose name or description contains this' } } },
    },
  };
}

/** → { names: [...] to load, missing: [...] } */
export function pickToLoad(args, deferred) {
  const all = deferred.map(nameOf);
  const want = (Array.isArray(args?.names) ? args.names : []).map(String);
  const names = new Set(want.filter((n) => all.includes(n)));
  const q = String(args?.query || '').toLowerCase().trim();
  if (q) for (const d of deferred) if (nameOf(d).toLowerCase().includes(q) || String(d.function?.description || '').toLowerCase().includes(q)) names.add(nameOf(d));
  return { names: [...names], missing: want.filter((n) => !all.includes(n)) };
}
