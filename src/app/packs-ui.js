// 📦 Packs (install / remove / make one) and the MCP registry browser in the MCP servers sheet.
import { $, el, hooks, state, toast, uid } from './core.js';
import { saveSettings } from '../store.js';
import { httpGet } from '../api.js';
import { parsePack, reviewPack, installPack, uninstallPack } from '../packs.js';
import { searchRegistry, serverFrom } from '../mcpregistry.js';
import { newSkill } from '../skills.js';
import { newPersonaId } from '../personas.js';
import { DEFAULT_SNIPPETS } from '../snippets.js';
import { canUseShell } from '../shell.js';
import { listTools as mcpListTools } from '../mcp.js';
import { openDrawer, openSheet } from './chatlist.js';
import { shareBytes } from './extras.js';
import { askText } from './choose.js';
import { loadGithub, loadMarketEntry, loadZip, parseGithubUrl, pluginToPack, unzipLimited } from '../claudeplugin.js';
import { githubAuth } from '../github.js';

let pending = null;
let pendingFrom = null; // the Claude plugin it came from, if it did
function openPacks() {
  const list = $('#pk-list');
  list.innerHTML = '';
  const packs = state.settings.packs || [];
  if (!packs.length) list.append(el('p', 'hint pad', 'No packs installed.'));
  for (const p of packs) {
    const row = el('div', 'persona-item');
    const t = el('div', 'persona-text');
    const count = ['snippets', 'recipes', 'agentSkills', 'mcpServers', 'personas'].reduce((n, k) => n + (state.settings[k] || []).filter((x) => x.pack === p.id).length, 0);
    t.append(el('div', 'persona-title', `${p.name} ${p.version}`), el('div', 'persona-desc', `${p.kind === 'claude-plugin' ? 'Claude plugin · ' : ''}${p.author ? p.author + ' · ' : ''}${count} item${count === 1 ? '' : 's'}`));
    const rm = el('button', 'act', 'Remove');
    rm.onclick = () => {
      if (!confirm(`Remove the pack “${p.name}” and everything it installed?`)) return;
      const n = uninstallPack(state.settings, p.id);
      saveSettings(state.settings);
      toast(`Removed ${p.name} (${n} item${n === 1 ? '' : 's'})`);
      openPacks();
    };
    row.append(t, rm);
    list.append(row);
  }
  $('#pk-main').hidden = false;
  $('#pk-review').hidden = true;
  $('#pk-market').hidden = true;
  openDrawer(false);
  openSheet('#settings-sheet', false);
  openSheet('#packs-sheet', true);
}
function review(text) {
  let p;
  try {
    p = parsePack(text);
  } catch (e) {
    return toast(`Not a usable pack: ${e.message}`, 4500);
  }
  showReview(p);
}
/** The review screen for a pack – or for a Claude plugin turned into one (plugin: { skipped, notes, license, from }). */
function showReview(p, plugin = null) {
  pending = p;
  pendingFrom = plugin;
  const r = reviewPack(p);
  const old = (state.settings.packs || []).find((x) => x.id === p.id);
  $('#pk-title').textContent = `${plugin ? '🧩 ' : ''}${p.name} ${p.version}${old ? ` (replaces ${old.version})` : ''}`;
  $('#pk-desc').textContent = [p.description, p.author && `by ${p.author}`, plugin?.license && `licence: ${plugin.license}`, plugin?.from].filter(Boolean).join(' – ');
  const warn = [];
  if (plugin) warn.push('⚠ A Claude plugin is instructions for the assistant from whoever wrote it. Read the skills below; install only plugins you trust.');
  if (r.hidden) warn.push(`⚠ ${r.hidden} hidden character${r.hidden === 1 ? '' : 's'} in its texts – they can hide instructions; they are removed on install.`);
  if (r.runs.length) warn.push(`⚠ Its MCP servers run programs in the built-in Linux: ${r.runs.join(' · ')}. They are added switched off – switch each on yourself.`);
  $('#pk-warn').hidden = !warn.length;
  $('#pk-warn').textContent = warn.join('\n');
  const ul = $('#pk-items');
  ul.innerHTML = '';
  r.lines.forEach((l) => ul.append(el('li', null, l)));
  // what a plugin has that is not installed, and why
  const out = $('#pk-skipped');
  out.innerHTML = '';
  for (const x of plugin?.skipped || []) out.append(el('li', null, `⛔ ${x.what} – ${x.why}`));
  for (const n of plugin?.notes || []) out.append(el('li', 'hint', `💡 ${n}`));
  out.hidden = !out.children.length;
  // the full text of each skill: it becomes the assistant's instructions once installed and switched on
  const texts = $('#pk-texts');
  texts.innerHTML = '';
  for (const k of p.skills) {
    const d = el('details', 'pk-text');
    const files = Object.keys(k.files);
    d.append(el('summary', null, `📚 ${k.name}${files.length ? ` (+${files.length} file${files.length === 1 ? '' : 's'})` : ''}`), el('pre', null, k.instructions + (files.length ? `\n\n[files: ${files.join(', ')}]` : '')));
    texts.append(d);
  }
  $('#pk-main').hidden = true;
  $('#pk-market').hidden = true;
  $('#pk-review').hidden = false;
}

// ---------- Claude plugins: a GitHub link (repo, folder, marketplace) or a .zip ----------
const ghDeps = () => ({ http: (url, h) => httpGet(url, h, 20000), token: githubAuth()?.token || '', api: globalThis.__ocmGithubBase?.api || 'https://api.github.com', raw: globalThis.__ocmGithubBase?.raw || 'https://raw.githubusercontent.com' });
const shellHere = () => !!(canUseShell() || globalThis.__ocmShell);
function showPlugin(res, from) {
  const pl = res.plugin;
  if (!pl.skills.length && !pl.commands.length && !pl.agents.length && !pl.mcp.length) return toast('That plugin has nothing Chronicle can use (no skills, commands, agents or MCP servers)', 5000);
  const conv = pluginToPack(pl, { shell: shellHere() });
  let p;
  try {
    p = parsePack(conv.pack);
  } catch (e) {
    return toast(`Could not read the plugin: ${e.message}`, 5000);
  }
  showReview(p, { ...conv, from });
}
function showMarket(res, from) {
  const m = res.market;
  $('#pk-mtitle').textContent = `🧩 ${m.name || 'Plugin marketplace'}`;
  $('#pk-mdesc').textContent = [m.description, m.owner && `by ${m.owner}`, `${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}`].filter(Boolean).join(' – ');
  const box = $('#pk-mlist');
  box.innerHTML = '';
  for (const it of m.plugins) {
    const row = el('div', 'persona-item');
    const t = el('div', 'persona-text');
    t.append(el('div', 'persona-title', `${it.name}${it.version ? ' ' + it.version : ''}`), el('div', 'persona-desc', it.where.kind === 'none' ? `not here: ${it.where.why}` : it.description));
    row.append(t);
    if (it.where.kind !== 'none') {
      const b = el('button', 'act', 'Open');
      b.onclick = async () => {
        toast(`Reading ${it.name}…`);
        try {
          showPlugin(await loadMarketEntry(it, ghDeps(), { zip: res.zip, cache: res.cache }), from);
        } catch (e) {
          toast(e.message, 5000);
        }
      };
      row.append(b);
    }
    box.append(row);
  }
  $('#pk-main').hidden = true;
  $('#pk-review').hidden = true;
  $('#pk-market').hidden = false;
}
async function importPluginUrl(url) {
  toast('Reading the plugin…');
  try {
    const res = await loadGithub(url, ghDeps());
    if (res.kind === 'marketplace') showMarket(res, url);
    else showPlugin(res, url);
  } catch (e) {
    toast(`Couldn’t get it: ${e.message}`, 5000);
  }
}
/** A Claude plugin .zip → its review in the Packs sheet (also used by Skills › Import for a plugin zip). */
export async function importPluginZip(f) {
  if (!$('#packs-sheet').classList.contains('open')) openPacks();
  try {
    const { unzipSync } = await import('fflate');
    const res = loadZip(unzipLimited(new Uint8Array(await f.arrayBuffer()), unzipSync));
    if (res.kind === 'marketplace') showMarket(res, f.name);
    else showPlugin(res, f.name);
  } catch (e) {
    toast(`Not a usable plugin: ${e.message}`, 5000);
  }
}
$('#pk-mcancel').onclick = () => openPacks();

$('#pk-install').onclick = () => {
  if (!pending) return;
  const r = installPack(state.settings, pending, { uid, newSkill, newPersona: (x) => ({ id: newPersonaId(), avatar: { emoji: '📦', bg: '#64748b' }, ...x }) });
  if (pendingFrom) Object.assign(state.settings.packs.find((x) => x.id === pending.id) || {}, { kind: 'claude-plugin', from: pendingFrom.from || '' });
  saveSettings(state.settings);
  toast(`Installed ${pending.name}: ${r.added} item${r.added === 1 ? '' : 's'}${r.skipped.length ? ` (kept yours: ${r.skipped.join(', ')})` : ''}`, 4500);
  pending = null;
  openPacks();
};
$('#pk-cancel').onclick = () => ((pending = null), openPacks());
$('#pk-import').onclick = async () => {
  let url = $('#pk-url').value.trim();
  // a GitHub repo or folder (not a .json file in one) is a Claude plugin or marketplace
  const gh = parseGithubUrl(url);
  if (gh && (!gh.file || /(^|\/)\.claude-plugin\/(plugin|marketplace)\.json$/.test(gh.path))) return importPluginUrl(url);
  if (!/^https:\/\//.test(url)) return toast('Paste an https:// link to a pack .json, or a GitHub link to a Claude plugin');
  url = url.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/$2/');
  try {
    const r = await httpGet(url, {}, 20000);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    if (r.body.length > 2e6) throw new Error('That file is too big for a pack');
    review(r.body);
  } catch (e) {
    toast(`Couldn’t get it: ${e.message}`, 4000);
  }
};
$('#pk-file-btn').onclick = () => $('#pk-file').click();
$('#pk-file').onchange = async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f && /\.(zip|plugin)$/i.test(f.name)) importPluginZip(f);
  else if (f) review(await f.text());
};
$('#pk-make').onclick = async () => {
  const name = (await askText('Name of the pack', 'My kit', { ok: 'Make pack', max: 80 }))?.trim();
  if (!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'my-kit';
  const defaults = new Set(DEFAULT_SNIPPETS.map((s) => s.id));
  const pack = {
    chronicle_pack: 1,
    id,
    name,
    version: '1.0',
    author: state.settings.prefs?.userName || '',
    snippets: (state.settings.snippets || []).filter((s) => !defaults.has(s.id) && !s.pack).map(({ cmd, title, text, send }) => ({ cmd, title, text, send })),
    recipes: (state.settings.recipes || []).filter((r) => !r.pack).map(({ name: n, text }) => ({ name: n, text })),
    skills: (state.settings.agentSkills || []).filter((k) => k.source !== 'builtin' && !k.pack).map(({ name: n, description, instructions, files }) => ({ name: n, description, instructions, files })),
    // never tokens or headers: those are yours
    mcpServers: (state.settings.mcpServers || []).filter((m) => !m.pack).map((m) => (m.transport === 'stdio' ? { name: m.name, command: m.command.replace(/\b[A-Z_][A-Z0-9_]*=('[^']*'|\S+)\s+/g, '') } : { name: m.name, url: m.url })),
  };
  try {
    parsePack(pack);
  } catch (e) {
    return toast(e.message, 4000);
  }
  await shareBytes(`${id}.chronicle-pack.json`, new TextEncoder().encode(JSON.stringify(pack, null, 2)));
};
$('#settings-packs').onclick = openPacks;

// ---------- the MCP registry ----------
async function searchReg() {
  const box = $('#mcp-reg-list');
  box.innerHTML = '';
  box.append(el('p', 'hint pad', 'Searching…'));
  let hits;
  try {
    hits = await searchRegistry($('#mcp-reg-q').value.trim(), { http: (url, h) => httpGet(url, h, 20000) });
  } catch (e) {
    box.innerHTML = '';
    return box.append(el('p', 'hint pad', '✗ ' + e.message));
  }
  box.innerHTML = '';
  if (!hits.length) box.append(el('p', 'hint pad', 'Nothing found.'));
  for (const h of hits.slice(0, 25)) {
    const row = el('div', 'persona-item');
    const t = el('div', 'persona-text');
    const how = h.options.map((o) => (o.kind === 'remote' ? '🌐 remote' : `🐧 ${o.kind}`)).join(' · ') || 'not runnable here';
    t.append(el('div', 'persona-title', `${h.title}${h.version ? ' ' + h.version : ''}`), el('div', 'persona-desc', `${h.publisher ? 'by ' + h.publisher + ' · ' : ''}${how}${h.description ? ' – ' + h.description.slice(0, 140) : ''}`));
    row.append(t);
    if (h.options.length) {
      const add = el('button', 'act', 'Add');
      add.onclick = () => addFromRegistry(h);
      row.append(add);
    }
    box.append(row);
  }
}
async function addFromRegistry(h) {
  // a remote server if there is one (nothing runs on the phone), else the package in Linux
  const opt = h.options.find((o) => o.kind === 'remote') || h.options.find((o) => canUseShell() || globalThis.__ocmShell) || null;
  if (!opt) return toast('This server only comes as a package, which needs the built-in Linux (Settings › Linux terminal)', 4500);
  const what = opt.kind === 'remote' ? `connects to ${opt.url}` : `runs this in the built-in Linux:\n${opt.command}`;
  if (!confirm(`Add “${h.title}”${h.publisher ? ` by ${h.publisher}` : ''}?\n\nIt ${what}\n\nThe registry lists servers; it does not check them. Add only servers you trust.`)) return;
  const values = {};
  for (const v of opt.kind === 'remote' ? opt.headers : opt.env) {
    if (!v.required && !v.secret) continue;
    const val = await askText(`${v.name}${v.required ? ' (required)' : ' (optional)'}`, v.def || '', { hint: v.description || '', ok: 'Next' });
    if (val == null) return;
    if (!val && v.required) return toast(`${v.name} is required`);
    values[v.name] = val;
  }
  const sv = serverFrom(h, opt, values, { id: 'mcp_' + uid().slice(0, 8), secret: uid() + uid() });
  state.settings.mcpServers.push(sv);
  saveSettings(state.settings);
  toast(`Added ${sv.name} – testing it…`);
  $('#open-mcp').click(); // re-render the list, then test the new one
  setTimeout(() => [...document.querySelectorAll('#mcp-list .mcp-item')].pop()?.querySelector('.act')?.click(), 100);
}
$('#mcp-reg-go').onclick = searchReg;
$('#mcp-reg-q').addEventListener('keydown', (e) => e.key === 'Enter' && searchReg());

// the assistant's shortcuts tool (shortcuttools.js): the user's snippets, recipes and packs, changed after their OK
hooks.shortcuts = {
  settings: () => state.settings,
  commit: () => saveSettings(state.settings),
  install: (p) => {
    const r = installPack(state.settings, p, { uid, newSkill, newPersona: (x) => ({ id: newPersonaId(), avatar: { emoji: '📦', bg: '#64748b' }, ...x }) });
    saveSettings(state.settings);
    return r;
  },
  uninstall: (id) => {
    const n = uninstallPack(state.settings, id);
    saveSettings(state.settings);
    return n;
  },
};

// the assistant's manage_mcp tool (mcpmanage.js): the user's MCP servers, changed after their OK (decision 213)
hooks.mcpManage = {
  settings: () => state.settings,
  commit: () => saveSettings(state.settings),
  listTools: (sv) => mcpListTools(sv, { force: true }),
  search: (q) => searchRegistry(q, { http: (url, h) => httpGet(url, h, 20000) }),
  canShell: () => !!(canUseShell() || globalThis.__ocmShell),
  uid,
};
