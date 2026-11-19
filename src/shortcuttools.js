// The assistant looks after the user's shortcuts (Settings › Shortcuts & recipes) like it does personas: it can list
// and read them, and add, change or remove snippets (/commands), recipes (step-by-step workflows) and packs (a set of
// things installed and removed together). Every change is shown to the user and waits for their OK; hidden
// characters are removed from what is saved (prompt injection likes invisible Unicode), and a pack's MCP servers are
// added switched off, as when the user installs a pack themselves.
import { parseRecipe, revealHidden } from './recipes.js';
import { parsePack, reviewPack } from './packs.js';

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const CMD_RX = /^[\w-]{1,24}$/;
const clean = (s) => revealHidden(String(s ?? '')).clean;
const short = (s, n = 400) => {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export const shortcutDefs = () => [
  fn(
    'shortcuts',
    "The user's shortcuts (Settings › Shortcuts & recipes). Snippets are /commands that put a ready text in the message box ({{text}} = what is typed after the command). Recipes are workflows in one Markdown file: front matter (name, description, params, optional schedule) then one \"## Step\" per step, sent one after another; \"## Use: other-recipe key=value\" runs another. Packs install a set of snippets, recipes, skills, MCP servers and personas together, and remove them together. action list / read look; save_snippet, save_recipe, save_pack and delete change something – each is shown to the user first. Change something in place (save it under the same command or name) instead of making a second copy; read it first.",
    {
      action: { type: 'string', enum: ['list', 'read', 'save_snippet', 'save_recipe', 'save_pack', 'delete'] },
      kind: { type: 'string', enum: ['snippet', 'recipe', 'pack'], description: 'list (default: all three) / read / delete: which kind' },
      name: { type: 'string', description: 'read / delete: the snippet command (without /), the recipe name or the pack id' },
      cmd: { type: 'string', description: 'save_snippet: the command, letters/digits/-/_ (e.g. "standup"); an existing one is replaced' },
      title: { type: 'string', description: 'save_snippet: a short title shown in the / menu' },
      text: { type: 'string', description: 'save_snippet: the text ({{text}} for what the user types after the command). save_recipe: the whole recipe file (front matter + ## steps); a recipe with the same name is replaced' },
      send: { type: 'boolean', description: 'save_snippet: send it at once instead of putting it in the message box' },
      pack: { type: 'object', description: 'save_pack: { "chronicle_pack": 1, "id", "name", "version", "description", "snippets": [{cmd,title,text,send}], "recipes": [{text}], "skills": [{name,description,instructions}], "mcpServers": [{name,url}], "personas": [{name,description,prompt}] }. A newer version of the same id replaces the old one.' },
    },
    ['action'],
  ),
];

async function approve(ctx, summary, yes) {
  if (!ctx.ask) throw new Error('Changing shortcuts needs your approval, which is not available here.');
  ctx.onStatus?.('waiting for your approval…');
  const answer = await ctx.ask(summary, [yes, 'Not now'], ctx.signal);
  return answer === yes ? null : answer;
}
const declined = (answer) => ({ ok: false, result: `The user said no (${answer}). Ask what to change, then try again.`, display: { error: 'declined' } });

const recipeLine = (r) => {
  try {
    const p = parseRecipe(r.text, r.name);
    return `/${p.name} – ${p.description || 'no description'} (${p.steps.length} step${p.steps.length === 1 ? '' : 's'}${p.params.length ? `; params ${p.params.map((x) => x.name + (x.required ? '*' : '')).join(', ')}` : ''}${p.schedule ? '; scheduled' : ''})`;
  } catch (e) {
    return `/${r.name} – ⚠ ${e.message}`;
  }
};
const packCount = (s, id) => ['snippets', 'recipes', 'agentSkills', 'mcpServers', 'personas'].reduce((n, k) => n + (s[k] || []).filter((x) => x.pack === id).length, 0);
const fromPack = (x) => (x.pack ? ` [pack ${x.pack}]` : '');

/** → a tool result, or null when the call is not this tool's. ctx.shortcuts: { settings(), commit(), install(pack) } */
export async function runShortcutTool(name, args, ctx) {
  if (name !== 'shortcuts') return null;
  const sc = ctx.shortcuts;
  if (!sc) return { ok: false, result: 'Shortcuts are not available here.', display: { error: 'unavailable' } };
  const s = sc.settings();
  const action = String(args.action || 'list');
  const kind = String(args.kind || '');
  const key = String(args.name || args.cmd || '').trim().replace(/^\//, '');

  if (action === 'list') {
    const out = [];
    if (!kind || kind === 'snippet') out.push('Snippets:', ...((s.snippets || []).map((x) => `/${x.cmd} – ${x.title || x.cmd}${x.send ? ' (sends at once)' : ''}${fromPack(x)}`)), ...(s.snippets?.length ? [] : ['(none)']));
    if (!kind || kind === 'recipe') out.push('Recipes:', ...((s.recipes || []).map((r) => recipeLine(r) + fromPack(r))), ...(s.recipes?.length ? [] : ['(none)']));
    if (!kind || kind === 'pack') out.push('Packs:', ...((s.packs || []).map((p) => `${p.id} – ${p.name} ${p.version} (${packCount(s, p.id)} items)`)), ...(s.packs?.length ? [] : ['(none)']));
    return { ok: true, result: out.join('\n'), display: { path: kind || 'shortcuts' } };
  }

  if (action === 'read') {
    if (kind === 'snippet' || (!kind && (s.snippets || []).some((x) => x.cmd === key))) {
      const x = (s.snippets || []).find((y) => y.cmd.toLowerCase() === key.toLowerCase());
      if (!x) throw new Error(`No snippet /${key} – see action list`);
      return { ok: true, result: `/${x.cmd} – ${x.title || x.cmd}${x.send ? ' (sends at once)' : ''}${fromPack(x)}\n\n${x.text}`, display: { path: '/' + x.cmd } };
    }
    if (kind === 'recipe' || (!kind && (s.recipes || []).some((x) => x.name === key))) {
      const r = (s.recipes || []).find((y) => y.name === key.toLowerCase());
      if (!r) throw new Error(`No recipe ${key} – see action list`);
      return { ok: true, result: r.text, display: { path: '/' + r.name } };
    }
    const p = (s.packs || []).find((y) => y.id === key);
    if (!p) throw new Error(`No snippet, recipe or pack called "${key}" – see action list`);
    const items = [];
    for (const [k, label, nm] of [['snippets', 'snippet', (x) => '/' + x.cmd], ['recipes', 'recipe', (x) => '/' + x.name], ['agentSkills', 'skill', (x) => x.name], ['mcpServers', 'MCP server', (x) => x.name], ['personas', 'persona', (x) => x.name]])
      for (const x of (s[k] || []).filter((y) => y.pack === p.id)) items.push(`${label}: ${nm(x)}`);
    return { ok: true, result: `${p.id} – ${p.name} ${p.version}${p.author ? ` by ${p.author}` : ''}\n${items.join('\n') || '(nothing left in it)'}`, display: { path: p.id } };
  }

  if (action === 'save_snippet') {
    const cmd = key;
    if (!CMD_RX.test(cmd)) throw new Error('cmd: 1–24 letters, digits, - or _ (e.g. "standup")');
    const text = clean(args.text).trim();
    if (!text) throw new Error('text is required');
    const title = clean(args.title || cmd).trim().slice(0, 60) || cmd;
    const list = (s.snippets ||= []);
    const old = list.find((x) => x.cmd.toLowerCase() === cmd.toLowerCase());
    const no = await approve(ctx, `${old ? 'Change' : 'Add'} the snippet /${cmd} – “${title}”${args.send ? ' (sends at once)' : ''}?\n\n${short(text)}`, old ? 'Change it' : 'Add it');
    if (no) return declined(no);
    if (old) Object.assign(old, { cmd, title, text, send: !!args.send });
    else list.push({ id: 's_' + Math.random().toString(36).slice(2, 10), cmd, title, text, send: !!args.send });
    sc.commit();
    return { ok: true, result: `${old ? 'Changed' : 'Added'} /${cmd}. The user types /${cmd} in the message box to use it.`, display: { path: '/' + cmd } };
  }

  if (action === 'save_recipe') {
    const text = clean(args.text);
    const r = parseRecipe(text); // throws with what is wrong
    const list = (s.recipes ||= []);
    const old = list.find((x) => x.name === r.name);
    const steps = r.steps.map((x, i) => `${i + 1}. ${x.title || short(x.text, 80)}`).join('\n');
    const no = await approve(ctx, `${old ? 'Change' : 'Add'} the recipe /${r.name}${r.description ? ` – ${r.description}` : ''}?\n\n${steps}${r.params.length ? `\n\nParameters: ${r.params.map((p) => p.name).join(', ')}` : ''}${r.schedule ? `\nRuns on a schedule: ${r.schedule.at ? 'daily ' + r.schedule.at : 'every ' + r.schedule.every + ' min'}` : ''}`, old ? 'Change it' : 'Add it');
    if (no) return declined(no);
    if (old) Object.assign(old, { text, at: Date.now() });
    else list.push({ id: 'rc_' + Math.random().toString(36).slice(2, 10), name: r.name, text, at: Date.now() });
    sc.commit();
    return { ok: true, result: `${old ? 'Changed' : 'Added'} the recipe /${r.name} (${r.steps.length} steps). The user runs it from the ⚡ menu or with /${r.name}.`, display: { path: '/' + r.name } };
  }

  if (action === 'save_pack') {
    let raw = args.pack;
    if (typeof raw === 'string') raw = JSON.parse(raw);
    const p = parsePack({ chronicle_pack: 1, ...(raw || {}) });
    const rv = reviewPack(p);
    const old = (s.packs || []).find((x) => x.id === p.id);
    const warn = [rv.hidden ? `⚠ ${rv.hidden} hidden character(s) – removed on install.` : '', rv.runs.length ? `⚠ Its MCP servers run programs in Linux: ${rv.runs.join(' · ')}. They are added switched off.` : ''].filter(Boolean);
    const no = await approve(ctx, `${old ? `Update the pack “${p.name}” (${old.version} → ${p.version})` : `Install the pack “${p.name}” ${p.version}`}?\n\n${rv.lines.join('\n')}${warn.length ? '\n\n' + warn.join('\n') : ''}`, old ? 'Update it' : 'Install it');
    if (no) return declined(no);
    const r = sc.install(p);
    return { ok: true, result: `Installed the pack ${p.id}: ${r.added} item${r.added === 1 ? '' : 's'}${r.skipped.length ? `; kept the user's own ${r.skipped.join(', ')} (same names – the pack's copies were skipped)` : ''}${p.mcpServers.length ? '. Its MCP servers are switched off until the user switches them on.' : '.'}`, display: { path: p.id } };
  }

  if (action === 'delete') {
    if (!kind) throw new Error('kind is required for delete: snippet, recipe or pack');
    if (kind === 'pack') {
      const p = (s.packs || []).find((x) => x.id === key);
      if (!p) throw new Error(`No pack ${key}`);
      const no = await approve(ctx, `Remove the pack “${p.name}” and the ${packCount(s, p.id)} things it installed?`, 'Remove it');
      if (no) return declined(no);
      const n = sc.uninstall(p.id);
      return { ok: true, result: `Removed the pack ${p.id} (${n} items).`, display: { path: p.id } };
    }
    const field = kind === 'snippet' ? 'snippets' : 'recipes';
    const match = (x) => (kind === 'snippet' ? x.cmd.toLowerCase() === key.toLowerCase() : x.name === key.toLowerCase());
    const x = (s[field] || []).find(match);
    if (!x) throw new Error(`No ${kind} /${key}`);
    const no = await approve(ctx, `Delete the ${kind} /${kind === 'snippet' ? x.cmd : x.name}?${x.pack ? ` (It came with the pack ${x.pack}.)` : ''}`, 'Delete it');
    if (no) return declined(no);
    s[field] = s[field].filter((y) => y !== x);
    sc.commit();
    return { ok: true, result: `Deleted the ${kind} /${kind === 'snippet' ? x.cmd : x.name}.`, display: { path: '/' + key } };
  }
  throw new Error('action: list, read, save_snippet, save_recipe, save_pack or delete');
}
