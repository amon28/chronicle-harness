// Settings › Tools & agent › 🧩 Mods: install, list, enable/disable, inspect and remove mods; the mod guide;
// status chips next to the message box; the install approval that also guards mods written by the assistant.
import modsGuide from '../../docs/MODS.md?raw';
import { httpGet } from '../api.js';
import { bytesToText, looksText } from '../sandbox.js';
import { saveSettings } from '../store.js';
import { builtinFor } from '../personas.js';
import { EXAMPLES, headerFor } from '../modexamples.js';
import { SENSITIVE, checkCode, describePerm, parseModFiles, parseModSource, validateManifest } from '../mods.js';
import { newChat, openSheet, setMode } from './chatlist.js';
import { $, appMode, el, hooks, renderMarkdown, state, toast } from './core.js';
import { modHost } from './modhost.js';
import { setChatPersona } from './render.js';

const records = () => (state.settings.mods ||= []);
const save = () => saveSettings(state.settings);

// ---------- status chips ----------
function renderChips() {
  const box = $('#mod-chips');
  box.innerHTML = '';
  for (const c of modHost.chips()) {
    const b = el('button', 'meta-chip', c.text);
    b.title = c.name;
    b.onclick = () => openMods();
    box.append(b);
  }
}
hooks.modsChanged = () => {
  renderChips();
  if ($('#mods-sheet').classList.contains('open')) renderList();
};

// ---------- the list ----------
function permChips(perms) {
  const w = el('div', 'mod-perms');
  if (!perms.length) w.append(el('span', 'mod-perm', 'no permissions'));
  for (const p of perms) {
    const c = el('span', 'mod-perm' + (SENSITIVE.has(p) || p === 'net:*' ? ' hot' : ''), p);
    c.title = describePerm(p);
    w.append(c);
  }
  return w;
}
function stateText(rec) {
  if (rec.enabled === false) return 'off';
  const inst = modHost.instance(rec.id);
  if (!inst) return 'starting…';
  if (inst.error) return '✗ ' + inst.error.split('\n')[0].slice(0, 120);
  if (!inst.ready) return 'starting…';
  const bits = [inst.tools.length && `${inst.tools.length} tool${inst.tools.length === 1 ? '' : 's'}`, inst.commands.length && `${inst.commands.length} command${inst.commands.length === 1 ? '' : 's'}`, ...inst.hooks.map((h) => 'hook ' + h)].filter(Boolean);
  return '✓ running' + (bits.length ? ' · ' + bits.join(', ') : '');
}
function renderList() {
  const box = $('#mod-list');
  box.innerHTML = '';
  const list = records();
  $('#mod-count').textContent = list.length ? `${list.length} mod${list.length === 1 ? '' : 's'} installed` : 'No mods installed yet. Try an example below, install one from a file or link, or make one with the Mod Builder.';
  for (const rec of list) {
    const d = el('details', 'skill-item');
    const sum = el('summary');
    const on = el('input');
    on.type = 'checkbox';
    on.checked = rec.enabled !== false;
    on.onclick = (e) => e.stopPropagation();
    on.onchange = async () => {
      rec.enabled = on.checked;
      save();
      if (on.checked) await modHost.startOne(rec);
      else modHost.stopOne(rec.id);
      renderList();
    };
    sum.append(on, el('span', 'slash-cmd', rec.name), el('span', 'persona-desc', `v${rec.version} · ${stateText(rec)}`));
    d.append(sum);
    d.append(el('p', 'hint', rec.description || ''));
    d.append(permChips(rec.permissions || []));
    const row = el('div', 'row gap-sm wrap');
    const src = el('button', 'ghost-btn small', '</> Source & logs');
    src.onclick = () => showDetail(rec);
    const del = el('button', 'danger-btn small', 'Remove');
    del.onclick = () => {
      if (!confirm(`Remove the mod “${rec.name}” and its saved data?`)) return;
      modHost.stopOne(rec.id);
      state.settings.mods = records().filter((x) => x !== rec);
      delete (state.settings.modData || {})[rec.id];
      save();
      renderChips();
      renderList();
    };
    row.append(src, del);
    d.append(row);
    box.append(d);
  }
  const ex = $('#mod-examples');
  ex.innerHTML = '';
  for (const e of EXAMPLES) {
    const have = records().find((r) => r.id === e.manifest.id);
    const b = el('button', 'menu-item', `${have ? '✓ ' : '＋ '}${e.manifest.name} – ${e.manifest.description}`);
    b.onclick = () => confirmInstall({ manifest: e.manifest, code: headerFor(e.manifest) + e.code, source: 'example' });
    ex.append(b);
  }
}
function showDetail(rec) {
  const inst = modHost.instance(rec.id);
  $('#mod-detail-title').textContent = rec.name;
  $('#mod-detail-logs').textContent = inst?.logs.length ? inst.logs.join('\n') : '(nothing logged)';
  $('#mod-detail-code').textContent = rec.code;
  openSheet('#mod-detail-sheet', true);
}
export function openMods() {
  renderList();
  openSheet('#settings-sheet', false);
  openSheet('#mods-sheet', true);
}
$('#open-mods').onclick = openMods;

// ---------- installing ----------
let pendingInstall = null;
/** Show the approval screen. Resolves { ok, text } once the user decides and the mod has (not) started. */
export function confirmInstall({ manifest, code, source = 'file' }) {
  return new Promise((resolve) => {
    let m;
    try {
      m = validateManifest(manifest);
      checkCode(code);
    } catch (e) {
      toast(e.message, 4000);
      return resolve({ ok: false, text: `Not installed: ${e.message}` });
    }
    const old = records().find((r) => r.id === m.id);
    pendingInstall?.resolve({ ok: false, text: 'The user closed the install screen without installing.' });
    pendingInstall = { resolve, m, code, source, old };
    $('#mi-title').textContent = old ? `Update “${m.name}”` : `Install “${m.name}”`;
    $('#mi-meta').textContent = `${old ? `v${old.version} → ` : ''}v${m.version}${m.author ? ' · by ' + m.author : ''}${source === 'agent' ? ' · written by the assistant' : ''}`;
    $('#mi-desc').textContent = m.description;
    const ul = $('#mi-perms');
    ul.innerHTML = '';
    if (!m.permissions.length) ul.append(el('li', null, 'No permissions – it can only run its own code.'));
    for (const p of m.permissions) {
      const added = old && !(old.permissions || []).includes(p);
      ul.append(el('li', (SENSITIVE.has(p) || p === 'net:*' ? 'hot' : '') + (added ? ' new' : ''), `${p === 'net:*' || SENSITIVE.has(p) ? '⚠ ' : ''}${describePerm(p)}${added ? '  (new)' : ''}`));
    }
    $('#mi-code').textContent = code;
    $('#mi-warn').hidden = !m.permissions.some((p) => SENSITIVE.has(p) || p === 'net:*');
    $('#mi-go').textContent = old ? 'Update' : 'Install';
    openSheet('#mod-install-sheet', true);
  });
}
$('#mi-go').onclick = async () => {
  const p = pendingInstall;
  if (!p) return;
  pendingInstall = null;
  openSheet('#mod-install-sheet', false);
  const rec = { ...(p.old || {}), id: p.m.id, name: p.m.name, version: p.m.version, description: p.m.description, author: p.m.author, permissions: p.m.permissions, code: p.code, enabled: true, installedAt: p.old?.installedAt || Date.now(), updatedAt: Date.now(), source: p.source };
  const list = records();
  const i = list.findIndex((r) => r.id === rec.id);
  if (i >= 0) list[i] = rec;
  else list.push(rec);
  save();
  const r = await modHost.startOne(rec);
  renderList();
  renderChips();
  const text = r.ok ? `Installed and running: ${rec.name} v${rec.version}. Registered ${r.tools} tool(s), ${r.commands} command(s), hooks: ${r.hooks.join(', ') || 'none'}.` : `Installed, but it failed to start: ${r.error}`;
  toast(r.ok ? `🧩 ${rec.name} is running` : `🧩 ${rec.name} failed to start`, 4000);
  p.resolve({ ok: r.ok, text });
};
const cancelInstall = () => {
  const p = pendingInstall;
  pendingInstall = null;
  openSheet('#mod-install-sheet', false);
  p?.resolve({ ok: false, text: 'The user declined the install.' });
};
$('#mi-cancel').onclick = cancelInstall;
new MutationObserver(() => {
  if (pendingInstall && !$('#mod-install-sheet').classList.contains('open')) {
    const p = pendingInstall;
    pendingInstall = null;
    p.resolve({ ok: false, text: 'The user closed the install screen without installing.' });
  }
}).observe($('#mod-install-sheet'), { attributes: true, attributeFilter: ['class'] });

async function installFile(f) {
  try {
    let parsed;
    if (/\.zip$/i.test(f.name)) {
      const { unzipSync } = await import('fflate');
      const files = {};
      for (const [p, data] of Object.entries(unzipSync(new Uint8Array(await f.arrayBuffer())))) if (data.length && looksText(data)) files[p] = bytesToText(data);
      parsed = parseModFiles(files);
      parsed.code = headerFor(parsed.manifest) + parsed.code;
    } else parsed = parseModSource(await f.text());
    confirmInstall({ ...parsed, source: 'file' });
  } catch (e) {
    toast(e.message, 5000);
  }
}
$('#mod-file-btn').onclick = () => $('#mod-file').click();
$('#mod-file').onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) installFile(f);
};
$('#mod-link-go').onclick = async () => {
  const url = $('#mod-link').value.trim();
  if (!/^https:\/\//i.test(url)) return toast('Paste an https:// link to a .js file');
  try {
    const r = await httpGet(url, {}, 20000);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    confirmInstall({ ...parseModSource(r.body), source: url });
    $('#mod-link').value = '';
  } catch (e) {
    toast('Could not install from that link: ' + e.message, 5000);
  }
};

// the Mod Builder
$('#mod-make').onclick = () => {
  if (!state.settings.personas.some((p) => p.id === 'mod-builder')) {
    const b = builtinFor('mod-builder');
    if (b) state.settings.personas.push({ ...b, avatar: { ...b.avatar }, builtin: true });
    save();
  }
  openSheet('#mods-sheet', false);
  if (appMode === 'rp') setMode('chat');
  newChat();
  setChatPersona('mod-builder');
  $('#input').focus();
};

// the guide
$('#mod-guide-btn').onclick = () => {
  const body = $('#mod-guide-body');
  if (!body.dataset.done) {
    body.innerHTML = renderMarkdown(modsGuide);
    body.dataset.done = '1';
  }
  openSheet('#mod-guide-sheet', true);
};

// the assistant installs a mod (always through the approval screen)
hooks.saveMod = async (m, code) => {
  const header = { id: m.id, name: m.name, version: m.version || '1.0.0', description: m.description || '', author: 'written by the assistant', permissions: Array.isArray(m.permissions) ? m.permissions : [] };
  let manifest;
  try {
    manifest = validateManifest(header);
  } catch (e) {
    return { ok: false, text: `Not installed: ${e.message}` };
  }
  return confirmInstall({ manifest, code: headerFor(manifest) + code, source: 'agent' });
};

setTimeout(() => modHost.startAll().then(() => hooks.modsChanged()), 300);
globalThis.__ocmMods = { modHost, confirmInstall };

// ---------- panels added by mods (mod.panel) ----------
let openPanel = null;
function showPanelList() {
  openPanel = null;
  $('#panel-title').textContent = '🧩 Panels';
  $('#panel-body').hidden = true;
  $('#panel-refresh').hidden = $('#panel-back').hidden = true;
  const list = $('#panel-list');
  list.hidden = false;
  list.innerHTML = '';
  for (const p of modHost.panelList()) {
    const b = el('button', 'menu-item');
    b.append(document.createTextNode(`${p.icon || '🧩'} ${p.name} `), el('span', 'dim', `· ${p.mod}${p.description ? ' – ' + p.description : ''}`));
    b.onclick = () => showPanel(p);
    list.append(b);
  }
  if (!list.children.length) list.append(el('p', 'hint', 'No mod has added a panel.'));
}
async function showPanel(p) {
  openPanel = p;
  $('#panel-title').textContent = `${p.icon || '🧩'} ${p.name}`;
  $('#panel-list').hidden = true;
  const body = $('#panel-body');
  body.hidden = false;
  $('#panel-refresh').hidden = $('#panel-back').hidden = false;
  body.textContent = 'Loading…';
  try {
    body.innerHTML = renderMarkdown(await modHost.renderPanel(p.id, p.name), { highlight: false });
  } catch (e) {
    body.textContent = 'Could not load this panel: ' + e.message;
  }
}
$('#cm-panels').onclick = () => {
  openSheet('#chat-menu', false);
  showPanelList();
  openSheet('#panel-sheet', true);
};
$('#panel-refresh').onclick = () => openPanel && showPanel(openPanel);
$('#panel-back').onclick = showPanelList;
const prevModsChanged = hooks.modsChanged;
hooks.modsChanged = () => {
  prevModsChanged?.();
  $('#cm-panels').hidden = !modHost.panelList().length;
};
