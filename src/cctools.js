// Chronicle's tools for Claude Code (decision 166): which of the app's tools a Claude Code chat gets as the
// "chronicle" MCP server, how they look in MCP, how a result goes back, and the user's own MCP servers passed to
// Claude Code's session/new as they are. Pure.
import { parseHeaders, slug } from './mcp.js';
import { isFree, modelVia } from './models.js';
import { isCcModelId } from './ccmodels.js';
import { ORIGIN_MODEL } from './cctask.js';

export const SERVER = 'chronicle';

/**
 * The phone and app tools Claude Code does not have itself. Not here: Chronicle's file, shell and Python tools
 * (Claude Code has Bash/Read/Edit/Write in the same Linux), fetch_url (it has WebFetch), delegate and ask_user (it has
 * its own subagents and questions), schedules (a scheduled run of a Claude Code chat would go to the chat's normal
 * model, not to Claude Code), goals, scripts, plans, mods, manage_mcp (Claude Code's server list is part of its
 * session: changing it from inside would start a new one). The creator tools are here since decision 250: making
 * personas, characters and lorebooks, each save shown to the user for approval as for any model.
 */
export const CC_TOOLS = new Set([
  'web_search',
  'view_images',
  'show_image',
  'phone_folder',
  'phone_list',
  'phone_read',
  'phone_import',
  'phone_write',
  'phone_delete',
  'pc_list',
  'pc_search',
  'pc_read',
  'pc_import',
  'pc_write',
  'pc_shell',
  'pc_job',
  'android_intent',
  'calendar',
  'contacts',
  'location',
  'places',
  'phone_status',
  'phone_control',
  'take_photo',
  'notifications',
  'messages',
  'browser',
  'preview_page',
  'memory',
  'search_chats',
  'read_chat',
  // the creator tools (decision 250): personas, roleplay characters, lorebooks, snippets/recipes
  'list_personas',
  'roleplay_presets',
  'read_persona',
  'save_persona',
  'save_character',
  'edit_persona',
  'save_lorebook',
  'edit_lorebook',
  'read_lorebook',
  'shortcuts',
]);

/** The app's tool definitions (toolDefs for the chat's switches) → the MCP tools a Claude Code chat gets. */
export function mcpToolList(defs) {
  const out = [];
  for (const d of defs || []) {
    const f = d?.function;
    if (!f || !CC_TOOLS.has(f.name) || out.some((t) => t.name === f.name)) continue;
    const schema = f.parameters && typeof f.parameters === 'object' ? { ...f.parameters } : { type: 'object', properties: {} };
    if (schema.type !== 'object') schema.type = 'object';
    schema.properties ||= {};
    out.push({ name: f.name, description: String(f.description || f.name).slice(0, 2000), inputSchema: schema });
  }
  return out;
}

/** The chat's switches for Claude Code's sake: tools off → none; no shell/Python/delegate (Claude Code has its own). The creator tools follow the chat's switch (decision 250). */
export const ccEnabled = (enabled, toolsOn) => (toolsOn ? { ...enabled, shell: false, python: false, delegate: false, modAuthor: false, advisor: false, planMode: false, claudecode: false, skills: [], vision: true } : null);

// ---------- Claude Code calls Chronicle's models (decision 167) ----------
/** Tools Chronicle adds for Claude Code beyond CC_TOOLS: a helper on one of the user's models, and the list of them. */
export const CROSS_TOOLS = ['ask_model', 'ask_model_status', 'ask_model_cancel', 'list_models'];
/**
 * ask_model and list_models, in MCP form – when the chat has helper agents on (Settings › Tools & agent, the
 * persona's toolset) and the session was not itself started by one of Chronicle's models (no loops: a Claude Code
 * task a model started cannot start a model again).
 */
export function crossTools({ delegate = false, origin = '' } = {}) {
  if (!delegate || origin === ORIGIN_MODEL) return [];
  return [
    {
      name: 'ask_model',
      description:
        "Hand a self-contained job to one of the user's other AI models in Chronicle (a helper agent) and get its final answer – e.g. a second opinion, a cheaper model for bulk text work, a model that is good at something else. It cannot see your session: put everything it needs in task. tools: none (default, one answer), read (it may search the web and read the chat's files), full (it may also run code and write files in the chat's workspace). Leave model out for the user's helper model; list_models shows the others. It costs what that model costs the user. Every call is a job with an id (in its answer): for long work set background true – you get the id at once, ask_model_status shows its progress and its answer when done, ask_model_cancel stops it, and a message in the chat tells you when it is over. If a waiting call is cut off, the job goes on: ask_model_status lists it. With tools, its file changes (also from Python and the shell, which start in the chat's folder) reach your folder when each of its steps ends (a shell command's at once) – not during a long Python step. A shell command it started and left running is killed when the job ends (its answer says so), so nothing of a finished job keeps writing. When both you and the job add text to the end of the same file at the same time, both additions are kept. Any other edit made on both sides between two copies is a CONFLICT: the newer write is the file, and the other version is kept beside it as <name>.conflict-other.<ext>. Writes that alternate with a copy in between are not a conflict: each one is the file in turn, and the last one stays.",
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'A complete, self-contained instruction, including the format you want back' },
          model: { type: 'string', description: "A model id or name from list_models (leave out for the user's helper model)" },
          tools: { type: 'string', enum: ['none', 'read', 'full'], description: 'What the helper may use (default none)' },
          max_steps: { type: 'integer', description: 'With tools: most tool steps it may take (default 8, at most 20)' },
          background: { type: 'boolean', description: 'Answer at once with the job id instead of waiting for the result (for long jobs)' },
          notify: { type: 'boolean', description: 'background: a message in this chat when the job is over (default true)' },
        },
        required: ['task'],
      },
    },
    {
      name: 'ask_model_status',
      description: "An ask_model job: running / done / failed / cancelled, how long it has run, when it last did something and what (a tool step, or writing), about how many tokens it wrote, its recent steps, the files it touched – and its full answer once done, also when the call that started it gave up. Without job_id: this chat's jobs.",
      inputSchema: { type: 'object', properties: { job_id: { type: 'string', description: 'The job id from ask_model (leave out to list the jobs)' } } },
    },
    { name: 'ask_model_cancel', description: 'Stop a running ask_model job. A step it is in the middle of (Python, a shell command, a shell job it started) is killed, not left to finish; the answer says what that step had already written (kept) and only returns once it has stopped – if it cannot be stopped within 15 s it says so, and ask_model_status shows "cancelling" until it has.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } },
    {
      name: 'list_models',
      description: "The user's AI models in Chronicle that ask_model can use, A–Z: id, name, context window, whether it sees images, price (or free), and where it runs and who pays (via: an Anthropic API key, another provider key of theirs, OpenCode, this phone – never your own Claude subscription). The helper model is marked. Shows 80 at a time – use query to find one (part of its id or name, e.g. \"sonnet\") or offset for the next page.",
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Only models whose id or name contains this (any case; several words must all match)' }, offset: { type: 'integer', description: 'Skip this many (the next page: 80, 160…)' } } },
    },
  ];
}

/** The models ask_model may use: the user's Chronicle models, never Claude Code's own (cc:…) – no loops. */
export const askableModels = (models) => (models || []).filter((m) => m && m.id && !isCcModelId(m.id) && m.source !== 'claudecode');

/** list_models' answer: one line per model, A–Z, 80 a page; query narrows it (decision 214). */
export function listModelsText(models, helperId = '', { query = '', offset = 0 } = {}) {
  const all = askableModels(models);
  if (!all.length) return 'No models are set up in Chronicle.';
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (m) => `${m.id} ${m.name || ''} ${m.provider || ''} ${m.providerName || ''} ${modelVia(m)}`.toLowerCase();
  // the helper model (the default) first, the rest A–Z
  const list = all.filter((m) => words.every((w) => hay(m).includes(w))).sort((a, b) => (b.id === helperId) - (a.id === helperId) || String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { sensitivity: 'base' }));
  if (!list.length) return `No model matches "${query}" (of ${all.length}). Try a shorter part of its name, or list_models without query.`;
  const from = Math.max(0, Math.min(Number(offset) | 0, list.length - 1));
  const page = list.slice(from, from + 80);
  const lines = page.map((m) => {
    const c = m.cost?.text;
    const price = isFree(m) || m.source === 'local' ? 'free' : c?.input?.price != null ? `$${c.input.price} in / $${c.output?.price ?? '?'} out per M tokens` : m.anthropic ? "Anthropic's API prices" : 'price unknown';
    const sees = m.capabilities?.image?.input?.supported || m.modalities?.input?.includes?.('image');
    const bits = [m.limit?.context ? `${Math.round(m.limit.context / 1000)}K context` : '', sees ? 'sees images' : 'text only', m.capabilities?.tools?.supported === false ? 'no tools' : '', price].filter(Boolean);
    return `- ${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ''}${m.id === helperId ? ' [helper model – the default]' : ''}: ${bits.join(', ')} · via ${modelVia(m)}`;
  });
  const end = from + page.length;
  const head = `${words.length ? `${list.length} of ${all.length} models match "${query}"` : `${list.length} model${list.length === 1 ? '' : 's'}`}${list.length > page.length ? `, showing ${from + 1}–${end}` : ''} (the helper model first, then A–Z; ids for ask_model's "model"):`;
  const more = end < list.length ? `\n… ${list.length - end} more: call list_models with offset ${end}${words.length ? ' (and the same query)' : ', or use query to find one by name'}.` : '';
  // who pays: you (Claude Code) run on the Claude subscription; none of these do (decision 215)
  const note = '\nNone of these is your own Claude subscription: you, Claude Code, run on that. ask_model on a model "via Anthropic API key" uses the same Claude models billed per token to that key.';
  return `${head}\n${lines.join('\n')}${more}${note}`;
}

const imageOf = (url) => {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(url || ''));
  return m ? { type: 'image', data: m[2], mimeType: m[1].toLowerCase() } : null;
};

/** A tool result ({ ok, result, images }) → MCP's CallToolResult: the text, and images as image content. */
export function mcpResult(res) {
  const content = [{ type: 'text', text: typeof res?.result === 'string' && res.result ? res.result : res?.ok === false ? 'The tool failed.' : '(no output)' }];
  let left = 8;
  for (const im of res?.images || []) {
    const pics = Array.isArray(im?.pics) ? im.pics : [im]; // the browser's are per step
    for (const p of pics) {
      const c = left > 0 && imageOf(typeof p === 'string' ? p : p?.url);
      if (!c) continue;
      content.push(c);
      left--;
    }
  }
  return { content, ...(res?.ok === false ? { isError: true } : {}) };
}

/** Our own server for one chat: on the bridge's loopback port, with the bridge's MCP token (never the bridge secret). */
export const chronicleServer = (bridgeUrl, chat, token) => ({ type: 'http', name: SERVER, url: `${String(bridgeUrl).replace(/\/+$/, '')}/mcp/${chat}`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] });

/**
 * The user's MCP servers (Settings › MCP servers) as ACP mcpServers for Claude Code, and the tools switched off in
 * them as deny rules. HTTP ones with the headers and sign-in the user saved for them; stdio ones as the same command
 * (Claude Code runs it itself, in the same Linux). Nothing else of the app's goes with them.
 */
export function userServers(servers, { on = true } = {}) {
  const list = [];
  const deny = [];
  if (!on) return { list, deny };
  const used = new Set([SERVER]);
  for (const s of servers || []) {
    if (!s || s.enabled === false) continue;
    let name = slug(s.name).replace(/_+$/, '') || 'server';
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${name}${i}`)) i++;
      name = `${name}${i}`;
    }
    if (s.transport === 'stdio') {
      if (!String(s.command || '').trim()) continue;
      list.push({ name, command: 'sh', args: ['-c', (s.cwd ? `cd '${String(s.cwd).replace(/'/g, "'\\''")}' && ` : '') + s.command], env: [] });
    } else if (/^https?:\/\//i.test(String(s.url || ''))) {
      const h = parseHeaders(s.headers);
      if (s.token) h.Authorization = /^bearer\s/i.test(s.token) ? s.token : `Bearer ${s.token}`;
      if (s.oauth?.access) h.Authorization = `Bearer ${s.oauth.access}`;
      list.push({ type: 'http', name, url: s.url, headers: Object.entries(h).map(([k, v]) => ({ name: k, value: String(v) })) });
    } else continue;
    used.add(name);
    for (const t of s.disabledTools || []) deny.push(`mcp__${name}__${t}`);
  }
  return { list, deny };
}

/** The line in the persona text that says the tools are there. */
export const toolsLine = (names, cwd = '') =>
  names.length
    ? `Chronicle's phone and app tools are available to you as the "${SERVER}" MCP tools (mcp__${SERVER}__…: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}); each call goes through the user's permissions in the app. Claude Code may hold them back as deferred tools: load a tool's schema first (ToolSearch "select:mcp__${SERVER}__<name>") instead of guessing its parameters. ${cwd ? `Where they say /workspace they mean your working directory ${cwd} (the chat's files).` : "Where they say /workspace they mean the Chronicle chat's own files, not your working directory."}`
    : '';

// common near-misses for a parameter name: what was sent → what the tools call it
const ALIASES = { prompt: 'task', question: 'task', message: 'task', chat_id: 'id', chatid: 'id', conversation_id: 'id', q: 'query', search: 'query', text_query: 'query', url: 'urls', file: 'path', filename: 'path', file_path: 'path', filepath: 'path', cmd: 'command', memory_id: 'id' };
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
/**
 * A call's arguments checked against the tool's schema before it runs (the owner's harness report, G1): a parameter
 * name that is an obvious near-miss of an unset one is read as it ("chat_id" → "id"), and the call says so; any other
 * unknown name, or a required one still missing, is refused naming what the tool takes – instead of the tool failing
 * later with a message about the wrong thing ("No chat with id undefined").
 * → { args, note } or { error }
 */
export function checkArgs(name, schema, args, { lenient = false } = {}) {
  const props = schema?.properties || {};
  const known = Object.keys(props);
  const given = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  if (!known.length) return { args: given, note: '' };
  const required = (schema.required || []).filter((k) => props[k]);
  const notes = [];
  for (const k of Object.keys(given)) {
    if (props[k]) continue;
    const free = known.filter((p) => given[p] === undefined);
    const n = norm(k);
    const to = (ALIASES[k] && free.includes(ALIASES[k]) && ALIASES[k]) || free.find((p) => norm(p) === n) || free.find((p) => norm(p).length >= 2 && (n.endsWith(norm(p)) || n.startsWith(norm(p))) && required.includes(p));
    if (!to) continue;
    given[to] = to === 'urls' && !Array.isArray(given[k]) ? [given[k]] : given[k];
    delete given[k];
    notes.push(`"${k}" was read as "${to}"`);
  }
  const takes = known.map((p) => `${p}${required.includes(p) ? ' (required)' : ''}`).join(', ');
  const unknown = Object.keys(given).filter((k) => !props[k]);
  if (unknown.length && lenient) {
    // Chronicle's own tools: a parameter the tool does not take is left out and said, not refused (a weak model's
    // extra "reason" or "explanation" should not cost a step)
    for (const k of unknown) delete given[k];
    notes.push(`ignored ${unknown.map((k) => `"${k}"`).join(', ')} – ${name} takes: ${takes}`);
  } else if (unknown.length) return { error: `${name}: unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}. It takes: ${takes}.` };
  // (an empty text is a value for Chronicle's own tools: write_file may make an empty file)
  const missing = required.filter((k) => given[k] === undefined || given[k] === null || (!lenient && given[k] === ''));
  if (missing.length) return { error: `${name}: missing ${missing.map((k) => `"${k}"`).join(', ')}. It takes: ${takes}.` };
  return { args: given, note: notes.length ? `(${notes.join('; ')}.)` : '' };
}

/**
 * The "full output is saved in .out/…" hint, for Claude Code (harness report G4): Chronicle's own models page it with
 * read_file / grep_files, which Claude Code does not get: when the chat's files are its working directory it reads the
 * same file with its own Read and Grep, otherwise it asks the tool for less.
 */
export function ccSpillHint(text, mounted) {
  const how = mounted
    ? 'it is in your working directory (the chat\'s files) – read parts of it with your Read tool (offset / limit) or search it with Grep'
    : 'that file is in Chronicle, not where you can read it – call the tool again asking for less (a query, a limit / offset, a narrower range)';
  return String(text).replace(/read parts of it with read_file \(start_line \/ offset\) or search it with grep_files \(path "\.out"\)/, how);
}
