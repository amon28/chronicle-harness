// A persona's toolset, like a DeepSeek preset that only carries the tools it needs: which tool groups its chats get.
// persona.toolset = { web: false, shell: false, … } – only the switched-off groups are stored; missing = on.
// persona.tools = true / false / undefined – tools on or off when a chat with it starts (undefined = the app default).

export const TOOL_GROUPS = [
  ['web', '🔍 Web search & reading pages'],
  ['python', '🐍 Python (and your saved tools)'],
  ['files', '📁 Workspace files (read, write, edit, search)'],
  ['shell', '💻 Linux shell'],
  ['browser', '🧭 Browser control'],
  ['preview', '🖼 Page previews'],
  ['delegate', '🤝 Helper agents'],
  ['claudecode', '💻 Claude Code tasks (your Claude plan)'],
  ['creator', '🎭 Create personas, characters, lorebooks, snippets, recipes, packs, MCP servers'],
  ['phone', '📱 Phone folder'],
  ['pc', '🖥 Files on my PC'],
  ['intents', '📲 Other apps (dialer, maps, calendar, alarms…)'],
  ['device', '🗓 Phone data (calendar, contacts, location, places nearby)'],
  ['phonectl', '📶 Phone status & controls'],
  ['private', '🔒 Sensitive phone access (notifications, texts & calls, place triggers)'],
  ['skills', '📚 Skills'],
  ['autonomy', '🎯 Goals, schedules, scripts, searching old chats'],
  ['mcp', '🔌 MCP servers'],
  ['mods', '🧩 Mod tools'],
];

/** Presets for the editor: which groups stay on. */
export const TOOLSET_PRESETS = {
  all: TOOL_GROUPS.map(([k]) => k),
  research: ['web', 'files', 'delegate'],
  coding: ['web', 'python', 'files', 'shell', 'preview', 'delegate', 'claudecode', 'skills', 'autonomy', 'mcp'],
  roleplay: ['web'],
  none: [],
};

/** enabledTools with the persona's switched-off groups removed. */
export function applyToolset(enabled, toolset) {
  if (!toolset) return enabled;
  const out = { ...enabled };
  for (const [k, on] of Object.entries(toolset)) if (on === false && k in out) out[k] = k === 'skills' ? [] : false;
  if (toolset.mcp === false) out.mcp = false;
  if (toolset.mods === false) out.mods = false;
  return out;
}

/** The stored form of a set of groups that stay on. */
export const toolsetFrom = (onKeys) => {
  const off = Object.fromEntries(TOOL_GROUPS.filter(([k]) => !onKeys.includes(k)).map(([k]) => [k, false]));
  return Object.keys(off).length ? off : undefined;
};

/**
 * Single tools on top of the groups: persona.toolPicks = { on: [names], off: [names] }. "on" gives a chat one tool of a
 * group that is switched off for the persona (a light persona that still keeps notes with memory, or reads the
 * calendar); "off" takes one away from a group that is on. Only tools the user has on in Settings can be given.
 * defs: the chat's tools after the groups; fullDefs(): the tools with every group the user has on. → the chat's tools.
 */
export function applyToolPicks(defs, picks, fullDefs) {
  if (!picks || (!picks.on?.length && !picks.off?.length)) return defs;
  const nameOf = (d) => d.function?.name;
  const off = new Set(picks.off || []);
  const out = defs.filter((d) => !off.has(nameOf(d)));
  if (picks.on?.length) {
    const have = new Set(out.map(nameOf));
    const want = new Set(picks.on);
    for (const d of fullDefs()) if (want.has(nameOf(d)) && !have.has(nameOf(d)) && !off.has(nameOf(d))) out.push(d);
  }
  return out;
}

/** The stored form of the picks: only what differs from the groups (a tool given whose group is on is not kept). */
export function picksFrom(on, off, groupOf, groupsOn) {
  const inOn = (n) => (groupOf[n] || []).some((g) => groupsOn.has(g));
  const o = [...on].filter((n) => !inOn(n)).sort();
  const f = [...off].filter((n) => inOn(n)).sort();
  return o.length || f.length ? { ...(o.length ? { on: o } : {}), ...(f.length ? { off: f } : {}) } : undefined;
}
