// Agent tools chip & workspace files, memory sheet, launcher shortcuts & deep links, the Android back
// button and app update checks.
import { hideBrowserView } from '../browsercontrol.js';
import { handleRedirect } from '../mcpauth.js';
import { preloadLocal } from '../localllm.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { saveSettings, cache } from '../store.js';
import { fmtBytes } from '../files.js';
import { buildTree, filterFiles, sorter, ago } from '../filetree.js';
import { applyTidy, memoryBlock, newMemory, pickLearnModel, shortenMemories, tidyMemories, undoTidy, clip, isStale, GLOBAL } from '../memory.js';
import { ensureVectors, hasTestEmbedder, loadEmbedder } from '../embed.js';
import { onPerfReport } from '../perf.js';
import { canUsePhoneFolder, listFolder, pickFolder, readPhoneFile, writePhoneFile, saveToDownloads, saveAsOnPhone } from '../phonefolder.js';
import { buildPreview, previewKind, previewLabel } from '../preview.js';
import { highlightFile } from '../filehl.js';
import { closeInfo } from './info.js';
import { TOOL_GROUPS } from '../toolset.js';
import { sandbox, getWorkspace, saveWorkspace, wsPut, wsDelete, wsList, deleteWorkspace, looksText, bytesToText, cleanPath } from '../sandbox.js';
import { anySheetOpen, newChat, openDrawer, openSheet, persist, selectConv } from './chatlist.js';
import { CC_MODEL, isCcModel } from '../api.js';
import { $, copyText, hooks, renderMarkdown, currentModel, defaultPersona, el, enabledTools, isGroup, personaById, personas, pref, state, toast, toolsOn } from './core.js';
import { KeepAlive, stopStream } from './engine.js';
import { draft } from './personas-ui.js';
import { IMG_EXT, closeArt, closeFind, mimeOf, openContextSheet, openHtmlPreview, setChatPersona, updateContextChip, updateHeader, wsBlobUrl } from './render.js';
import { openSettings, setPage, showSettingsPage } from './settings.js';

// ---------- agent: tools chip & workspace files ----------
// every chat's file list as last loaded; each update is announced, so what is on screen can follow it (a path in a
// reply drawn before the list was loaded, or before the file it names was written, becomes tappable then)
const wsMem = new (class extends Map {
  set(id, w) {
    super.set(id, w);
    hooks.wsChanged?.(id);
    return this;
  }
})();
function wsCacheSync(id) {
  return wsMem.get(id);
}
async function loadWs(id) {
  const w = await getWorkspace(id);
  wsMem.set(id, w);
  return w;
}

hooks.toolsChanged = () => updateToolsChip();
/** The tool groups this chat gets when its tools are on: [[key, label]] (labels from the persona toolset editor). */
function toolGroupsOn() {
  const t = enabledTools();
  const has = (k) => {
    const v = t[k];
    if (k === 'skills') return Array.isArray(v) && v.length > 0;
    if (k === 'mcp') return v !== false && (state.settings.mcpServers || []).some((x) => x.enabled !== false);
    if (k === 'mods') return v !== false && !!t.modAuthor;
    return !!v;
  };
  return TOOL_GROUPS.filter(([k]) => has(k));
}
function updateToolsChip() {
  updateContextChip();
  const on = toolsOn();
  const n = on ? toolGroupsOn().length : 0;
  const b = $('#tools-btn');
  b.classList.toggle('on', on);
  b.textContent = on ? `🛠 ${n} tools` : '🛠 Tools off';
  b.setAttribute('aria-label', on ? `Tools on: ${n} groups – tap to see or change` : 'Tools off – tap to see or change');
  b.title = '';
}
// the chip opens a small menu: the switch for this chat and what is on; nothing changes until you choose
function renderToolsMenu() {
  const on = toolsOn();
  $('#tools-switch').checked = on;
  const list = $('#tools-on-list');
  list.innerHTML = '';
  const groups = toolGroupsOn();
  $('#tools-on-head').textContent = on ? `On in this chat (${groups.length})` : `Off in this chat – when on (${groups.length})`;
  list.classList.toggle('off', !on);
  for (const [, label] of groups) list.append(el('li', null, label));
}
$('#tools-btn').onclick = () => {
  renderToolsMenu();
  openSheet('#tools-menu', true);
  const r = $('#tools-btn').getBoundingClientRect();
  const card = $('#tools-menu .sheet-card');
  card.style.width = Math.min(300, window.innerWidth - 16) + 'px';
  card.style.left = Math.max(8, Math.min(window.innerWidth - Math.min(300, window.innerWidth - 16) - 8, r.left)) + 'px';
  requestAnimationFrame(() => (card.style.top = Math.max(8, r.top - card.getBoundingClientRect().height - 8) + 'px'));
};
$('#tools-switch').onchange = () => {
  state.current.tools = $('#tools-switch').checked;
  hooks.toolsChanged?.(); // this chip, the mode chip, the context meter
  if (state.current.messages.length) persist();
  renderToolsMenu();
  toast(state.current.tools ? 'Tools on for this chat' : 'Tools off for this chat');
};
$('#tools-settings').onclick = () => {
  openSheet('#tools-menu', false);
  openSettings('tools');
};

$('#ctx-btn').onclick = openContextSheet; // a Claude Code chat gets the same sheet with Claude Code's own numbers
async function updateFilesChip() {
  if (!state.current) return;
  const w = await loadWs(state.current.id);
  const n = Object.keys(w.files).length;
  const b = $('#files-btn');
  b.hidden = !n && !state.current.phoneFolder && !(enabledTools().phone && toolsOn());
  b.textContent = `📁 ${n}${state.current.phoneFolder ? ' 📱' : ''}`;
  b.title = `${n} file${n === 1 ? '' : 's'} in this chat`;
}
$('#files-btn').onclick = () => openFiles();

async function openFiles() {
  renderPhoneBox();
  $('#ws-search').value = '';
  await renderFiles();
  openSheet('#files-sheet', true);
}

// Folders you opened, per chat, so the sheet comes back the way you left it. A small workspace starts open;
// a big one starts with its folders closed, so the list is a handful of rows instead of a long scroll.
const openDirs = new Map();
async function renderFiles() {
  const id = state.current.id;
  const w = await loadWs(id);
  const all = wsList(w);
  const list = $('#ws-list');
  list.innerHTML = '';
  $('#ws-count').textContent = all.length ? `${all.length} files · ${fmtBytes(all.reduce((n, f) => n + f.size, 0))}` : 'No files yet. Attach files or a zip, or ask the assistant to create some.';
  $('.ws-tools').hidden = all.length < 6;
  if (!all.length) return;
  const sort = $('#ws-sort').value;
  const row = (f, label) => {
    const r = el('button', 'ws-row compact');
    if (IMG_EXT.test(f.path)) {
      const img = el('img', 'ws-thumb');
      img.loading = 'lazy';
      img.src = wsBlobUrl(w.id, f.path, w.files[f.path].data);
      r.append(img);
    } else r.append(el('span', 'file-icon', (f.path.split('.').pop() || 'file').slice(0, 4).toUpperCase()));
    const info = el('div', 'file-info');
    info.append(el('div', 'file-name', label), el('div', 'file-meta', [fmtBytes(f.size), ago(f.mtime)].filter(Boolean).join(' · ')));
    r.append(info);
    r.title = f.path;
    r.onclick = () => openWsFile(f.path);
    return r;
  };
  const q = $('#ws-search').value;
  if (q.trim()) {
    // a search shows the matches flat, with their folders, wherever they are
    const hits = filterFiles(all, q).map((f) => ({ ...f, name: f.path }));
    hits.sort(sorter(sort));
    if (!hits.length) list.append(el('p', 'hint', 'No file matches.'));
    hits.forEach((f) => list.append(row(f, f.path)));
    return;
  }
  const tree = buildTree(all, sort);
  let open = openDirs.get(id);
  if (!open) {
    open = new Set();
    if (all.length <= 12) {
      const walk = (d) => d.dirs.forEach((x) => (open.add(x.path), walk(x)));
      walk(tree);
    }
    openDirs.set(id, open);
  }
  const fill = (box, node) => {
    node.dirs.forEach((d) => box.append(dirNode(d)));
    node.files.forEach((f) => box.append(row(f, f.name)));
  };
  const dirNode = (d) => {
    const det = el('details', 'ws-dir');
    const sum = el('summary');
    sum.append(el('span', 'ws-dir-name', '📁 ' + d.name), el('span', 'ws-dir-meta', `${d.count} · ${fmtBytes(d.size)}${d.mtime ? ' · ' + ago(d.mtime) : ''}`));
    det.append(sum);
    const body = el('div', 'ws-dir-body');
    det.append(body);
    // the rows (and image thumbnails) of a folder are only made when it is opened
    const ensure = () => !body.childElementCount && fill(body, d);
    det.ontoggle = () => {
      if (det.open) {
        open.add(d.path);
        ensure();
      } else open.delete(d.path);
    };
    if (open.has(d.path)) {
      det.open = true;
      ensure();
    }
    return det;
  };
  fill(list, tree);
}
let searchTimer = null;
$('#ws-search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderFiles, 150);
};
$('#ws-sort').onchange = () => renderFiles();

// One compact row: the linked folder (or a Link button), its actions in the ⋯ menu below it.
function renderPhoneBox() {
  const f = state.current.phoneFolder;
  $('#phone-box').hidden = !canUsePhoneFolder() || !pref('toolPhone');
  $('#phone-name').textContent = f ? `📱 ${f.name} · linked` : '📱 No phone folder linked to this chat';
  const link = $('#phone-link');
  if (f) {
    link.className = 'menu-item';
    link.textContent = '📱 Change folder';
    $('#phone-menu').prepend(link);
  } else {
    link.className = 'ghost-btn small';
    link.textContent = 'Link a folder';
    $('#phone-more').before(link);
  }
  for (const id of ['phone-in', 'phone-out', 'phone-unlink']) $('#' + id).hidden = !f;
  phoneMenu(false);
}
function phoneMenu(open) {
  $('#phone-menu').hidden = !open;
  $('#phone-more').setAttribute('aria-expanded', String(open));
}
$('#phone-more').onclick = () => phoneMenu($('#phone-menu').hidden);
$('#phone-menu').addEventListener('click', (e) => e.target.closest('button') && phoneMenu(false)); // an action closes it
hooks.openMemory = (id) => openMemory(id);
hooks.filesChanged = () => {
  updateFilesChip();
  if ($('#files-sheet').classList.contains('open')) renderPhoneBox();
};
$('#phone-link').onclick = async () => {
  try {
    const f = await pickFolder();
    if (!f) return;
    state.current.phoneFolder = f;
    persist();
    renderPhoneBox();
    updateFilesChip();
    hooks.toolsChanged?.();
    toast(`Linked “${f.name}”`);
  } catch (e) {
    toast('Could not open the folder picker: ' + e.message);
  }
};
$('#phone-unlink').onclick = () => {
  delete state.current.phoneFolder;
  persist();
  renderPhoneBox();
  updateFilesChip();
  hooks.toolsChanged?.();
};
$('#phone-in').onclick = async () => {
  const f = state.current.phoneFolder;
  const btn = $('#phone-in');
  btn.disabled = true;
  try {
    const w = await loadWs(state.current.id);
    const files = (await listFolder(f, '', true, 1000)).filter((e) => !e.isDir);
    if (!files.length) return toast('That folder is empty');
    if (files.length > 300 && !confirm(`${files.length} files – copy only the first 300?`)) return;
    let n = 0;
    for (const e of files.slice(0, 300)) {
      btn.textContent = `📥 ${++n}/${Math.min(files.length, 300)}`;
      wsPut(w, e.path, await readPhoneFile(f, e.path));
    }
    saveWorkspace(w);
    toast(`Copied ${n} file${n === 1 ? '' : 's'} into this chat`);
    openFiles();
    updateFilesChip();
  } catch (e) {
    toast('Could not copy: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '📥 Bring files in';
  }
};
$('#phone-out').onclick = async () => {
  const f = state.current.phoneFolder;
  const btn = $('#phone-out');
  const w = await loadWs(state.current.id);
  const files = wsList(w);
  if (!files.length) return toast('No files in this chat yet');
  if (!confirm(`Save ${files.length} file${files.length === 1 ? '' : 's'} into “${f.name}”? Files with the same name there are replaced.`)) return;
  btn.disabled = true;
  try {
    let n = 0;
    for (const e of files) {
      btn.textContent = `📤 ${++n}/${files.length}`;
      await writePhoneFile(f, e.path, w.files[e.path].data);
    }
    toast(`Saved ${n} file${n === 1 ? '' : 's'} to “${f.name}”`);
  } catch (e) {
    toast('Could not save: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '📤 Save files to it';
  }
};

/** A text file in the viewer, highlighted as code when its name says which language (Settings › highlight). */
function showPreviewText(name, t, note = '') {
  const body = $('#preview-body');
  const cut = t.length > 60000;
  const text = cut ? t.slice(0, 60000) : t;
  const html = pref('highlight') !== false ? highlightFile(name, text) : '';
  body.classList.toggle('hljs', !!html);
  if (!html) return void (body.textContent = (note ? note + '\n\n' : '') + text + (cut ? '\n\n… (preview cut off)' : ''));
  body.innerHTML = html;
  if (note) body.prepend(el('div', 'preview-note', note));
  if (cut) body.append(el('div', 'preview-note', '… (preview cut off)'));
}

let viewing = null; // { name, bytes, path? (workspace path → deletable) }
const setViewing = (v) => (viewing = v);
async function openWsFile(path, convId = state.current.id) {
  path = cleanPath(path) || path; // tools report "/workspace/output/x.jpg"; the files are kept as "output/x.jpg"
  const w = await loadWs(convId);
  const f = w.files[path];
  if (!f) return toast('That file no longer exists');
  viewing = { name: path, bytes: f.data, path, convId };
  $('#preview-delete').hidden = false;
  $('#preview-title').textContent = path;
  const body = $('#preview-body');
  const img = $('#preview-img');
  img.hidden = true;
  body.hidden = false;
  if (IMG_EXT.test(path)) {
    img.src = wsBlobUrl(w.id, path, f.data);
    img.hidden = false;
    body.hidden = true;
  } else if (looksText(f.data)) showPreviewText(path, bytesToText(f.data));
  else body.textContent = `Binary file · ${fmtBytes(f.data.byteLength)}\nUse Share to open it in another app.`;
  $('#preview-actions').hidden = false;
  setPreviewButton(path);
  openSheet('#preview-sheet', true);
}

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Share a file that is produced in pieces (big backups): producer(sink) calls sink(bytes) for each piece. */
async function shareStream(name, producer) {
  const base = name.split('/').pop();
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const path = `share/${base}`;
    let first = true;
    const res = await producer(async (chunk) => {
      const data = bytesToBase64(chunk);
      if (first) await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
      else await Filesystem.appendFile({ path, data, directory: Directory.Cache });
      first = false;
    });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    await Share.share({ title: base, files: [uri] });
    return res;
  }
  const parts = [];
  const res = await producer((c) => void parts.push(c));
  const a = el('a');
  a.href = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }));
  a.download = base;
  document.body.append(a);
  a.click();
  a.remove();
  return res;
}

async function shareBytes(name, bytes) {
  const base = name.split('/').pop();
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const r = await Filesystem.writeFile({ path: `share/${base}`, data: bytesToBase64(bytes), directory: Directory.Cache, recursive: true });
    await Share.share({ title: base, files: [r.uri] });
  } else {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: mimeOf(base) }));
    a.download = base;
    document.body.append(a);
    a.click();
    a.remove();
  }
}

/**
 * Keep a file on the phone. how 'download': into Download/Chronicle; 'as': Android's "save to" screen. In a browser
 * (no app) both are a normal download.
 */
async function saveBytes(name, bytes, how = 'download') {
  const base = name.split('/').pop();
  if (!canUsePhoneFolder()) {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: mimeOf(base) }));
    a.download = base;
    document.body.append(a);
    a.click();
    a.remove();
    return toast(`Downloaded ${base}`);
  }
  if (how === 'as') {
    const r = await saveAsOnPhone(base, mimeOf(base), bytes);
    if (r?.saved) toast(`Saved ${r.name}`);
    return;
  }
  const r = await saveToDownloads(base, mimeOf(base), bytes);
  toast(`Saved to ${r.folder}/${r.name}`, 4000);
}
export { saveBytes };
for (const [id, how] of [['#preview-download', 'download'], ['#preview-saveas', 'as']]) {
  $(id).onclick = async () => {
    if (!viewing) return;
    try {
      await saveBytes(viewing.name, viewing.bytes, how);
    } catch (e) {
      toast(String(e.message || e), 5000);
    }
  };
}
$('#preview-share').onclick = async () => {
  if (!viewing) return;
  try {
    await shareBytes(viewing.name, viewing.bytes);
  } catch (e) {
    if (!/cancel/i.test(e.message || '')) toast('Could not share: ' + e.message);
  }
};
$('#preview-delete').onclick = async () => {
  if (!viewing?.path || !confirm(`Delete ${viewing.path}?`)) return;
  const w = await loadWs(viewing.convId || state.current.id);
  wsDelete(w, viewing.path);
  openSheet('#preview-sheet', false);
  updateFilesChip();
  if ($('#files-sheet').classList.contains('open')) openFiles();
  hooks.workspaceChanged?.();
};
$('#preview-copy').onclick = () => {
  if (!viewing) return;
  copyText(bytesToText(viewing.bytes)); // the whole file, not just the part shown (the view is cut at 60,000 characters)
  toast('Copied the whole file');
};
hooks.openWsFile = (p) => loadWs(state.current?.id).then((w) => w.files[p] && openWsFile(p)).catch(() => {});
function setPreviewButton(name) {
  $('#preview-copy').hidden = !viewing || IMG_EXT.test(name) || !looksText(viewing.bytes);
  // a file from Linux or the phone folder (Files): read-only, and it can be copied into this chat
  $('#preview-tochat').hidden = !viewing?.external;
  const kind = previewKind(name);
  const b = $('#preview-html');
  b.hidden = !kind || !!viewing?.external; // its preview would read this chat's files, not the ones beside it
  b.textContent = previewLabel(kind);
}
$('#preview-html').onclick = async () => {
  if (!viewing) return;
  const { name, bytes } = viewing;
  const kind = previewKind(name);
  try {
    const w = viewing.convId || state.current ? await loadWs(viewing.convId || state.current.id) : { id: '', files: {} };
    if (kind === 'py') toast('Running…', 60000);
    const doc = await buildPreview(name, bytes, {
      files: w.files,
      textOf: bytesToText,
      toDataUrl: (p, d) => `data:${mimeOf(p)};base64,${bytesToBase64(d)}`,
      markdown: (t) => renderMarkdown(t, false),
      runPython: (code) => sandbox.run(w, code, { timeoutMs: (pref('pyTimeout') || 120) * 1000 }).catch((e) => ({ error: e.message })),
    });
    $('#toast').classList.remove('show');
    openSheet('#preview-sheet', false);
    openHtmlPreview('html', doc);
    if (kind === 'py') updateFilesChip();
  } catch (e) {
    toast('Could not preview: ' + e.message);
  }
};

/** View an image you sent (data URL) with Share / Save. */
function openImageViewer(src, name = 'image.jpg') {
  const b64 = src.split(',')[1] || '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  viewing = { name, bytes };
  $('#preview-title').textContent = name;
  $('#preview-img').src = src;
  $('#preview-img').hidden = false;
  $('#preview-body').hidden = true;
  $('#preview-actions').hidden = false;
  $('#preview-delete').hidden = true;
  $('#preview-html').hidden = true;
  $('#preview-copy').hidden = true;
  $('#preview-tochat').hidden = true;
  openSheet('#preview-sheet', true);
}
$('#ws-share-all').onclick = async () => {
  const w = await loadWs(state.current.id);
  const files = wsList(w);
  if (!files.length) return;
  const { zipSync } = await import('fflate');
  const zip = zipSync(Object.fromEntries(files.map((f) => [f.path, w.files[f.path].data])));
  try {
    await shareBytes(`workspace-${(state.current.title || 'chat').replace(/[^\w]+/g, '_').slice(0, 30)}.zip`, zip);
  } catch (e) {
    if (!/cancel/i.test(e.message || '')) toast('Could not share: ' + e.message);
  }
};
$('#ws-clear').onclick = async () => {
  if (!confirm('Delete all files in this chat’s workspace?')) return;
  await deleteWorkspace(state.current.id);
  wsMem.delete(state.current.id);
  openSheet('#files-sheet', false);
  updateFilesChip();
};

// ---------- memory sheet ----------
/**
 * Claude Code's models as a group of their own in a background-job list (decision 169) – learning, helper, advisor,
 * not the fallback (that one answers a chat with its tools). A choice that is not offered right now (Claude Code not
 * set up here) is kept, marked, instead of being quietly dropped on save.
 */
function addCcOptions(sel, value) {
  const list = hooks.ccJobModels?.() || [];
  const keep = isCcModel(value) && !list.some(([v]) => v === value) ? [[value, `Claude Code · ${value.slice(CC_MODEL.length)} (not available now)`]] : [];
  if (!list.length && !keep.length) return;
  const g = document.createElement('optgroup');
  g.label = 'Claude Code (your subscription) – slower, uses your plan';
  for (const [v, label] of [...list, ...keep]) {
    const o = el('option', null, label);
    o.value = v;
    g.append(o);
  }
  sel.append(g);
}
function fillFallbackSelect() {
  const sel = $('#pref-fallback');
  sel.innerHTML = '';
  const opts = [['', 'Nothing – show the error and let me retry'], ...state.models.map((m) => [m.id, m.name])];
  for (const [v, label] of opts) {
    const o = el('option', null, label);
    o.value = v;
    sel.append(o);
  }
  sel.value = pref('fallbackModel') || '';
  const hs = $('#pref-helper');
  hs.innerHTML = '';
  for (const [v, label] of [['auto', 'Auto – fast & cheap'], ['chat', 'Same model as the chat'], ...state.models.map((m) => [m.id, m.name])]) {
    const o = el('option', null, label);
    o.value = v;
    hs.append(o);
  }
  addCcOptions(hs, pref('helperModel'));
  hs.value = pref('helperModel') || 'auto';
  const av = $('#pref-advisor');
  av.innerHTML = '';
  const adv = pref('advisorModel') || '';
  // a chosen model that is not in the list right now is kept (shown as unavailable), not quietly dropped on save
  for (const [v, label] of [['', 'None – no advisor tool'], ...state.models.map((m) => [m.id, m.name]), ...(adv && !isCcModel(adv) && !state.models.some((m) => m.id === adv) ? [[adv, `${adv} (not available now)`]] : [])]) {
    const o = el('option', null, label);
    o.value = v;
    av.append(o);
  }
  addCcOptions(av, adv);
  av.value = adv;
  $('#pref-delegate').checked = pref('toolDelegate');
  $('#pref-claudecode').checked = !!pref('toolClaudeCode');
  $('#pref-lazy-tools').checked = pref('lazyTools') !== false;
  $('#pref-wrapup').checked = pref('wrapUp') !== false;
  $('#pref-lean-tools').value = ['on', 'off'].includes(pref('leanTools')) ? pref('leanTools') : 'auto';
  $('#pref-cache-hour').checked = pref('cacheHour') === true;
  $('#pref-create').checked = pref('toolCreate');
  $('#pref-local').checked = pref('localModel');
  $('#local-sum').textContent = pref('localModel') ? 'On – appears in the model picker as OFFLINE' : 'Off – experimental: a small model that works offline (~400 MB download)';
  $('#pref-browser').checked = pref('toolBrowser');
  $('#pref-shell').checked = pref('toolShell');
  $('#pref-preview').checked = pref('toolPreview');
}
$('#pref-local').onchange = async (e) => {
  const note = $('#local-status');
  if (!e.target.checked) return (note.textContent = '');
  note.textContent = 'Downloading the on-device model (~400 MB, once)… 0%';
  try {
    await preloadLocal((p) => (note.textContent = `Downloading the on-device model (~400 MB, once)… ${p}%`));
    note.textContent = 'Ready. Save settings, then pick “On-device Qwen2.5 0.5B” in the model list.';
  } catch (err) {
    note.textContent = 'Download failed: ' + err.message;
    e.target.checked = false;
  }
};
function fillLearnModelSelect() {
  fillFallbackSelect();
  const sel = $('#pref-learn-model');
  sel.innerHTML = '';
  const auto = pickLearnModel(state.models, 'auto', state.settings.model);
  const opts = [['auto', `Auto – fast & cheap (${state.models.find((m) => m.id === auto)?.name || auto || '…'})`], ['chat', 'Same model as the chat'], ...state.models.map((m) => [m.id, m.name])];
  for (const [v, label] of opts) {
    const o = el('option', null, label);
    o.value = v;
    sel.append(o);
  }
  addCcOptions(sel, pref('learnModel'));
  sel.value = pref('learnModel');
}

let memFilter = 'all';
function scopeLabel(scope) {
  if ((scope || GLOBAL) === GLOBAL) return '🌐 Global';
  const p = personaById(scope);
  return p ? `${p.avatar?.image ? '' : (p.avatar?.emoji || '') + ' '}${p.name}` : 'Deleted persona';
}
function fillScopeSelect(sel, value, withAll) {
  sel.innerHTML = '';
  const opts = [...(withAll ? [['all', 'All memories']] : []), [GLOBAL, '🌐 Global – shared by all personas'], ...personas().map((p) => [p.id, scopeLabel(p.id)])];
  for (const [v, label] of opts) {
    const o = el('option', null, label);
    o.value = v;
    sel.append(o);
  }
  sel.value = value;
}

function openMemory(scope) {
  $('#mem-use').checked = pref('useMemory');
  $('#mem-learn').checked = pref('learn');
  $('#mem-limit').value = String(pref('memLimit'));
  $('#mem-smart').checked = pref('smartMemory');
  renderTidyUndo();
  memFilter = typeof scope === 'string' ? scope : 'all';
  fillScopeSelect($('#mem-filter'), memFilter, true);
  fillScopeSelect($('#mem-new-scope'), memFilter === 'all' ? GLOBAL : memFilter, false);
  renderMemoryList();
  openDrawer(false);
  openSheet('#settings-sheet', false);
  openSheet('#memory-sheet', true);
}
$('#mem-filter').onchange = (e) => {
  memFilter = e.target.value;
  $('#mem-new-scope').value = memFilter === 'all' ? GLOBAL : memFilter;
  renderMemoryList();
};

function setPref(k, v) {
  state.settings.prefs = { ...state.settings.prefs, [k]: v };
  saveSettings(state.settings);
}

function renderMemoryList() {
  const list = $('#mem-list');
  list.innerHTML = '';
  const all = state.settings.memories;
  const mems = memFilter === 'all' ? all : all.filter((m) => (m.scope || GLOBAL) === memFilter);
  const perMsg = memFilter === 'all' || memFilter === GLOBAL ? '' : ` · ${personaById(memFilter)?.name} sees ~${Math.ceil(memoryBlock(all, memFilter, null, { limit: pref('memLimit') }).length / 4)} tokens per message`;
  $('#mem-count').textContent = mems.length ? `${mems.length} memor${mems.length === 1 ? 'y' : 'ies'}${perMsg}` : '';
  if (!mems.length) {
    list.append(el('p', 'hint pad', memFilter === GLOBAL ? 'No global memories yet. Add facts every persona should know, like your name or how you like answers.' : 'Nothing yet. Chat normally and each persona will remember things like your name, work, projects and preferences – or add one below.'));
    return;
  }
  [...mems].reverse().forEach((m) => {
    const row = el('div', 'mem-item');
    const text = el('div', 'mem-text', m.text);
    const meta = el('div', 'mem-meta', `${scopeLabel(m.scope)} · ${m.kind === 'event' ? `🗓 notes from “${m.title || 'a chat'}”` : m.conv ? `🎭 only in “${state.convs.find((c) => c.id === m.conv)?.title || 'that roleplay'}”` : m.source === 'manual' ? 'added by you' : 'learned'} · ${new Date(m.updatedAt || m.createdAt).toLocaleDateString()}`);
    const body = el('div', 'mem-body');
    body.append(text, meta);
    if (isStale(m)) {
      // not confirmed for half a year: ask whether it still holds
      const st = el('div', 'mem-stale');
      st.append(el('span', null, '⏳ Old – is this still true? '));
      const yes = el('button', 'link-btn', 'Still true');
      yes.onclick = () => {
        m.updatedAt = Date.now();
        saveSettings(state.settings);
        renderMemoryList();
      };
      st.append(yes);
      body.append(st);
    }
    const edit = el('button', 'mem-btn', '✎');
    edit.setAttribute('aria-label', 'Edit memory');
    edit.onclick = () => {
      const ta = el('textarea', 'field');
      ta.value = m.text;
      ta.rows = 2;
      const sc = el('select', 'field');
      fillScopeSelect(sc, m.scope || GLOBAL, false);
      const save = el('button', 'primary-btn small', 'Save');
      save.onclick = () => {
        const v = ta.value.trim();
        if (v) {
          if (v.slice(0, 300) !== m.text) delete m.vec;
          m.text = v.slice(0, 300);
          m.scope = sc.value;
          m.updatedAt = Date.now();
        } else state.settings.memories = state.settings.memories.filter((x) => x !== m);
        saveSettings(state.settings);
        renderMemoryList();
      };
      body.replaceChildren(ta, sc, save);
      ta.focus();
    };
    const del = el('button', 'mem-btn', '×');
    del.setAttribute('aria-label', 'Delete memory');
    del.onclick = () => {
      state.settings.memories = state.settings.memories.filter((x) => x !== m);
      saveSettings(state.settings);
      renderMemoryList();
    };
    const pin = el('button', 'mem-btn' + (m.pinned ? ' on' : ''), '📌');
    pin.setAttribute('aria-label', m.pinned ? 'Unpin memory' : 'Always send this memory');
    pin.title = m.pinned ? 'Always sent' : 'Pin: always send this one';
    pin.style.opacity = m.pinned ? '1' : '0.35';
    pin.onclick = () => {
      m.pinned = !m.pinned;
      saveSettings(state.settings);
      renderMemoryList();
    };
    row.append(body, ...(m.kind === 'event' ? [] : [pin]), edit, del);
    list.append(row);
  });
}

$('#open-memory').onclick = openMemory;
$('#settings-memory').onclick = openMemory;
$('#mem-use').onchange = (e) => {
  setPref('useMemory', e.target.checked);
  updateHeader();
};
$('#mem-learn').onchange = (e) => setPref('learn', e.target.checked);
$('#mem-smart').onchange = async (e) => {
  const st = $('#mem-smart-status');
  if (!e.target.checked) {
    setPref('smartMemory', false);
    st.hidden = true;
    return;
  }
  if (!hasTestEmbedder() && !confirm('Smart memory downloads a ~200 MB language model once (use Wi‑Fi). It then runs on your phone and works offline. Continue?')) {
    e.target.checked = false;
    return;
  }
  st.hidden = false;
  st.textContent = 'Downloading the model…';
  e.target.disabled = true;
  try {
    const embed = await loadEmbedder((pct) => (st.textContent = `Downloading the model… ${pct}%`));
    st.textContent = 'Learning your existing memories…';
    if (await ensureVectors(state.settings.memories, embed)) saveSettings(state.settings);
    setPref('smartMemory', true);
    st.textContent = 'Ready – memories are now picked by meaning.';
  } catch (err) {
    e.target.checked = false;
    setPref('smartMemory', false);
    st.textContent = 'Could not set it up: ' + (err.message || err) + ' (you can keep using word matching).';
  } finally {
    e.target.disabled = false;
  }
};
$('#mem-limit').onchange = (e) => {
  setPref('memLimit', Number(e.target.value) || 0);
  renderMemoryList();
};
$('#mem-add').onclick = () => {
  const v = $('#mem-new').value.trim();
  if (!v) return;
  state.settings.memories.push(newMemory(v, $('#mem-new-scope').value || GLOBAL));
  saveSettings(state.settings);
  $('#mem-new').value = '';
  renderMemoryList();
};
$('#mem-new').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), $('#mem-add').click()));
// ✂ rewrite the long memories shown (facts over ~120 characters, notes over ~450) as short ones
$('#mem-shorten').onclick = async () => {
  const status = $('#mem-shorten-status');
  const shown = state.settings.memories.filter((m) => memFilter === 'all' || (m.scope || GLOBAL) === memFilter);
  const long = shown.filter((m) => m.text.length > (m.kind === 'event' ? 450 : 120));
  if (!long.length) return (status.textContent = 'Nothing long to shorten.');
  if (!state.settings.apiKey && !currentModel()) return (status.textContent = 'Set your API key first.');
  $('#mem-shorten').disabled = true;
  const model = pickLearnModel(state.models, pref('learnModel'), state.settings.model);
  const before = long.reduce((n, m) => n + m.text.length, 0);
  let done = 0;
  try {
    for (let i = 0; i < long.length; i += 12) {
      const batch = long.slice(i, i + 12);
      status.textContent = `Shortening ${Math.min(i + 12, long.length)} / ${long.length}…`;
      const res = await shortenMemories(state.settings, { model, items: batch.map((m) => ({ id: m.id, text: m.text, notes: m.kind === 'event' })), sessionId: 'shorten-' + Date.now() });
      for (const r of res) {
        const m = batch.find((x) => x.id === r.id);
        if (!m) continue;
        const t = r.text.trim();
        if (!t) state.settings.memories = state.settings.memories.filter((x) => x !== m);
        else m.text = m.kind === 'event' ? t.split('\n').slice(0, 5).map((l) => '- ' + clip(l.replace(/^[-•\s]+/, ''), 130)).join('\n') : clip(t, 160);
        m.updatedAt = Date.now();
        done++;
      }
    }
    saveSettings(state.settings);
    const after = long.reduce((n, m) => n + (state.settings.memories.includes(m) ? m.text.length : 0), 0);
    status.textContent = `Shortened ${done}: ~${Math.round(before / 4)} → ~${Math.round(after / 4)} tokens.`;
  } catch (e) {
    status.textContent = 'Could not shorten: ' + e.message;
  }
  $('#mem-shorten').disabled = false;
  renderMemoryList();
};
// 🧹 propose merges / removals for one persona's (or the global) facts, review them, apply, and keep one undo
function renderTidyUndo() {
  $('#mem-tidy-undo').hidden = !state.settings.tidyUndo;
}
$('#mem-tidy').onclick = async () => {
  const status = $('#mem-shorten-status');
  if (memFilter === 'all') return (status.textContent = 'Pick one persona (or Global) in “Show” first.');
  const facts = state.settings.memories.filter((m) => m.kind !== 'event' && !m.pinned && (m.scope || GLOBAL) === memFilter);
  if (facts.length < 3) return (status.textContent = 'Too few memories to tidy.');
  if (!state.settings.apiKey && !currentModel()) return (status.textContent = 'Set your API key first.');
  $('#mem-tidy').disabled = true;
  status.textContent = 'Looking through them…';
  const model = pickLearnModel(state.models, pref('learnModel'), state.settings.model);
  try {
    const plan = { merge: [], remove: [] };
    for (let i = 0; i < facts.length; i += 60) {
      const part = await tidyMemories(state.settings, { model, items: facts.slice(i, i + 60).map((m) => ({ id: m.id, text: m.text })), sessionId: 'tidy-' + Date.now() });
      plan.merge.push(...part.merge);
      plan.remove.push(...part.remove);
    }
    if (!plan.merge.length && !plan.remove.length) return (status.textContent = 'Nothing to tidy – they look fine.');
    status.textContent = '';
    openTidyReview(plan);
  } catch (e) {
    status.textContent = 'Could not tidy: ' + e.message;
  } finally {
    $('#mem-tidy').disabled = false;
  }
};
function openTidyReview(plan) {
  const byId = new Map(state.settings.memories.map((m) => [m.id, m]));
  const list = $('#tidy-list');
  list.innerHTML = '';
  $('#tidy-intro').textContent = `${plan.merge.length} merge${plan.merge.length === 1 ? '' : 's'} and ${plan.remove.length} removal${plan.remove.length === 1 ? '' : 's'} proposed. Untick anything you want to keep as it is.`;
  const rows = [];
  const add = (kind, item, newText, oldTexts) => {
    const row = el('label', 'tidy-item');
    const c = el('input');
    c.type = 'checkbox';
    c.checked = true;
    const body = el('div');
    body.append(el('div', 'tidy-kind', kind));
    if (newText) body.append(el('div', 'tidy-new', newText));
    for (const t of oldTexts) body.append(el('div', 'tidy-old', t));
    row.append(c, body);
    list.append(row);
    rows.push({ c, item });
  };
  for (const g of plan.merge) add('Merge', { merge: g }, g.text, g.ids.map((id) => byId.get(id)?.text || ''));
  for (const r of plan.remove) add(`Remove${r.why ? ' – ' + r.why : ''}`, { remove: r }, '', [byId.get(r.id)?.text || '']);
  $('#tidy-apply').onclick = () => {
    const chosen = { merge: rows.filter((r) => r.c.checked && r.item.merge).map((r) => r.item.merge), remove: rows.filter((r) => r.c.checked && r.item.remove).map((r) => r.item.remove) };
    const { memories, undo } = applyTidy(state.settings.memories, chosen);
    if (undo.removed.length || undo.updated.length) {
      state.settings.memories = memories;
      state.settings.tidyUndo = { at: Date.now(), ...undo };
      saveSettings(state.settings);
      toast(`Tidied: ${chosen.merge.length} merged, ${chosen.remove.length} removed`);
    }
    openSheet('#tidy-sheet', false);
    renderTidyUndo();
    renderMemoryList();
  };
  openSheet('#tidy-sheet', true);
}
$('#mem-tidy-undo').onclick = () => {
  const u = state.settings.tidyUndo;
  if (!u) return;
  state.settings.memories = undoTidy(state.settings.memories, u);
  delete state.settings.tidyUndo;
  saveSettings(state.settings);
  renderTidyUndo();
  renderMemoryList();
  toast('Restored the memories as they were');
};
$('#mem-clear').onclick = () => {
  const scoped = memFilter !== 'all';
  const n = scoped ? state.settings.memories.filter((m) => (m.scope || GLOBAL) === memFilter).length : state.settings.memories.length;
  if (!n || !confirm(scoped ? `Delete all ${n} memories of ${scopeLabel(memFilter)}?` : 'Forget everything? All memories of all personas will be deleted.')) return;
  state.settings.memories = scoped ? state.settings.memories.filter((m) => (m.scope || GLOBAL) !== memFilter) : [];
  saveSettings(state.settings);
  renderMemoryList();
};

// ---------- launcher shortcuts, home-screen pins & deep links ----------
const Shortcuts = Capacitor.isNativePlatform() ? registerPlugin('Shortcuts') : null;

/** Persona avatar → 192px PNG (base64) for launcher icons. */
async function avatarPng(p) {
  const c = el('canvas');
  c.width = c.height = 192;
  const g = c.getContext('2d');
  if (p.avatar?.image) {
    const img = new Image();
    img.src = p.avatar.image;
    await img.decode().catch(() => {});
    g.drawImage(img, 0, 0, 192, 192);
  } else {
    g.fillStyle = p.avatar?.bg || '#64748b';
    g.fillRect(0, 0, 192, 192);
    g.font = '96px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(p.avatar?.emoji || '🤖', 96, 104);
  }
  return c.toDataURL('image/png').split(',')[1];
}
const shortcutFor = async (p) => ({ id: 'persona_' + p.id, label: p.name.slice(0, 20), longLabel: `New chat with ${p.name}`.slice(0, 40), uri: `chronicle://new?persona=${encodeURIComponent(p.id)}`, icon: await avatarPng(p) });

let shortcutsTimer = null;
function updateShortcuts() {
  if (!Shortcuts) return;
  clearTimeout(shortcutsTimer);
  shortcutsTimer = setTimeout(async () => {
    // most recently used personas first, then the default one
    const recent = [];
    for (const c of state.convs) {
      const p = !isGroup(c) && personaById(c.personaId);
      if (p && !recent.includes(p)) recent.push(p);
    }
    if (!recent.includes(defaultPersona())) recent.unshift(defaultPersona());
    const items = [{ id: 'new_chat', label: 'New chat', longLabel: 'New chat', uri: 'chronicle://new?focus=1' }];
    for (const p of recent.slice(0, 3)) items.push(await shortcutFor(p));
    Shortcuts.set({ items }).catch(() => {});
  }, 1500);
}

$('#pe-pin').onclick = async () => {
  const p = personaById(draft.id);
  if (!p) return toast('Save the persona first');
  if (!Shortcuts) return toast('Home-screen shortcuts work in the Android app');
  try {
    await Shortcuts.pin(await shortcutFor(p));
    toast('Confirm on your home screen');
  } catch (e) {
    toast(e.message || 'Could not add the shortcut');
  }
};

globalThis.__ocmDeepLink = (url) => handleDeepLink(url); // tests (and the self-test) open links this way
function handleDeepLink(url) {
  if (handleRedirect(url)) return; // an MCP sign-in coming back
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol !== 'chronicle:') return;
  const what = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (what === 'run') return void hooks.automationRun?.(u); // automation (Tasker…), checked against its token
  if (what === 'open') {
    const id = u.searchParams.get('conv');
    const c = id && state.convs?.find?.((x) => x.id === id);
    if (c && c.id !== state.current?.id) {
      document.querySelectorAll('.sheet.open').forEach((x) => openSheet('#' + x.id, false));
      openDrawer(false);
      selectConv(c.id);
    }
    KeepAlive?.clear({ id: id || undefined }).catch(() => {});
    return;
  }
  if (what !== 'new') return;
  document.querySelectorAll('.sheet.open').forEach((x) => openSheet('#' + x.id, false));
  openDrawer(false);
  newChat({ focus: true });
  const pid = u.searchParams.get('persona');
  if (pid && personaById(pid)) setChatPersona(pid);
  if (u.searchParams.get('voice') === '1' && !$('#mic-btn').hidden) setTimeout(() => $('#mic-btn').click(), 500);
  else setTimeout(() => $('#input').focus(), 300);
}

// ---------- Android back button ----------
if (Capacitor.isNativePlatform()) {
  import('@capacitor/app').then(({ App }) => {
    App.addListener('backButton', async () => {
      // the assistant's browser is on screen (watching it, or a handoff): back closes that screen, nothing else
      try {
        if ((await hideBrowserView())?.hidden) return;
      } catch {
        /* no browser */
      }
      if (closeInfo()) return; // an ⓘ bubble
      if (closeArt()) return;
      if (!$('#find-bar').hidden) return closeFind();
      const sheet = anySheetOpen();
      if (sheet?.id === 'settings-sheet' && setPage) return showSettingsPage(null);
      if (sheet) return openSheet('#' + sheet.id, false);
      if (document.body.classList.contains('drawer-open')) return openDrawer(false);
      if (state.stream) return stopStream();
      App.minimizeApp();
    });
    App.addListener('appUrlOpen', (e) => handleDeepLink(e.url));
    App.getLaunchUrl?.().then((r) => r?.url && setTimeout(() => handleDeepLink(r.url), 400)).catch(() => {});
  });
} else if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------- app updates (GitHub "latest" release, built by CI) ----------
const RELEASE_API = 'https://api.github.com/repos/amon28/chronicle-harness/releases/tags/latest';
const APK_URL = 'https://github.com/amon28/chronicle-harness/releases/download/latest/chronicle.apk';
let buildP = null;
function appBuild() {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(0);
  buildP ||= import('@capacitor/app').then(({ App }) => App.getInfo()).then((i) => Number(i.build) || 0).catch(() => 0);
  return buildP;
}
async function latestRelease() {
  const token = (state.settings.ghToken || '').trim();
  const r = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (r.status === 404 || r.status === 401) throw new Error(token ? 'GitHub refused the token (it needs read access to the repo’s contents)' : 'the repository is private – add a GitHub token below, or make the repo public');
  if (r.status === 403 || r.status === 429) throw new Error('GitHub is rate-limiting update checks – try again later' + (token ? '' : ' (a token avoids this)'));
  if (!r.ok) throw new Error(`GitHub said ${r.status}`);
  const j = await r.json();
  const build = Number(String(j.body || '').match(/Build #(\d+)/)?.[1]) || 0;
  const notes = String(j.body || '').match(/Changes:\s*\n([\s\S]*?)(?:\n\s*\n|$)/)?.[1]?.trim() || '';
  const apk = j.assets?.find((a) => a.name.endsWith('.apk'));
  // the release page works when signed in to GitHub in the browser (direct APK links need auth for private repos)
  return { build, notes, url: j.html_url || 'https://github.com/amon28/chronicle-harness/releases/tag/latest', apk: apk?.browser_download_url || APK_URL, apkApi: apk?.url || '', size: apk?.size, at: j.published_at || j.created_at };
}
async function openExternal(url) {
  try {
    const { InAppBrowser } = await import('@capacitor/inappbrowser');
    await InAppBrowser.openInExternalBrowser({ url });
  } catch {
    window.open(url, '_blank');
  }
}
async function checkForUpdate({ manual = false } = {}) {
  const status = $('#update-status');
  const mine = await appBuild();
  if (!manual && (!mine || !pref('updateCheck') || !state.settings.ghToken)) return;
  const last = cache('updateCheckedAt') || 0;
  if (!manual && Date.now() - last < 30 * 60e3) return; // at most every 30 minutes (on start and when the app comes back)
  if (manual) status.textContent = 'Checking…';
  try {
    const rel = await latestRelease();
    cache('updateCheckedAt', Date.now());
    if (!mine) {
      status.textContent = `Latest Android build is #${rel.build}. (This is the web version.)`;
      return;
    }
    if (rel.build > mine) {
      const msg = `Update available: build #${rel.build} (you have #${mine})${rel.notes ? ` – ${rel.notes.split('\n')[0].slice(0, 90)}` : ''}`;
      if (manual) status.textContent = msg;
      if (manual || cache('updateDismissed') !== rel.build) showUpdateBanner(rel, msg);
    } else if (manual) status.textContent = `You're up to date (build #${mine}).`;
  } catch (e) {
    if (manual) status.textContent = 'Could not check: ' + e.message;
  }
}
function showUpdateBanner(rel, msg) {
  document.querySelector('.update-banner')?.remove();
  const bar = el('div', 'update-banner');
  const txt = el('span', null, msg);
  const go = el('button', 'primary-btn small', 'Update');
  go.onclick = async () => {
    if (!Capacitor.isNativePlatform()) return openExternal(rel.url);
    const token = (state.settings.ghToken || '').trim();
    const Updater = registerPlugin('Updater');
    go.disabled = true;
    txt.textContent = 'Downloading…';
    const sub = await Updater.addListener('progress', (p) => (txt.textContent = p.percent >= 0 ? `Downloading… ${p.percent}%` : 'Downloading…'));
    try {
      const r = await Updater.install({ url: token && rel.apkApi ? rel.apkApi : rel.apk, token });
      if (r?.needsPermission) {
        txt.textContent = msg;
        toast('Allow “Install unknown apps” for this app, come back and tap Update again', 7000);
      } else {
        bar.remove();
        toast('Tap Install on the Android screen', 5000);
      }
    } catch (e) {
      txt.textContent = msg;
      toast(`${e.message || e} – opening the release page instead`, 6000);
      openExternal(rel.url);
    } finally {
      sub.remove();
      go.disabled = false;
    }
  };
  const later = el('button', 'ghost-btn small', 'Later');
  later.onclick = () => {
    cache('updateDismissed', rel.build);
    bar.remove();
  };
  bar.append(txt, go, later);
  document.body.append(bar);
}
// 🩺 timings report after a send (Settings › Data)
onPerfReport((text) => {
  document.querySelector('.perf-report')?.remove();
  const box = el('div', 'perf-report');
  box.append(el('pre', null, text));
  const row = el('div', 'row gap-sm');
  const copy = el('button', 'ghost-btn small', 'Copy');
  copy.onclick = () => copyText(text);
  const close = el('button', 'ghost-btn small', 'Close');
  close.onclick = () => box.remove();
  row.append(copy, close);
  box.append(row);
  document.body.append(box);
});
$('#update-check').onclick = () => checkForUpdate({ manual: true });
setTimeout(() => checkForUpdate(), 4000);
document.addEventListener('visibilitychange', () => !document.hidden && checkForUpdate()); // a build finished while the app was in the background
setTimeout(() => pref('smartMemory') && loadEmbedder().catch(() => {}), 6000);

export { setPreviewButton, showPreviewText, appBuild, fillLearnModelSelect, loadWs, openFiles, openImageViewer, openMemory, openWsFile, setPref, setViewing, shareBytes, shareStream, updateFilesChip, updateShortcuts, updateToolsChip, viewing, wsCacheSync, wsMem };
