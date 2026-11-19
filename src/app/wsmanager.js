// 📁 Files: a phone-style file manager with three places, switched at the top –
//   💬 Chats' workspaces – every chat's workspace (the files you attached and the agents created). The chat list comes
//      from a small index (count, size, newest change per chat), not from reading every workspace with all its bytes;
//      only the chat you open is loaded. Rows are drawn a page at a time, thumbnails when they scroll in.
//   🐧 Linux files – the Linux shell's own disk outside /workspace, read-only (src/linuxfiles.js).
//   📱 the phone folder linked to the current chat, read-only here.
// A path bar (tap a part to go there, ‹ goes up), a slim storage line, grid or list view (remembered), search and
// sort, and a long press (or Select) to pick several.
import { fmtBytes } from '../files.js';
import { cleanPath, getWorkspace, looksText, bytesToText, saveWorkspace, wsDelete, wsListing, wsPut, workspaceListing, workspaceSummaries } from '../sandbox.js';
import { canExportLinux, canUsePhoneFolder, exportLinuxFile, listFolder, readPhoneFile, writePhoneFile } from '../phonefolder.js';
import { KEY_NAME, LIST_CAP, VIEW_MAX, COPY_MAX_BYTES, COPY_MAX_FILES, errorText, folderSizes, isHidden, linuxReady, listDir, normPath, parentOf, planFolderCopy, planPickedCopy, readLinuxFile, statPath } from '../linuxfiles.js';
import { openDrawer, openSheet, selectConv } from './chatlist.js';
import { $, el, hooks, state, toast } from './core.js';
import { IMG_EXT, mimeOf, wsBlobUrl } from './render.js';
import { loadWs, openWsFile, saveBytes, setPreviewButton, setViewing, shareBytes, showPreviewText, updateFilesChip, viewing } from './extras.js';
import { askText, chooseOne } from './choose.js';

let loc = 'ws'; // 'ws' | 'linux' | 'phone'
let scope = null; // workspaces: null = all chats; else { id, dir }
let lpath = '/root'; // Linux: the folder shown
let lres = null; // Linux: the listing of lpath ({ real, all, total } or { error })
let lsizes = {}; // Linux: du sizes of the folders in lpath (name -> bytes)
let lsized = false; // …and whether that count is done
const SIZE_CAP = 300; // folders sized in one go
let pdir = ''; // phone folder: the folder shown
let pfiles = null; // phone folder: every file in it (one listing per visit)
let selecting = false;
const picked = new Set(); // paths (or "dir/" prefixes) in the current place
let query = '';
let sort = 'new';
const PAGE = 60; // rows drawn at a time; "Show more" adds the next ones
let shown = PAGE;
let showHidden = false;
const hiddenName = (n) => n.startsWith('.'); // .out/, .toolkit, .toolkit-url…: the app's and the tools' own files
const VIEW_KEY = 'ocm.wsmView';
let view = (() => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
})();

const titleOf = (id) => state.convs.find((c) => c.id === id)?.title || (state.current?.id === id ? state.current.title : '') || '(untitled chat)';
const extOf = (p) => (p.includes('.') ? p.split('.').pop().toLowerCase().slice(0, 4) : 'file');
const baseName = (p) => String(p).split('/').filter(Boolean).pop() || '/';
const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(t).toLocaleDateString();
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const phoneOf = () => (canUsePhoneFolder() ? state.current?.phoneFolder || null : null);

const sorter = (a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'size' ? b.size - a.size : sort === 'count' ? (b.count || 0) - (a.count || 0) || b.size - a.size : b.mtime - a.mtime);

function entriesIn(files, dir) {
  const pre = dir ? dir + '/' : '';
  const dirs = new Map();
  const list = [];
  for (const f of files) {
    if (!f.path.startsWith(pre)) continue;
    const rest = f.path.slice(pre.length);
    const slash = rest.indexOf('/');
    if (slash < 0) list.push({ ...f, name: rest, isDir: false, count: 1 });
    else {
      const name = rest.slice(0, slash);
      const d = dirs.get(name) || { name, path: pre + name, isDir: true, size: 0, mtime: 0, count: 0 };
      d.size += f.size;
      d.count++;
      d.mtime = Math.max(d.mtime, f.mtime);
      dirs.set(name, d);
    }
  }
  return [...[...dirs.values()].sort(sorter), ...list.sort(sorter)];
}

const underPicked = (path) => [...picked].some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

/** One item: a row in the list view, a tile in the grid view. A long press starts selecting with it. */
function row({ icon, thumb, title, sub, onOpen, check, dim, big, onLong }) {
  const r = el('div', 'wsm-row' + (dim ? ' dim' : '') + (check?.on ? ' picked' : ''));
  if (check) {
    const c = el('input');
    c.type = 'checkbox';
    c.checked = check.on;
    c.setAttribute('aria-label', 'Select ' + title);
    c.onclick = (e) => e.stopPropagation();
    c.onchange = () => check.set(c.checked);
    r.append(c);
  }
  const b = el('button', 'wsm-open');
  b.title = title;
  b.append(thumb || el('span', 'wsm-icon' + (big ? ' big' : ''), icon || '📄'), (() => {
    const t = el('div', 'wsm-text');
    t.append(el('div', 'wsm-title', title), el('div', 'wsm-sub', sub));
    return t;
  })());
  let longAt = 0;
  let timer = null;
  const long = (e) => {
    if (!onLong || Date.now() - longAt < 800) return;
    e?.preventDefault?.();
    longAt = Date.now();
    onLong();
  };
  b.oncontextmenu = (e) => {
    e.preventDefault();
    long(e);
  };
  b.onpointerdown = (e) => {
    if (e.pointerType === 'mouse') return;
    clearTimeout(timer);
    timer = setTimeout(() => long(), 550);
  };
  b.onpointerup = b.onpointercancel = b.onpointerleave = () => clearTimeout(timer);
  b.onclick = (e) => {
    if (Date.now() - longAt < 800) return e.preventDefault(); // the click that ends a long press
    onOpen();
  };
  r.append(b);
  return r;
}

/** Today / Yesterday / This week / This month / October 2026 … for a time. */
export function periodOf(t, now = new Date()) {
  if (!t) return 'Older';
  const d = new Date(t);
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= day0) return 'Today';
  if (t >= day0 - 86400000) return 'Yesterday';
  if (t >= day0 - 6 * 86400000) return 'This week';
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'This month';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** items → rows in the list, with a header between periods when asked, and "Show more" at the end. */
function fill(list, items, draw, { periods = false } = {}) {
  let last = null;
  let into = list;
  for (const it of items.slice(0, shown)) {
    if (periods) {
      const p = it.orphan ? 'From deleted chats' : periodOf(it.mtime);
      if (p !== last) {
        // each period is its own block, so its header stays on top only while its items are in view and the next
        // header pushes it away (headers in one shared box would slide over each other)
        const sec = el('div', 'wsm-sec');
        into = el('div', 'wsm-sec-body');
        sec.append(el('div', 'wsm-group', p), into);
        list.append(sec);
      }
      last = p;
    }
    into.append(draw(it));
  }
  if (items.length > shown) {
    const more = el('button', 'wsm-more', `Show ${Math.min(PAGE, items.length - shown)} more (${items.length - shown} left)`);
    more.onclick = () => {
      shown += PAGE;
      render();
    };
    list.append(more);
  }
}

/** The path bar: a part per level, each one tappable. parts: [{ label, go }] */
function crumbs(parts) {
  const box = $('#wsm-crumbs');
  box.innerHTML = '';
  parts.forEach((p, i) => {
    if (i) box.append(el('span', 'wsm-sep', '›'));
    const b = el('button', 'wsm-crumb' + (i === parts.length - 1 ? ' here' : ''), p.label);
    b.onclick = p.go;
    box.append(b);
  });
  box.scrollLeft = box.scrollWidth; // the deepest part in view
}

function startSelecting(key) {
  if (selecting) return;
  selecting = true;
  picked.clear();
  if (key) picked.add(key);
  render();
}
const checkFor = (key, path = key) => (selecting ? { on: underPicked(path) || picked.has(key), set: (on) => ((on ? picked.add(key) : picked.delete(key)), render()) } : null);

let renderSeq = 0;
let chrome = null; // render()'s changes to the bar, buttons and notes, applied by applyChrome()
const applyChrome = () => chrome?.();

async function render() {
  const mine = ++renderSeq;
  const list = $('#wsm-list');
  // the place switcher: Linux only when it is installed, the phone folder only when this chat has one
  for (const [id, on] of [['ws', true], ['linux', linuxOk], ['phone', !!phoneOf()]]) {
    const b = $('#wsm-loc-' + id);
    b.hidden = !on;
    b.classList.toggle('on', loc === id);
    b.setAttribute('aria-selected', String(loc === id));
  }
  if (phoneOf()) $('#wsm-loc-phone-name').textContent = phoneOf().name;
  if (loc === 'phone' && !phoneOf()) loc = 'ws';
  // the rest of the screen changes with the list, in the same frame (not before the new place has been read)
  chrome = () => {
    chrome = null;
    list.classList.toggle('grid', view === 'grid');
    list.classList.remove('loading');
    list.dataset.loc = loc;
    $('#wsm-view').setAttribute('aria-label', view === 'grid' ? 'Show as a list' : 'Show as a grid');
    $('#wsm-view').classList.toggle('as-list', view === 'list');
    $('#wsm-select').textContent = selecting ? 'Done' : 'Select';
    $('#wsm-note').hidden = loc !== 'linux';
    $('#wsm-places').hidden = loc !== 'linux';
    $('#wsm-goto').hidden = loc !== 'linux';
    $('#wsm-tochat').hidden = loc === 'ws';
    $('#wsm-del').hidden = loc !== 'ws';
    if (loc !== 'ws') $('#wsm-phone').hidden = true;
    $('#wsm-chat').hidden = loc !== 'ws' || !scope;
  };
  if (loc === 'linux') return renderLinux(mine);
  if (loc === 'phone') return renderPhone(mine);
  return renderWs(mine);
}

async function renderWs(mine) {
  const sums = await workspaceSummaries();
  if (mine !== renderSeq) return; // a newer render (typing, tapping) took over while this one was reading
  const q = query.trim().toLowerCase();
  if (scope && !sums.some((s) => s.id === scope.id)) scope = null;
  // the chat being browsed: its own files, with bytes (thumbnails, share, delete)
  const cur = scope ? { id: scope.id, w: await getWorkspace(scope.id) } : null;
  if (cur) cur.files = wsListing(cur.w);
  // a search reads file lists only, never the bytes of chats that are not open
  let hits = null;
  if (q) {
    hits = [];
    for (const s of sums) {
      if (scope && s.id !== scope.id) continue;
      for (const f of await workspaceListing(s.id)) if (f.path.toLowerCase().includes(q)) hits.push({ s, f, name: f.path, size: f.size, mtime: f.mtime });
    }
    hits.sort(sorter);
  }
  if (mine !== renderSeq) return;
  const list = $('#wsm-list');
  const bar = $('#wsm-bar');
  const keep = list.dataset.loc === 'ws' ? list.scrollTop : 0;
  applyChrome();
  list.innerHTML = '';
  $('#wsm-select').hidden = !scope;
  $('#wsm-back').disabled = !scope;

  // the path bar: Workspace › chat › folder › …
  const parts = [{ label: '📁 Workspace', go: () => go(null) }];
  if (scope) {
    parts.push({ label: titleOf(scope.id).slice(0, 28), go: () => go({ id: scope.id, dir: '' }) });
    let acc = '';
    for (const part of scope.dir.split('/').filter(Boolean)) {
      acc = acc ? acc + '/' + part : part;
      const target = acc;
      parts.push({ label: part, go: () => go({ id: scope.id, dir: target }) });
    }
  }
  crumbs(parts);
  const done = () => {
    list.scrollTop = keep;
  };

  if (hits) {
    $('#wsm-summary').textContent = `${plural(hits.length, 'file')} match`;
    if (!hits.length) list.append(el('p', 'hint', 'No files match.'));
    fill(list, hits, ({ s, f }) => row({ icon: IMG_EXT.test(f.path) ? '🖼' : extOf(f.path).toUpperCase(), title: f.path, sub: `${titleOf(s.id)} · ${fmtBytes(f.size)} · ${ago(f.mtime)}`, onOpen: () => openWsFile(f.path, s.id) }));
    bar.hidden = true;
    return done();
  }

  if (!scope) {
    const total = sums.reduce((t, s) => t + s.size, 0);
    const files = sums.reduce((t, s) => t + s.n, 0);
    $('#wsm-summary').textContent = sums.length ? `${plural(sums.length, 'chat')} · ${plural(files, 'file')} · ${fmtBytes(total)}` : '';
    if (!sums.length) list.append(el('p', 'hint', 'No files yet. Files you attach to a chat, and files the assistant creates, show up here.'));
    const known = new Set(state.convs.map((c) => c.id));
    if (state.current) known.add(state.current.id);
    const chats = sums.map((s) => ({ s, name: titleOf(s.id), size: s.size, mtime: s.mtime, count: s.n, orphan: !known.has(s.id) }));
    chats.sort((a, b) => (a.orphan !== b.orphan ? (a.orphan ? 1 : -1) : sorter(a, b))); // files of deleted chats last
    fill(
      list,
      chats,
      (c) => row({ icon: c.orphan ? '🗑' : '💬', big: true, title: c.orphan ? 'Deleted chat' : c.name, sub: `${plural(c.count, 'file')} · ${fmtBytes(c.size)}${view === 'list' ? ' · ' + ago(c.mtime) : ''}`, onOpen: () => go({ id: c.s.id, dir: '' }), dim: c.orphan }),
      { periods: sort === 'new' },
    );
    bar.hidden = true;
    return done();
  }

  const all = entriesIn(cur.files, scope.dir);
  const hidden = all.filter((e) => hiddenName(e.name));
  const visible = all.filter((e) => !hiddenName(e.name));
  const ents = showHidden ? [...visible, ...hidden] : visible;
  const inDir = scope.dir ? cur.files.filter((f) => f.path.startsWith(scope.dir + '/')) : cur.files;
  $('#wsm-summary').textContent = `${plural(inDir.length, 'file')} · ${fmtBytes(inDir.reduce((t, f) => t + f.size, 0))}`;
  if (!all.length) list.append(el('p', 'hint', 'This folder is empty.'));
  fill(list, ents, (e) => {
    const key = e.isDir ? e.path + '/' : e.path;
    const check = checkFor(key, e.path);
    const dim = hiddenName(e.name);
    const onLong = () => startSelecting(key);
    if (e.isDir) return row({ icon: '📁', big: true, title: e.name, sub: `${plural(e.count, 'file')} · ${fmtBytes(e.size)}${view === 'list' ? ' · ' + ago(e.mtime) : ''}`, onOpen: () => (selecting ? check.set(!check.on) : go({ id: scope.id, dir: e.path })), check, dim, onLong });
    return row({ icon: extOf(e.name).toUpperCase(), thumb: IMG_EXT.test(e.name) ? thumbFor(cur, e.path) : null, title: e.name, sub: `${fmtBytes(e.size)}${view === 'list' ? ' · ' + ago(e.mtime) : ''}`, onOpen: () => (selecting ? check.set(!check.on) : openWsFile(e.path, scope.id)), check, dim, onLong });
  });
  if (hidden.length) {
    const names = hidden.slice(0, 3).map((e) => e.name).join(', ') + (hidden.length > 3 ? '…' : '');
    const t = el('button', 'wsm-more', showHidden ? `Hide the app's own files (${hidden.length})` : `Show the app's own files (${names})`);
    t.onclick = () => {
      showHidden = !showHidden;
      render();
    };
    list.append(t);
  }
  // actions for the selection
  const n = cur.files.filter((f) => underPicked(f.path)).length;
  bar.hidden = !selecting;
  $('#wsm-count').textContent = n ? `${plural(n, 'file')} selected` : 'Tap files or folders to select';
  for (const id of ['wsm-share', 'wsm-download', 'wsm-del', 'wsm-phone']) $('#' + id).disabled = !n;
  $('#wsm-phone').hidden = !(scope && state.convs.find((c) => c.id === scope.id)?.phoneFolder) && !(state.current?.id === scope.id && state.current.phoneFolder);
  done();
}

// ---------- 🐧 Linux files (read-only) ----------
let linuxOk = false;
const lsort = (a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : sort === 'name' ? a.name.localeCompare(b.name) : sorter(a, b) || a.name.localeCompare(b.name));

async function linuxGo(path) {
  const p = normPath(path, lpath);
  if (isHidden(p)) return toast(errorText('hidden'), 5000);
  const again = p === lpath && lres?.all && !lres.error;
  if (!again) lres = { loading: true };
  shown = PAGE;
  picked.clear();
  selecting = false;
  query = '';
  $('#wsm-search').value = '';
  lpath = p;
  render();
  let r;
  try {
    r = await listDir(p);
  } catch (e) {
    r = { error: String(e?.message || e) };
  }
  if (lpath !== p) return; // went elsewhere meanwhile
  if (again && r.error) return; // the folder shown stays; opening it says what is wrong
  if (again && lres?.all && sameListing(lres, r)) return;
  if (r.error) {
    lres = { error: r.error };
    return render();
  }
  lpath = r.real; // a link followed: the bar shows where it really is
  lres = r;
  lsizes = {};
  lsized = false;
  render();
  // every folder's size (decision 192), counted after the listing is on screen – one du for all of them; a folder that
  // takes long (node_modules) shows "size…" until it is done
  const dirs = r.all.filter((e) => e.isDir && e.kind !== 'link').map((e) => e.name).slice(0, SIZE_CAP);
  if (dirs.length) {
    const sizes = await folderSizes(lpath, dirs).catch(() => ({}));
    if (lpath === r.real && lres === r) {
      lsizes = sizes;
      lsized = true;
      render();
    }
  } else lsized = true;
}

let placesCache = null; // read once per visit to Files
async function places() {
  const set = ['/root'];
  for (const id of [state.current?.id, scope?.id].filter(Boolean)) {
    const w = await getWorkspace(id).catch(() => null);
    for (const p of (w?.shellPlaces || []).slice().reverse()) if (!set.includes(p) && !isHidden(p)) set.push(p);
  }
  if (!set.includes('/tmp')) set.push('/tmp');
  return set;
}

const sameListing = (a, b) => a.real === b.real && a.all.length === b.all.length && a.all.every((e, i) => e.name === b.all[i].name && e.size === b.all[i].size && e.mtime === b.all[i].mtime);

async function renderLinux(mine) {
  const list = $('#wsm-list');
  const box = $('#wsm-places');
  const ps = placesCache || (placesCache = await places());
  if (mine !== renderSeq) return;
  if ((!lres || lres.loading) && list.childElementCount && !list.querySelector(':scope > .hint')) {
    list.classList.add('loading'); // what was shown stays (dimmed) until the new folder is read: no blank flash
    return;
  }
  applyChrome();
  box.innerHTML = '';
  for (const p of ps) {
    const b = el('button', 'wsm-place' + (p === lpath ? ' on' : ''), p);
    b.title = p;
    b.onclick = () => linuxGo(p);
    box.append(b);
  }
  const parts = [{ label: '🐧 /', go: () => linuxGo('/') }];
  let acc = '';
  for (const part of lpath.split('/').filter(Boolean)) {
    acc += '/' + part;
    const target = acc;
    parts.push({ label: part, go: () => linuxGo(target) });
  }
  crumbs(parts);
  $('#wsm-back').disabled = lpath === '/';
  $('#wsm-select').hidden = false;
  list.innerHTML = '';
  const bar = $('#wsm-bar');
  bar.hidden = !selecting;
  if (!lres || lres.loading) {
    $('#wsm-summary').textContent = lpath;
    list.append(el('p', 'hint', 'Reading…'));
    return;
  }
  if (lres.error) {
    $('#wsm-summary').textContent = lpath;
    list.append(el('p', 'hint', errorText(lres.error)));
    bar.hidden = true;
    return;
  }
  const q = query.trim().toLowerCase();
  const all = lres.all.filter((e) => !q || e.name.toLowerCase().includes(q)).sort(lsort);
  const ents = all.slice(0, LIST_CAP);
  const nd = lres.all.filter((e) => e.isDir).length;
  // the folder's total: its files and the folders in it (once their sizes are counted)
  const filesBytes = lres.all.filter((e) => !e.isDir && e.kind !== 'link').reduce((n, e) => n + (e.size || 0), 0);
  const total = lsized ? filesBytes + Object.values(lsizes).reduce((n, b) => n + b, 0) : 0;
  $('#wsm-summary').textContent = `${plural(nd, 'folder')} · ${plural(lres.all.length - nd, 'file')} · ${lsized ? fmtBytes(total) : 'size…'}${q ? ` · ${all.length} match` : ''}`;
  if (!lres.all.length) list.append(el('p', 'hint', 'This folder is empty.'));
  else if (!all.length) list.append(el('p', 'hint', 'Nothing here matches.'));
  fill(list, ents, (e) => {
    const key = e.isDir ? e.path + '/' : e.path;
    const check = checkFor(key, e.path);
    const onLong = () => startSelecting(key);
    const when = view === 'list' && e.mtime ? ' · ' + ago(e.mtime) : '';
    const tap = (fn) => () => (selecting ? check.set(!check.on) : fn());
    if (e.isDir) {
      // how many things and how big (decision 192): "25 items · 3.4 MB"; the size follows once du is done
      const bytes = lsizes[e.name] !== undefined ? fmtBytes(lsizes[e.name]) : e.kind === 'link' ? '' : lsized ? '' : 'size…';
      const size = [e.heavy ? '' : e.count !== undefined ? plural(e.count, 'item') : 'folder', bytes].filter(Boolean).join(' · ') || 'folder';
      return row({ icon: e.heavy ? '🗂' : '📁', big: true, title: e.name + (e.kind === 'link' ? ' ↗' : ''), sub: size + when, dim: e.heavy || e.name.startsWith('.'), check, onLong, onOpen: tap(() => openLinuxDir(e)) });
    }
    if (KEY_NAME.test(e.name)) return row({ icon: '🔒', title: e.name, sub: 'private key – not shown', dim: true, onOpen: () => toast('A private key – not shown here', 4000) });
    const pic = IMG_EXT.test(e.name) && e.kind !== 'link' && e.size > 0 && e.size <= THUMB_MAX;
    return row({ icon: IMG_EXT.test(e.name) ? '🖼' : e.kind === 'link' ? '🔗' : extOf(e.name).toUpperCase(), thumb: pic ? linuxThumb(e) : null, title: e.name, sub: (e.kind === 'link' ? 'link' : fmtBytes(e.size)) + when, dim: e.name.startsWith('.'), check, onLong, onOpen: tap(() => openLinuxFile(e.path)) });
  });
  if (lres.all.length > LIST_CAP && all.length > LIST_CAP) list.append(el('p', 'hint', `${all.length - LIST_CAP} more not shown – search, or ✎ to go to a path.`));
  const n = picked.size;
  $('#wsm-count').textContent = n ? `${plural(n, 'item')} selected` : 'Tap files or folders to select';
  for (const id of ['wsm-share', 'wsm-download', 'wsm-tochat']) $('#' + id).disabled = !n;
}

async function openLinuxDir(e) {
  if (e.heavy) {
    const size = lsizes[e.name] !== undefined ? fmtBytes(lsizes[e.name]) : 'many files';
    const ok = await chooseOne(`Open ${e.name}?`, [{ label: `Open ${e.name}`, value: true }, { label: 'Stay here', value: false }], `${size} of ${e.name === '.git' ? "git's own data" : 'installed packages'}. Read-only here, like everything in Linux files.`);
    if (!ok) return;
  }
  linuxGo(e.path);
}

/** A file from Linux or the phone folder in the viewer: read-only, with Save / Share / Copy into this chat. */
function showExternal(name, title, bytes, note = '') {
  setViewing({ name, bytes, external: true });
  $('#preview-title').textContent = title;
  $('#preview-delete').hidden = true;
  const body = $('#preview-body');
  const img = $('#preview-img');
  img.hidden = true;
  body.hidden = false;
  if (IMG_EXT.test(name)) {
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(new Blob([bytes], { type: mimeOf(name) }));
    img.hidden = false;
    body.hidden = true;
  } else if (looksText(bytes)) {
    showPreviewText(name, bytesToText(bytes.byteLength > VIEW_MAX ? bytes.subarray(0, VIEW_MAX) : bytes), note);
  } else body.textContent = `${note ? note + '\n' : ''}Binary file · ${fmtBytes(bytes.byteLength)} · ${mimeOf(name)}\nSave it to the phone or share it to open it in another app.`;
  $('#preview-actions').hidden = false;
  setPreviewButton(name);
  openSheet('#preview-sheet', true);
}
/** A file that cannot be shown: the reason, and no actions. */
function showRefused(title, text) {
  setViewing(null);
  $('#preview-title').textContent = title;
  $('#preview-img').hidden = true;
  $('#preview-body').hidden = false;
  $('#preview-body').textContent = text;
  $('#preview-actions').hidden = true;
  setPreviewButton('');
  openSheet('#preview-sheet', true);
}

async function openLinuxFile(path) {
  if (isHidden(path)) return toast(errorText('hidden'), 5000);
  toast('Opening…', 60000);
  let r;
  try {
    r = await readLinuxFile(path, { onProgress: (got, all) => toast(`Reading… ${Math.round((got / all) * 100)}%`, 60000) });
  } catch (e) {
    r = { error: String(e?.message || e) };
  }
  $('#toast').classList.remove('show');
  if (r.error === 'secret') return showRefused(baseName(path), `🔒 ${baseName(path)}: ${r.reason}.`);
  if (r.error === 'toobig') {
    if (!canExportLinux()) return showRefused(baseName(path), `${baseName(path)} · ${fmtBytes(r.size)}\n\nToo big to open here. Copy what you need in the shell, e.g.\ncp '${r.real}' /workspace/`);
    // too big to show here, never too big to save: offer that instead
    selecting = false;
    picked.clear();
    picked.add(r.real);
    const go = await chooseOne(`${baseName(path)} · ${fmtBytes(r.size)}`, [{ label: '⬇ Save it to the phone', value: true }, { label: 'Cancel', value: false }], 'Too big to open in the app. Save it, then open it with another app (a video player, a file manager).');
    if (go) await linuxDownload();
    picked.clear();
    return;
  }
  if (r.error) return toast(errorText(r.error), 5000);
  showExternal(baseName(r.real), r.real, r.bytes, r.size > VIEW_MAX && looksText(r.bytes) ? `(the first ${fmtBytes(VIEW_MAX)} of ${fmtBytes(r.size)})` : '');
}

// ---------- 📱 the linked phone folder (read-only here) ----------
async function renderPhone(mine) {
  const f = phoneOf();
  const list = $('#wsm-list');
  if (!pfiles) {
    applyChrome();
    list.innerHTML = '';
    list.append(el('p', 'hint', 'Reading…'));
    try {
      pfiles = (await listFolder(f, '', true, 2000)).filter((e) => !e.isDir).map((e) => ({ path: e.path, size: e.size || 0, mtime: e.mtime || 0 }));
    } catch (e) {
      pfiles = [];
      toast('Could not read the folder: ' + e.message, 5000);
    }
    if (mine !== renderSeq) return;
  }
  const parts = [{ label: '📱 ' + f.name, go: () => phoneGo('') }];
  let acc = '';
  for (const part of pdir.split('/').filter(Boolean)) {
    acc = acc ? acc + '/' + part : part;
    const target = acc;
    parts.push({ label: part, go: () => phoneGo(target) });
  }
  crumbs(parts);
  $('#wsm-back').disabled = !pdir;
  $('#wsm-select').hidden = false;
  applyChrome();
  list.innerHTML = '';
  const q = query.trim().toLowerCase();
  const ents = q ? pfiles.filter((x) => x.path.toLowerCase().includes(q)).map((x) => ({ ...x, name: x.path, isDir: false })) : entriesIn(pfiles, pdir);
  $('#wsm-summary').textContent = `${plural(pfiles.length, 'file')} · ${fmtBytes(pfiles.reduce((t, x) => t + x.size, 0))}`;
  if (!ents.length) list.append(el('p', 'hint', q ? 'No files match.' : 'This folder is empty.'));
  fill(list, ents, (e) => {
    const key = e.isDir ? e.path + '/' : e.path;
    const check = checkFor(key, e.path);
    const onLong = () => startSelecting(key);
    const tap = (fn) => () => (selecting ? check.set(!check.on) : fn());
    if (e.isDir) return row({ icon: '📁', big: true, title: e.name, sub: `${plural(e.count, 'file')} · ${fmtBytes(e.size)}`, check, onLong, onOpen: tap(() => phoneGo(e.path)) });
    return row({ icon: IMG_EXT.test(e.name) ? '🖼' : extOf(e.name).toUpperCase(), title: e.name, sub: fmtBytes(e.size), check, onLong, onOpen: tap(() => openPhone(e.path)) });
  });
  const n = pfiles.filter((x) => underPicked(x.path)).length;
  $('#wsm-bar').hidden = !selecting;
  $('#wsm-count').textContent = n ? `${plural(n, 'file')} selected` : 'Tap files or folders to select';
  for (const id of ['wsm-share', 'wsm-download', 'wsm-tochat']) $('#' + id).disabled = !n;
}
function phoneGo(dir) {
  pdir = dir;
  shown = PAGE;
  selecting = false;
  picked.clear();
  render();
}
async function openPhone(path) {
  try {
    showExternal(baseName(path), '📱 ' + phoneOf().name + '/' + path, await readPhoneFile(phoneOf(), path));
  } catch (e) {
    toast('Could not read it: ' + e.message, 5000);
  }
}

// ---------- copying into this chat ----------
/** files: [{ dest, read: () => bytes|{error} }]. Asks before replacing. -> how many were copied */
async function copyIntoChat(items, { skippedNote = '' } = {}) {
  const conv = state.current;
  if (!conv) return toast('Open a chat first');
  const w = await loadWs(conv.id);
  const clash = items.filter((x) => w.files[x.dest]).length;
  if (clash) {
    const how = await chooseOne(
      items.length === 1 ? `${items[0].dest} is already in this chat` : `${plural(clash, 'file')} already in this chat`,
      [
        { label: items.length === 1 ? 'Replace it' : 'Replace them', value: 'replace', danger: true },
        ...(items.length > 1 ? [{ label: 'Copy only the new ones', value: 'skip' }] : []),
        { label: 'Cancel', value: null },
      ],
      'The copy in this chat would be overwritten.',
    );
    if (!how) return 0;
    if (how === 'skip') items = items.filter((x) => !w.files[x.dest]);
  }
  let n = 0;
  let refused = 0;
  const btn = $('#wsm-tochat');
  try {
    for (const it of items) {
      if (items.length > 1) $('#wsm-count').textContent = `Copying ${n + refused + 1}/${items.length}…`;
      const r = await it.read();
      if (!r || r.error) {
        refused++;
        continue;
      }
      wsPut(w, it.dest, r, { by: 'you' });
      n++;
    }
  } catch (e) {
    toast('Could not copy: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
  }
  updateFilesChip();
  hooks.workspaceChanged?.();
  const extra = [refused ? `${refused} not copied (private keys, unreadable)` : '', skippedNote].filter(Boolean).join('; ');
  toast(n === 1 && items.length === 1 ? `Copied into this chat as ${items[0].dest}` : `Copied ${plural(n, 'file')} into this chat${extra ? ' – ' + extra : ''}`, 5000);
  return n;
}

const readLinuxBytes = (path) => async () => {
  const r = await readLinuxFile(path);
  return r.error ? r : r.bytes;
};

/** Copy the selection (files and folders) from Linux into this chat. */
async function linuxToChat(paths) {
  const files = paths.filter((p) => !p.endsWith('/'));
  const dirs = paths.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1));
  if (files.length === 1 && !dirs.length) {
    const dest = await askText('Copy into this chat as', baseName(files[0]), { hint: "A path in this chat's workspace (/workspace in the shell).", ok: 'Copy' });
    if (dest === null) return;
    const p = cleanPath(dest);
    if (!p) return toast('That is not a usable name');
    return copyIntoChat([{ dest: p, read: readLinuxBytes(files[0]) }]);
  }
  toast('Counting files…', 60000);
  const items = files.map((p) => ({ rel: baseName(p), path: p, size: 0 }));
  const skipped = [];
  let more = 0;
  let bytes = 0;
  for (const d of dirs) {
    const plan = await planFolderCopy(d, { maxFiles: COPY_MAX_FILES - items.length, maxBytes: COPY_MAX_BYTES - bytes }).catch((e) => ({ error: String(e?.message || e) }));
    if (plan.error) {
      $('#toast').classList.remove('show');
      return toast(errorText(plan.error), 5000);
    }
    const top = dirs.length === 1 && !files.length ? '' : baseName(d) + '/';
    for (const f of plan.files) items.push({ rel: top + f.rel, path: f.path, size: f.size });
    skipped.push(...plan.skipped.map((s) => (top || '') + s));
    more += plan.more + plan.tooBig;
    bytes += plan.bytes;
  }
  $('#toast').classList.remove('show');
  if (!items.length) return toast(skipped.length ? 'Nothing to copy – only ' + skipped.join(', ') : 'Nothing to copy: the folder is empty');
  const into = await askText(`Copy ${plural(items.length, 'file')}${bytes ? ' (' + fmtBytes(bytes) + ')' : ''} into this chat`, dirs.length === 1 && !files.length ? baseName(dirs[0]) : '', {
    hint: [
      'Into which folder of the workspace (empty: the top).',
      skipped.length ? `Left out: ${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? '…' : ''} (git data and packages stay in Linux).` : '',
      more ? `${plural(more, 'more file')} not copied (at most ${COPY_MAX_FILES} files and ${fmtBytes(COPY_MAX_BYTES)} at a time).` : '',
    ]
      .filter(Boolean)
      .join(' '),
    ok: 'Copy',
  });
  if (into === null) return;
  const pre = cleanPath(into);
  return copyIntoChat(
    items.map((it) => ({ dest: (pre ? pre + '/' : '') + it.rel, read: readLinuxBytes(it.path) })),
    { skippedNote: more ? `${more} more left in Linux` : '' },
  );
}

async function phoneToChat(sel) {
  const f = phoneOf();
  if (!f || !sel.length) return;
  const { files, skipped, more, bytes } = planPickedCopy(sel);
  if (!files.length) return toast(skipped.length ? 'Nothing to copy – only ' + skipped.join(', ') : 'Nothing to copy');
  if (files.length === 1 && !skipped.length && !more) return copyIntoChat([{ dest: files[0].path, read: () => readPhoneFile(f, files[0].path) }]);
  const into = await askText(`Copy ${plural(files.length, 'file')} (${fmtBytes(bytes)}) into this chat`, '', {
    hint: [
      `Into which folder of the workspace (empty: the top). Paths stay as in “${f.name}”.`,
      skipped.length ? `Left out: ${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? '…' : ''} (git data and packages stay on the phone).` : '',
      more ? `${plural(more, 'more file')} not copied (at most ${COPY_MAX_FILES} files and ${fmtBytes(COPY_MAX_BYTES)} at a time).` : '',
    ]
      .filter(Boolean)
      .join(' '),
    ok: 'Copy',
  });
  if (into === null) return;
  const pre = cleanPath(into);
  return copyIntoChat(
    files.map((x) => ({ dest: (pre ? pre + '/' : '') + x.path, read: () => readPhoneFile(f, x.path) })),
    { skippedNote: more ? `${more} more left on the phone` : '' },
  );
}

$('#preview-tochat').onclick = async () => {
  const v = viewing;
  if (!v?.external) return;
  const dest = await askText('Copy into this chat as', v.name, { hint: "A path in this chat's workspace (/workspace in the shell).", ok: 'Copy' });
  if (dest === null) return;
  const p = cleanPath(dest);
  if (!p) return toast('That is not a usable name');
  await copyIntoChat([{ dest: p, read: async () => v.bytes }]);
};

// ---------- the selection's actions ----------
// Linux pictures: read when their tile scrolls near (one at a time, through the same checks as opening them), kept
// for the visit; a picture over THUMB_MAX shows its icon
const THUMB_MAX = 3 * 1024 * 1024;
const linuxThumbs = new Map(); // `${path}|${mtime}|${size}` -> blob URL (or '' when it could not be read)
const THUMB_KEEP = 120;
function linuxThumb(e) {
  const img = el('img', 'wsm-thumb');
  const key = `${e.path}|${e.mtime}|${e.size}`;
  img._src = async () => {
    if (linuxThumbs.has(key)) return linuxThumbs.get(key);
    let url = '';
    try {
      const r = await readLinuxFile(e.path, { max: THUMB_MAX });
      if (!r.error && r.bytes?.byteLength) url = URL.createObjectURL(new Blob([r.bytes], { type: mimeOf(e.name) }));
    } catch {
      /* the icon stays */
    }
    linuxThumbs.set(key, url);
    while (linuxThumbs.size > THUMB_KEEP) {
      const [k, u] = linuxThumbs.entries().next().value;
      linuxThumbs.delete(k);
      if (u) URL.revokeObjectURL(u);
    }
    return url;
  };
  img.onerror = () => img.replaceWith(el('span', 'wsm-icon', '🖼'));
  if (thumbIO) thumbIO.observe(img);
  else setThumb(img);
  return img;
}
async function setThumb(img) {
  const url = await img._src();
  if (url) img.src = url;
  else if (img.isConnected) img.replaceWith(el('span', 'wsm-icon', '🖼'));
}

function thumbFor(space, path) {
  const img = el('img', 'wsm-thumb');
  img._src = () => wsBlobUrl(space.id, path, space.w.files[path]?.data);
  if (thumbIO) thumbIO.observe(img);
  else setThumb(img);
  return img;
}
// thumbnails are made only when their row comes near the screen (each one turns the picture's bytes into a blob)
const thumbIO =
  typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(
        (es) => {
          for (const e of es) {
            if (!e.isIntersecting) continue;
            thumbIO.unobserve(e.target);
            setThumb(e.target);
          }
        },
        { rootMargin: '300px' },
      )
    : null;

function go(s) {
  scope = s;
  shown = PAGE;
  selecting = false;
  picked.clear();
  render();
}

/** [name, bytes] of the selected files in the current place (folders: the files in them, workspaces and phone only). */
async function selectedFiles() {
  if (loc === 'ws') {
    const w = await getWorkspace(scope.id);
    return Object.keys(w.files).filter(underPicked).map((p) => [p, w.files[p].data]);
  }
  if (loc === 'phone') {
    const out = [];
    for (const x of pfiles.filter((x) => underPicked(x.path))) out.push([x.path, await readPhoneFile(phoneOf(), x.path)]);
    return out;
  }
  const out = [];
  let refused = 0;
  for (const p of [...picked].filter((p) => !p.endsWith('/'))) {
    const r = await readLinuxFile(p);
    if (r.error) refused++;
    else out.push([baseName(p), r.bytes]);
  }
  if ([...picked].some((p) => p.endsWith('/'))) toast('Folders are left out: copy them into the chat first', 4000);
  if (refused) toast(`${plural(refused, 'file')} not included (private keys, unreadable, or too big to share – use Download, which takes any size)`, 5000);
  return out;
}
const zipName = () => (loc === 'ws' ? titleOf(scope.id) : loc === 'linux' ? baseName(lpath) : phoneOf()?.name || 'files').replace(/[^\w]+/g, '_').slice(0, 30) || 'files';

$('#wsm-select').onclick = () => {
  selecting = !selecting;
  picked.clear();
  render();
};
let typing = null;
$('#wsm-search').oninput = (e) => {
  query = e.target.value;
  shown = PAGE;
  clearTimeout(typing);
  typing = setTimeout(render, 180); // not on every key
};
$('#wsm-sort').onchange = (e) => {
  sort = e.target.value;
  shown = PAGE;
  render();
};
$('#wsm-view').onclick = () => {
  view = view === 'grid' ? 'list' : 'grid';
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* only a convenience */
  }
  render();
};
$('#wsm-back').onclick = () => {
  if (loc === 'linux') return lpath !== '/' && linuxGo(parentOf(lpath));
  if (loc === 'phone') return pdir && phoneGo(pdir.includes('/') ? pdir.slice(0, pdir.lastIndexOf('/')) : '');
  if (!scope) return;
  if (!scope.dir) return go(null);
  go({ id: scope.id, dir: scope.dir.includes('/') ? scope.dir.slice(0, scope.dir.lastIndexOf('/')) : '' });
};
$('#wsm-goto').onclick = async () => {
  const p = await askText('Go to a folder or file', lpath, { hint: 'A path in Linux, e.g. /root/project or ~/notes.txt', ok: 'Go' });
  if (p === null || !p.trim()) return;
  const n = normPath(p, lpath);
  if (isHidden(n)) return toast(errorText('hidden'), 5000);
  const st = await statPath(n).catch((e) => ({ error: String(e?.message || e) }));
  if (st.error) return toast(errorText(st.error), 5000);
  if (st.dir) return linuxGo(st.real);
  openLinuxFile(st.real);
};
const switchTo = (where) => {
  if (loc === where && where !== 'ws') return;
  loc = where;
  selecting = false;
  picked.clear();
  query = '';
  shown = PAGE;
  $('#wsm-search').value = '';
  if (where === 'linux') return linuxGo(lpath);
  if (where === 'phone') {
    pfiles = null;
    pdir = '';
  }
  render();
};
$('#wsm-loc-ws').onclick = () => switchTo('ws');
$('#wsm-loc-linux').onclick = () => switchTo('linux');
$('#wsm-loc-phone').onclick = () => switchTo('phone');
$('#wsm-share').onclick = async () => {
  const files = await selectedFiles();
  if (!files.length) return;
  try {
    if (files.length === 1) return await shareBytes(files[0][0], files[0][1]);
    const { zipSync } = await import('fflate');
    await shareBytes(`${zipName()}.zip`, zipSync(Object.fromEntries(files)));
  } catch (e) {
    if (!/cancel/i.test(e.message || '')) toast('Could not share: ' + e.message);
  }
};
/**
 * Linux files to Download/Chronicle, each streamed from the shell's disk on the phone (any size – a 500 MB recording
 * never passes through the app's memory). The phone folder linked to this chat is offered too.
 */
async function linuxDownload() {
  const paths = [...picked].filter((p) => !p.endsWith('/'));
  if ([...picked].some((p) => p.endsWith('/'))) toast('Folders are left out: save the files in them, or zip them in the shell first', 4000);
  if (!paths.length) return;
  const f = phoneOf();
  let where = 'downloads';
  if (f) {
    where = await chooseOne(
      paths.length === 1 ? `Save ${baseName(paths[0])}` : `Save ${plural(paths.length, 'file')}`,
      [
        { label: '⬇ Download/Chronicle', value: 'downloads' },
        { label: `📱 ${f.name}`, sub: 'the phone folder linked to this chat', value: 'folder' },
      ],
      'Copied straight from Linux – any size.',
    );
    if (!where) return;
  }
  let ok = 0;
  const bad = [];
  for (const p of paths) {
    const st = await statPath(p).catch((e) => ({ error: String(e?.message || e) }));
    if (st.error || st.dir) {
      bad.push(`${baseName(p)}: ${st.error ? errorText(st.error) : 'a folder'}`);
      continue;
    }
    const label = paths.length > 1 ? `${ok + bad.length + 1}/${paths.length} ` : '';
    try {
      const r = await exportLinuxFile(st.real, where === 'folder' ? { folder: f, path: baseName(st.real) } : {}, (done, total) => toast(`Saving ${label}${baseName(st.real)} – ${Math.round((done / Math.max(1, total)) * 100)}% of ${fmtBytes(total)}`, 60000));
      ok++;
      if (paths.length === 1) toast(`Saved ${r.name} (${fmtBytes(r.bytes)}) to ${r.folder}`, 5000);
    } catch (e) {
      bad.push(`${baseName(p)}: ${String(e?.message || e).replace(/^Could not save it: /, '')}`);
    }
  }
  if (paths.length > 1 || bad.length) toast(`${ok ? `Saved ${plural(ok, 'file')}` : 'Nothing saved'}${bad.length ? ` – not saved: ${bad.slice(0, 2).join('; ')}` : ''}`, 6000);
}

$('#wsm-download').onclick = async () => {
  if (loc === 'linux' && canExportLinux()) return linuxDownload();
  const files = await selectedFiles();
  if (!files.length) return;
  try {
    if (files.length === 1) return await saveBytes(files[0][0], files[0][1]);
    const { zipSync } = await import('fflate');
    await saveBytes(`${zipName()}.zip`, zipSync(Object.fromEntries(files)));
  } catch (e) {
    toast(String(e.message || e), 5000);
  }
};
$('#wsm-tochat').onclick = async () => {
  const btn = $('#wsm-tochat');
  btn.disabled = true;
  try {
    if (loc === 'linux') await linuxToChat([...picked]);
    else if (loc === 'phone') {
      await phoneToChat(pfiles.filter((x) => underPicked(x.path)));
    }
  } finally {
    btn.disabled = false;
    render();
  }
};
$('#wsm-del').onclick = async () => {
  const w = await getWorkspace(scope.id);
  const paths = Object.keys(w.files).filter(underPicked);
  if (!paths.length || !confirm(`Delete ${plural(paths.length, 'file')}? This can't be undone.`)) return;
  for (const p of paths) wsDelete(w, p);
  saveWorkspace(w);
  picked.clear();
  toast(`Deleted ${plural(paths.length, 'file')}`);
  updateFilesChip();
  render();
};
$('#wsm-phone').onclick = async () => {
  const conv = state.convs.find((c) => c.id === scope.id) || state.current;
  const f = conv?.phoneFolder;
  const files = await selectedFiles();
  if (!f || !files.length) return;
  if (!confirm(`Save ${plural(files.length, 'file')} into “${f.name}” on your phone? Files with the same name there are replaced.`)) return;
  try {
    for (const [p, d] of files) await writePhoneFile(f, p, d);
    toast(`Saved ${plural(files.length, 'file')} to “${f.name}”`);
  } catch (e) {
    toast('Could not save: ' + e.message, 5000);
  }
};
$('#wsm-chat').onclick = () => {
  if (!scope) return;
  openSheet('#wsm-sheet', false);
  selectConv(scope.id);
};

export async function openWorkspaceManager(startConv = null, where = 'ws') {
  scope = startConv ? { id: startConv, dir: '' } : null;
  loc = 'ws';
  selecting = false;
  picked.clear();
  query = '';
  shown = PAGE;
  $('#wsm-search').value = '';
  placesCache = null;
  linuxOk = await linuxReady().catch(() => false);
  if (where === 'linux' && linuxOk) {
    openSheet('#wsm-sheet', true);
    return switchTo('linux');
  }
  await render();
  openSheet('#wsm-sheet', true);
}
// an agent at work changes files many times a second: redraw the open page at most twice a second
let changedTimer = null;
hooks.workspaceChanged = () => {
  if (!$('#wsm-sheet').classList.contains('open') || changedTimer || loc !== 'ws') return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    render();
  }, 500);
};
$('#open-wsm').onclick = () => {
  openDrawer(false);
  openWorkspaceManager();
};
$('#ws-all-chats').onclick = () => openWorkspaceManager();
