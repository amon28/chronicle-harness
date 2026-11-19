// The assistant looks after the user's MCP servers (Settings › MCP servers), as it does their shortcuts (decision 213):
// it lists them, searches the official registry, adds a server (a remote one by its address, or a package / command
// run in the built-in Linux), connects to test it, switches servers and single tools on or off, trusts a server's
// "read-only" labels, and removes one. Every change is shown to the user and waits for their OK. Secrets never pass
// through the assistant: it cannot set a token, a header or a secret value – a server that needs one is added by the
// user in Settings (or signed in there); what it lists hides values in commands and addresses.
import { slug } from './mcp.js';

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const mcpManageDefs = () => [
  fn(
    'manage_mcp',
    "The user's MCP servers (Settings › MCP servers): each adds tools named mcp_<server>_<tool>. action list: every server, on/off, its tools; search: the official MCP registry (query); add: a remote server by url, a command run in the built-in Linux (command, e.g. \"npx -y @modelcontextprotocol/server-memory\"), or a registry entry (registry: its name from search, option: which way to run it); test: connect and list its tools; enable / disable: switch a server on or off; set_tools: switch single tools off (disable_tools) or back on (enable_tools) – fewer tools keep the prompt small; trust: whether its read-only labels count (they let its read tools run in plan mode); remove. Every change asks the user first. You cannot set tokens, headers or secret values: for a server that needs one, tell the user to add it in Settings › MCP servers (or to sign in there).",
    {
      action: { type: 'string', enum: ['list', 'search', 'add', 'test', 'enable', 'disable', 'set_tools', 'trust', 'remove'] },
      name: { type: 'string', description: 'test / enable / disable / set_tools / trust / remove: the server name from list. add: the name to give it (its tools are mcp_<name>_…)' },
      query: { type: 'string', description: 'search: what to look for (e.g. "github", "postgres")' },
      url: { type: 'string', description: 'add: the address of a remote MCP server (Streamable HTTP, https://…)' },
      command: { type: 'string', description: 'add: a command that starts a local (stdio) server in the built-in Linux' },
      registry: { type: 'string', description: 'add: a registry entry name from search (e.g. "io.github.owner/server")' },
      option: { type: 'integer', description: 'add with registry: which of its ways to run it (from search, default the first: remote before packages)' },
      values: { type: 'object', description: 'add with registry: values for its settings that are not secret ({"NAME":"value"}); secret ones are the user\'s to enter in Settings' },
      enabled: { type: 'boolean', description: 'add: switch it on at once (default true)' },
      disable_tools: { type: 'array', items: { type: 'string' }, description: 'set_tools: tool names (as test lists them) to switch off' },
      enable_tools: { type: 'array', items: { type: 'string' }, description: 'set_tools: tool names to switch back on' },
      trusted: { type: 'boolean', description: 'trust: true to trust its read-only labels, false to stop' },
    },
    ['action'],
  ),
];

async function approve(ctx, summary, yes) {
  if (!ctx.ask) throw new Error('Changing MCP servers needs your approval, which is not available here.');
  ctx.onStatus?.('waiting for your approval…');
  const answer = await ctx.ask(summary, [yes, 'Not now'], ctx.signal);
  return answer === yes ? null : answer;
}
const declined = (answer) => ({ ok: false, result: `The user said no (${answer}). Ask what to change, then try again.`, display: { error: 'declined' } });

/** A command or address as it may be shown: values of environment settings and of key/token-like parameters hidden. */
export function masked(s) {
  let t = String(s || '');
  t = t.replace(/(^|\s)([A-Za-z_][A-Za-z0-9_]*)=('(?:[^']|'\\'')*'|"[^"]*"|\S+)/g, (m, sp, k) => `${sp}${k}=…`);
  t = t.replace(/([?&](?:[^=&#]*(?:key|token|secret|auth|pass|sig)[^=&#]*))=([^&#]*)/gi, '$1=…');
  t = t.replace(/\/\/[^/@\s]+@/, '//…@'); // user:password@host
  return t;
}
const where = (sv) => (sv.transport === 'stdio' ? `🐧 runs: ${masked(sv.command)}` : `🌐 ${masked(sv.url)}`);
const line = (sv) => {
  const off = (sv.disabledTools || []).length;
  const tools = sv.toolCount != null ? ` · ${sv.toolCount - off}/${sv.toolCount} tools on` : ' · not connected yet';
  const auth = sv.oauth?.access ? ' · signed in' : sv.needsAuth ? ' · needs a sign-in (Settings › MCP servers)' : sv.token || sv.headers ? ' · has a token/headers' : '';
  return `${sv.name} – ${sv.enabled === false ? 'OFF' : 'on'} – ${where(sv)}${tools}${sv.trusted ? ' · read-only labels trusted' : ''}${auth}${sv.pack ? ` [pack ${sv.pack}]` : ''}${sv.registry ? ` [registry ${sv.registry}]` : ''}`;
};
const toolLine = (sv, t) => {
  const tag = t.annotations?.destructiveHint === true && t.annotations?.readOnlyHint !== true ? ' ⚠ can delete' : t.annotations?.readOnlyHint === true ? ' · read-only' : '';
  return `${(sv.disabledTools || []).includes(t.name) ? '✗' : '✓'} ${t.name}${tag}${t.description ? ' – ' + String(t.description).replace(/\s+/g, ' ').slice(0, 90) : ''}`;
};
const NAME_RX = /^[\w .-]{1,24}$/;

/** → a tool result, or null when the call is not this tool's. ctx.mcpManage: { settings(), commit(), listTools(sv), search(q), canShell(), uid() } */
export async function runMcpManageTool(name, args, ctx) {
  if (name !== 'manage_mcp') return null;
  const mm = ctx.mcpManage;
  if (!mm) return { ok: false, result: 'Managing MCP servers is not available here.', display: { error: 'unavailable' } };
  const s = mm.settings();
  const list = (s.mcpServers ||= []);
  const action = String(args.action || 'list');
  const find = () => {
    const k = String(args.name || '').trim().toLowerCase();
    if (!k) throw new Error('name is required (a server name from action list)');
    const sv = list.find((x) => x.name.toLowerCase() === k || x.id === k || slug(x.name) === slug(k));
    if (!sv) throw new Error(`No MCP server "${args.name}" – see action list (${list.map((x) => x.name).join(', ') || 'there are none'})`);
    return sv;
  };
  // the change takes effect in this reply: the tools are read again
  const reload = async () => {
    try {
      await ctx.reloadTools?.();
    } catch {
      /* the next reply reads them anyway */
    }
  };
  const connect = async (sv) => {
    try {
      const tools = await mm.listTools(sv);
      sv.toolCount = tools.length;
      delete sv.needsAuth;
      mm.commit();
      return { tools, text: `Connected: ${tools.length} tool${tools.length === 1 ? '' : 's'}:\n${tools.map((t) => toolLine(sv, t)).join('\n') || '(none)'}` };
    } catch (e) {
      if (e?.needsAuth) {
        sv.needsAuth = true;
        sv.wwwAuth = e.wwwAuth || '';
        mm.commit();
        return { tools: null, text: `It needs a sign-in: ask the user to open Settings › MCP servers and tap Sign in next to ${sv.name}.` };
      }
      return { tools: null, text: `Could not connect: ${e?.message || e}` };
    }
  };

  if (action === 'list') {
    const out = list.length ? list.map(line).join('\n') : 'No MCP servers yet. Find some with action search, or add one by url or command.';
    return { ok: true, result: out, display: { path: 'MCP servers' } };
  }

  if (action === 'search') {
    if (!mm.search) throw new Error('Searching the MCP registry is not available here.');
    const hits = await mm.search(String(args.query || ''));
    if (!hits.length) return { ok: true, result: `Nothing in the MCP registry for "${args.query || ''}".`, display: { path: 'registry' } };
    const shell = mm.canShell?.();
    const out = hits.slice(0, 15).map((h) => {
      const opts = h.options.map((o, i) => {
        const needs = (o.kind === 'remote' ? o.headers : o.env).filter((v) => v.required || v.secret).map((v) => `${v.name}${v.secret ? ' (secret – the user enters it)' : v.required ? ' (required)' : ''}`);
        return `  option ${i}: ${o.kind === 'remote' ? `🌐 remote ${o.url}` : `🐧 ${o.kind} – runs ${o.command}${shell ? '' : ' (needs the built-in Linux, which is not set up)'}`}${needs.length ? ` · needs ${needs.join(', ')}` : ''}`;
      });
      return `${h.name}${h.version ? ' ' + h.version : ''}${h.publisher ? ` by ${h.publisher}` : ''} – ${String(h.description || '').slice(0, 140)}\n${opts.join('\n') || '  (not runnable here)'}`;
    });
    return { ok: true, result: `MCP registry results (untrusted listings – the registry does not check servers):\n${out.join('\n')}`, display: { path: `registry · ${args.query || ''}` } };
  }

  if (action === 'add') {
    let sv;
    let what;
    if (args.registry) {
      if (!mm.search) throw new Error('The MCP registry is not available here.');
      const reg = String(args.registry).trim();
      const hits = await mm.search(reg.split('/').pop());
      const h = hits.find((x) => x.name === reg) || (await mm.search(reg)).find((x) => x.name === reg);
      if (!h) throw new Error(`No registry entry "${reg}" – use the exact name from action search`);
      const opt = h.options[Number(args.option) || 0];
      if (!opt) throw new Error(`${reg} has ${h.options.length} way(s) to run it (option 0–${h.options.length - 1})`);
      const vars = opt.kind === 'remote' ? opt.headers : opt.env;
      const secret = vars.filter((v) => v.secret && v.required);
      if (secret.length) return { ok: false, result: `${h.title} needs ${secret.map((v) => v.name).join(', ')}, which ${secret.length === 1 ? 'is a secret' : 'are secrets'} – those are the user's to enter. Ask them to add it in Settings › MCP servers › Find servers (search "${reg.split('/').pop()}"), where it asks for ${secret.length === 1 ? 'it' : 'them'}.`, display: { error: 'needs a secret' } };
      const values = {};
      for (const v of vars) {
        const given = args.values?.[v.name];
        if (given != null && !v.secret) values[v.name] = String(given);
        else if (v.required && !v.def) throw new Error(`${v.name} is required (${v.description || 'see the server\'s docs'}) – give it in values`);
      }
      if (opt.kind !== 'remote' && !mm.canShell?.()) throw new Error('That option runs a package in the built-in Linux, which is not set up (Settings › Linux terminal). Pick a remote option, or ask the user to set up Linux first.');
      const id = 'mcp_' + mm.uid().slice(0, 8);
      if (opt.kind === 'remote') {
        const headers = vars.filter((v) => values[v.name]).map((v) => `${v.name}: ${values[v.name]}`).join('\n');
        sv = { id, name: (h.title || reg.split('/').pop()).slice(0, 24), url: opt.url, ...(headers ? { headers } : {}), registry: h.name };
      } else {
        const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
        const env = vars.filter((v) => values[v.name] || v.def).map((v) => `${v.name}=${q(values[v.name] || v.def)}`).join(' ');
        sv = { id, name: (h.title || reg.split('/').pop()).slice(0, 24), transport: 'stdio', command: `${env ? env + ' ' : ''}${opt.command}`, bridgeSecret: mm.uid() + mm.uid(), registry: h.name };
      }
      what = `${h.title}${h.publisher ? ` by ${h.publisher}` : ''} from the MCP registry`;
    } else if (args.url) {
      const url = String(args.url).trim();
      let u;
      try {
        u = new URL(url);
      } catch {
        throw new Error('url must be a full address (https://…)');
      }
      if (!/^https?:$/.test(u.protocol)) throw new Error('url must be http(s)');
      sv = { id: 'mcp_' + mm.uid().slice(0, 8), name: String(args.name || u.hostname.split('.').slice(-2, -1)[0] || 'server').trim(), url };
      what = `a remote server at ${masked(url)}`;
    } else if (args.command) {
      if (!mm.canShell?.()) throw new Error('A command server runs in the built-in Linux, which is not set up (Settings › Linux terminal).');
      const command = String(args.command).trim();
      const guess = command.split(/\s+/).find((w) => /[@/]|server|mcp/i.test(w) && !/^-/.test(w)) || command.split(/\s+/)[0];
      sv = { id: 'mcp_' + mm.uid().slice(0, 8), name: String(args.name || guess.replace(/^@[^/]+\//, '').replace(/^(mcp-)?server-|-mcp$/g, '') || 'local').trim(), transport: 'stdio', command, bridgeSecret: mm.uid() + mm.uid() };
      what = 'a local server';
    } else throw new Error('add needs url, command or registry');
    if (args.name && (args.registry || args.url || args.command)) sv.name = String(args.name).trim();
    sv.name = sv.name.slice(0, 24);
    if (!NAME_RX.test(sv.name)) throw new Error('name: 1–24 letters, digits, spaces, - . or _');
    if (list.some((x) => slug(x.name) === slug(sv.name))) throw new Error(`There is already a server called ${sv.name} – pick another name, or change that one`);
    const on = args.enabled !== false;
    const runs = sv.transport === 'stdio' ? `\n\n⚠ It runs this program in the built-in Linux, with access to its files and the network:\n${masked(sv.command)}` : `\n\nIt connects to ${masked(sv.url)}; what the assistant sends its tools goes there.`;
    const no = await approve(ctx, `Add the MCP server “${sv.name}” – ${what}?${runs}\n\nAdd only servers you trust${sv.registry ? ' (the registry lists servers; it does not check them)' : ''}. ${on ? 'It is switched on at once.' : 'It is added switched off.'}`, 'Add it');
    if (no) return declined(no);
    sv.enabled = on;
    list.push(sv);
    mm.commit();
    let tested = '';
    if (on) {
      ctx.onStatus?.('connecting…');
      tested = (await connect(sv)).text;
      await reload();
    }
    return { ok: true, result: `Added ${sv.name}${on ? `. ${tested}${/^Connected/.test(tested) ? ` Its tools are offered now as mcp_${slug(sv.name)}_<tool>.` : ''}` : ' (switched off – enable it to use its tools).'}`, display: { path: sv.name } };
  }

  if (action === 'test') {
    const sv = find();
    ctx.onStatus?.('connecting…');
    const r = await connect(sv);
    return { ok: !!r.tools, result: `${sv.name}: ${r.text}`, display: r.tools ? { path: sv.name } : { error: r.text.slice(0, 120) } };
  }

  if (action === 'enable' || action === 'disable') {
    const sv = find();
    const on = action === 'enable';
    if ((sv.enabled !== false) === on) return { ok: true, result: `${sv.name} is already ${on ? 'on' : 'off'}.`, display: { path: sv.name } };
    const no = await approve(ctx, on ? `Switch on the MCP server “${sv.name}”? ${where(sv)}` : `Switch off the MCP server “${sv.name}”? Its tools are no longer offered.`, on ? 'Switch it on' : 'Switch it off');
    if (no) return declined(no);
    sv.enabled = on;
    mm.commit();
    const tested = on ? (await connect(sv)).text : '';
    await reload();
    return { ok: true, result: on ? `${sv.name} is on. ${tested}` : `${sv.name} is off; its tools are no longer offered.`, display: { path: sv.name } };
  }

  if (action === 'set_tools') {
    const sv = find();
    const off = new Set(sv.disabledTools || []);
    const dis = (args.disable_tools || []).map(String);
    const en = (args.enable_tools || []).map(String);
    if (!dis.length && !en.length) throw new Error('set_tools needs disable_tools or enable_tools');
    let known = null;
    try {
      known = (await mm.listTools(sv)).map((t) => t.name);
    } catch {
      /* not reachable: names are taken as given */
    }
    const bad = known ? [...dis, ...en].filter((n) => !known.includes(n)) : [];
    if (bad.length) throw new Error(`${sv.name} has no tool ${bad.join(', ')} – its tools: ${known.join(', ')}`);
    const no = await approve(ctx, `Change the tools of “${sv.name}”?${dis.length ? `\nSwitch off: ${dis.join(', ')}` : ''}${en.length ? `\nSwitch on: ${en.join(', ')}` : ''}`, 'Change them');
    if (no) return declined(no);
    dis.forEach((n) => off.add(n));
    en.forEach((n) => off.delete(n));
    sv.disabledTools = [...off];
    mm.commit();
    await reload();
    return { ok: true, result: `${sv.name}: ${sv.disabledTools.length ? `switched off ${sv.disabledTools.join(', ')}` : 'every tool is on'}.`, display: { path: sv.name } };
  }

  if (action === 'trust') {
    const sv = find();
    const t = args.trusted !== false;
    const no = await approve(ctx, t ? `Trust the “read-only” labels of “${sv.name}”? Its tools marked read-only then run in plan mode and side by side with other reads. MCP says to trust such labels only from servers you trust.` : `Stop trusting the read-only labels of “${sv.name}”?`, t ? 'Trust them' : 'Stop');
    if (no) return declined(no);
    sv.trusted = t;
    mm.commit();
    return { ok: true, result: `${sv.name}: read-only labels ${t ? 'trusted' : 'not trusted'}.`, display: { path: sv.name } };
  }

  if (action === 'remove') {
    const sv = find();
    const no = await approve(ctx, `Remove the MCP server “${sv.name}”? ${where(sv)}${sv.pack ? `\n(It came with the pack ${sv.pack}.)` : ''}${sv.oauth?.access ? '\nIts sign-in is removed too.' : ''}`, 'Remove it');
    if (no) return declined(no);
    s.mcpServers = list.filter((x) => x !== sv);
    mm.commit();
    await reload();
    return { ok: true, result: `Removed ${sv.name}.`, display: { path: sv.name } };
  }
  throw new Error('action: list, search, add, test, enable, disable, set_tools, trust or remove');
}

