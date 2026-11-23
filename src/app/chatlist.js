// The drawer: usage meters, chat list, search across chats, pins, chat menu and automatic chat names.
import { browserOpen, onBrowserChange, viewBrowser } from '../browsercontrol.js';
import { streamChat, getUsage } from '../api.js';
import { art, conversations, saveSettings, vectors } from '../store.js';
import { getWorkspace, deleteWorkspace } from '../sandbox.js';
import { expandMapBlocks } from '../mapblock.js';
import { avatarEl, newPersonaId, AVATAR_COLORS } from '../personas.js';
import { parseStChat, toStChat, toReadable } from '../stchat.js';
import { convTime, groupConvs, shortTime } from '../convgroups.js';
import { buildChatExport, chatPersonaIds, detectChatFile, parseChatExport, planChatImport } from '../chatexport.js';
import { updateModelUI } from './composer.js';
import { $, appMode, chatPersona, convIsRp, defaultPersona, el, groupMembers, hooks, isGroup, personaById, pref, setAppMode, state, toast, uid } from './core.js';
import { compactChat, impersonate, openInspector, setEditing } from './engine.js';
import { setPref, shareBytes, updateFilesChip, updateShortcuts, updateToolsChip } from './extras.js';
import { addGreeting, groupAvatar, openFind, renderMessages, updateHeader } from './render.js';
import { openUsageHistory } from './settings.js';
import { makeChatPersona } from './personas-ui.js';
import { P } from '../prompts.js';
import { unfinishedQuietCheck } from '../autonomy.js';

// ---------- Go allowance meters ----------
function fmtReset(ms) {
  if (!ms || Number.isNaN(ms)) return '';
  const d = ms - Date.now();
  if (d <= 0) return 'now';
  const mins = Math.ceil(d / 6e4);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 48) return `${Math.round(h / 24)}d`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * The side menu's usage cards fold with a tap on their title (decision 205): folded, each is one line ("5h 0% · wk 9% ·
 * mo 12%") so the chat list has the room; tap again for the meters. Remembered on this phone.
 */
const FOLD_KEY = 'ocm.usageFolded';
const folded = () => {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
};
const applyFold = () => document.body.classList.toggle('usage-folded', folded());
function toggleUsageFold() {
  try {
    localStorage.setItem(FOLD_KEY, folded() ? '0' : '1');
  } catch {
    /* just for this run */
    document.body.classList.toggle('usage-folded');
    return;
  }
  applyFold();
}
/** The card's title: a button that folds both cards, with the one-line summary shown while folded. */
function usageName(text, key) {
  const b = el('button', 'go-usage-name');
  b.type = 'button';
  b.setAttribute('aria-label', `${text} – tap to fold or unfold`);
  const name = el('span', null, text.replace(/ usage$/, ''));
  if (/ usage$/.test(text)) name.append(el('span', 'usage-word', ' usage'));
  b.append(el('span', 'usage-chev', '▾'), name, el('small', 'usage-sum', ''));
  b.querySelector('.usage-sum').dataset.usage = key;
  b.onclick = toggleUsageFold;
  return b;
}
function setUsageSum(key, text) {
  document.querySelectorAll(`.usage-sum[data-usage="${key}"]`).forEach((s) => (s.textContent = text));
}
applyFold();
hooks.usageName = usageName;
hooks.setUsageSum = setUsageSum;

let usageAt = 0;
const resetUsageAt = () => (usageAt = 0);
async function refreshUsage(force) {
  if (!pref('showGoUsage') || !state.settings.apiKey || (!force && Date.now() - usageAt < 15000)) return;
  usageAt = Date.now();
  const box = $('#go-usage');
  const head = () => {
    box.innerHTML = '';
    const title = el('div', 'go-usage-title');
    title.append(usageName('OpenCode Go usage', 'go'));
    const hist = el('button', 'go-usage-link', 'History');
    hist.onclick = (e) => {
      e.preventDefault();
      openUsageHistory();
    };
    title.append(hist);
    const link = el('a', 'go-usage-link', 'Console ↗');
    link.href = consoleUsageUrl();
    link.target = '_blank';
    link.rel = 'noopener';
    title.append(link);
    box.append(title);
    box.hidden = false;
  };
  const hint = state.settings.workspaceId ? '' : 'Add your Workspace ID in Settings to see usage here. ';
  let u;
  try {
    u = await getUsage(state.settings);
  } catch (e) {
    head();
    box.append(el('div', 'go-usage-msg', `${hint}(${e.message.slice(0, 120)})`));
    return;
  }
  head();
  if (!u) {
    box.append(el('div', 'go-usage-msg', hint || 'Usage isn’t available for this key/workspace. Check it in the Console.'));
    return;
  }
  // folded (tap the title): one line of percentages instead of the meters (decision 205)
  setUsageSum('go', [['rolling', '5h'], ['weekly', 'wk'], ['monthly', 'mo']].filter(([k]) => u[k]).map(([k, s]) => `${s} ${u[k].limited ? 'limited' : Math.round(Math.max(0, Math.min(100, u[k].percent))) + '%'}`).join(' · '));
  for (const [key, label] of [['rolling', '5-hour'], ['weekly', 'Weekly'], ['monthly', 'Monthly']]) {
    const m = u[key];
    if (!m) continue;
    const pct = Math.max(0, Math.min(100, m.percent));
    const row = el('div', 'meter' + (m.limited ? ' limited' : pct >= 80 ? ' high' : ''));
    const top = el('div', 'meter-top');
    top.append(el('span', null, label), el('span', 'dim', m.limited ? `limited · resets ${fmtReset(m.resetsAt)}` : `${Math.round(pct)}% · resets ${fmtReset(m.resetsAt)}`));
    const bar = el('div', 'meter-bar');
    const fill = el('i');
    fill.style.width = (m.limited ? 100 : pct) + '%';
    bar.append(fill);
    row.append(top, bar);
    box.append(row);
  }
}

function consoleUsageUrl() {
  const id = state.settings.workspaceId;
  return id ? `https://opencode.ai/console/${id}/activity/overview` : 'https://opencode.ai/console';
}

// ---------- drawer / sheets ----------
function openDrawer(open) {
  if (open) refreshUsage();
  if (open) hooks.ccDrawer?.(); // Claude Code's subscription usage, a line under the Go one (decision 165)
  if (open && (listStale || listDay !== new Date().toDateString())) renderConvList(); // stale, or "Today" became "Yesterday" while the app was open
  document.body.classList.toggle('drawer-open', open);
  $('#drawer').setAttribute('aria-hidden', String(!open));
}
function openSheet(id, open) {
  const s = $(id);
  s.classList.toggle('open', open);
  s.setAttribute('aria-hidden', String(!open));
}
/**
 * A small menu anchored to a button (the 📎 and tools menus): placed now, and again whenever the screen size changes
 * while it is open – tapping the button closes the keyboard, the message box drops to the bottom, and a menu placed
 * only once was left stuck in the middle of the screen (decision 228).
 */
function anchorPopover(id, place) {
  const s = $(id);
  place();
  requestAnimationFrame(place); // its height is known once it is drawn
  let t = 0;
  const again = () => {
    if (!s.classList.contains('open')) {
      window.removeEventListener('resize', again);
      window.visualViewport?.removeEventListener('resize', again);
      return;
    }
    place();
    // the keyboard slides away over a few frames: once more after it has settled
    clearTimeout(t);
    t = setTimeout(() => s.classList.contains('open') && place(), 250);
  };
  window.addEventListener('resize', again);
  window.visualViewport?.addEventListener('resize', again);
}
/** place(): the card above the button, inside the screen. */
function placeAbove(card, btn, width) {
  const r = btn.getBoundingClientRect();
  const w = Math.min(width, window.innerWidth - 16);
  card.style.width = w + 'px';
  card.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px';
  card.style.top = Math.max(8, r.top - card.getBoundingClientRect().height - 8) + 'px';
}
// the top one: sheets opened over others (the text, choose and picker sheets) come later in the page
const anySheetOpen = () => [...document.querySelectorAll('.sheet.open')].pop() || null;

document.querySelectorAll('.sheet').forEach((s) => {
  s.addEventListener('click', (e) => {
    if ((e.target === s && !s.classList.contains('modal')) || e.target.closest('[data-close]')) openSheet('#' + s.id, false);
  });
});
$('#menu-btn').onclick = () => openDrawer(true);
$('#scrim').onclick = () => openDrawer(false);

// ---------- conversations ----------
async function loadConvs() {
  const stored = await conversations.all();
  // a chat that is already open in the app stays the same object: the chat on screen, a reply that is being written and
  // every later save hold on to it. Swapping in the stored copy would leave two versions of the chat, and the older
  // one (the list's) would be shown – and saved over the newer – the next time the chat is opened.
  const open = new Map((state.convs || []).map((c) => [c.id, c]));
  if (state.current) open.set(state.current.id, state.current);
  state.convs = stored.map((c) => open.get(c.id) || c);
  // a reply that was still being written when the app was closed would otherwise look "writing" forever
  for (const c of state.convs) {
    if (open.get(c.id) === c) continue; // live: its reply may really be writing
    // a quiet check whose run the app did not live to finish: it would have been taken out, so it is now
    const q = unfinishedQuietCheck(c.messages || []);
    if (q >= 0) {
      c.messages.splice(q);
      conversations.put(JSON.parse(JSON.stringify(c))).catch(() => {});
    }
    for (const m of c.messages || []) {
      if (!m.streaming) continue;
      delete m.streaming;
      delete m.live;
      if (!m.content?.trim() && !(m.rounds || []).length) m.error = 'The app was closed before this reply was finished. Tap Retry.';
      // a half-written reply says it was cut off, with Continue, instead of looking finished (decision 172)
      else if (!m.error) m.cut = { reason: 'closed' };
    }
  }
  renderConvList();
}

let showArchived = false;
let listDay = '';
let listStale = false; // a save changed something the shut drawer didn't redraw
const titled = new Map(); // the title each chat had when the list was last drawn
// open on a phone, or always on a wide screen (tablet, unfolded phone) where the drawer sits beside the chat
const listShown = () => document.body.classList.contains('drawer-open') || matchMedia('(min-width: 900px)').matches;
/** Something the list shows changed (a spinner, a dot): redrawn now if you can see the list, else when it opens. */
function convListChanged() {
  if (listShown()) renderConvList();
  else listStale = true;
}
function convItem(c, nested = false) {
  const item = el('div', 'conv-item' + (state.current?.id === c.id ? ' active' : '') + (c.archived ? ' archived' : '') + (nested ? ' in-folder' : ''));
  const title = el('button', 'conv-title');
  title.append(isGroup(c) ? groupAvatar(groupMembers(c), 24) : avatarEl(chatPersona(c).avatar, 22), el('span', 'conv-name', c.title || 'New chat')); // the name is yours: its emoji stay
  if (state.asking.has(c.id)) title.append(el('i', 'ask-mark', '❓'), el('span', 'sr-only', 'waiting for your answer'));
  else if (state.runs.has(c.id)) title.append(el('i', 'run-spin', ''), Object.assign(el('span', 'sr-only', 'writing'), {}));
  else if (state.unseen.has(c.id) && state.current?.id !== c.id) title.append(el('i', 'unseen-dot', ''), el('span', 'sr-only', 'new reply'));
  if (c.pinned) title.append(el('i', 'pin-mark', '📌'));
  if (c.forkOf) {
    title.append(el('i', 'fork-mark', '🌿'));
    title.title = `Forked from “${c.forkOf.title}”`;
  }
  const t = convTime(c);
  if (t) {
    const when = el('time', 'conv-time', shortTime(t));
    when.dateTime = new Date(t).toISOString();
    title.append(when);
  }
  title.onclick = () => {
    selectConv(c.id);
    openDrawer(false);
  };
  const more = el('button', 'conv-more', '⋮');
  more.setAttribute('aria-label', 'Chat options');
  more.onclick = (e) => {
    e.stopPropagation();
    openChatMenu(c, more, { compact: true });
  };
  item.append(title, more);
  return item;
}

/**
 * Roleplay and chats each remember their own selected model: leaving one keeps what was picked there, coming back
 * brings it back (a chat opened afterwards still selects its own last model).
 */
function swapModelFor(from, to) {
  if (from === to) return;
  const by = (state.settings.modelByMode ||= {});
  // Claude Code picked in the picker is remembered the same way (it is a choice for new chats, not a chat's own)
  by[from] = { model: state.settings.model || '', cc: state.settings.ccPick || null };
  const back = by[to];
  if (!back) return saveSettings(state.settings);
  if (back.model && state.models.some((m) => m.id === back.model)) state.settings.model = back.model;
  state.settings.ccPick = back.cc || null;
  saveSettings(state.settings);
  updateModelUI();
}

function setMode(mode, { fresh = true } = {}) {
  const from = appMode;
  setAppMode(mode === 'rp' ? 'rp' : 'chat');
  swapModelFor(from, appMode);
  if (pref('mode') !== appMode) setPref('mode', appMode);
  document.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === appMode));
  $('#drawer-new').textContent = appMode === 'rp' ? '+ New roleplay' : '+ New chat';
  document.body.classList.toggle('mode-rp', appMode === 'rp');
  if (fresh && state.current && convIsRp(state.current) !== (appMode === 'rp')) newChat();
  renderConvList();
  hooks.renderQuickBar?.();
}
document.querySelectorAll('.mode-tab').forEach((t) => (t.onclick = () => setMode(t.dataset.mode)));

// ---------- search across all chats ----------
let convQuery = '';
let convSearchTimer;
$('#conv-search').addEventListener('input', () => {
  clearTimeout(convSearchTimer);
  convSearchTimer = setTimeout(() => {
    convQuery = $('#conv-search').value.trim();
    renderConvList();
  }, 150);
});
function snippetAround(text, i, len) {
  const a = Math.max(0, i - 40);
  const b = Math.min(text.length, i + len + 60);
  return { pre: (a > 0 ? '…' : '') + text.slice(a, i).replace(/\s+/g, ' '), hit: text.slice(i, i + len), post: text.slice(i + len, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '') };
}
function renderConvSearch(list) {
  const q = convQuery.toLowerCase();
  const results = [];
  for (const c of state.convs) {
    const tHit = (c.title || '').toLowerCase().includes(q);
    let first = null;
    let n = 0;
    for (const [mi, m] of (c.messages || []).entries()) {
      const text = typeof m.content === 'string' ? m.content : '';
      const i = text.toLowerCase().indexOf(q);
      if (i < 0) continue;
      n++;
      if (!first) first = { mi, ...snippetAround(text, i, q.length) };
    }
    if (tHit || n) results.push({ c, first, n, tHit });
  }
  // title hits first, then most recent
  results.sort((a, b) => b.tHit - a.tHit || b.c.updatedAt - a.c.updatedAt);
  // and, with smart memory, the chats that are about it in other words (shown under the word matches)
  if (hooks.semanticChats && convQuery.length >= 3) {
    const asked = convQuery;
    const box = el('div', 'meaning-hits');
    list.append(box);
    hooks
      .semanticChats(asked, 8)
      .then((hits) => {
        if (asked !== convQuery || !box.isConnected) return;
        const seen = new Set(results.map((r) => r.c.id));
        const more = hits.filter((h) => !seen.has(h.id)).slice(0, 6);
        if (!more.length) return;
        box.append(el('div', 'conv-section', '≈ About this, in other words'));
        for (const h of more) {
          const c = state.convs.find((x) => x.id === h.id);
          if (!c) continue;
          const b = el('button', 'search-hit-item');
          const head = el('div', 'search-hit-head');
          head.append(avatarEl(chatPersona(c).avatar, 20), el('b', null, c.title || 'New chat'), el('span', 'dim', convIsRp(c) ? '🎭' : '💬'));
          b.append(head, el('div', 'search-snip', h.snippet));
          b.onclick = () => {
            selectConv(c.id);
            openDrawer(false);
          };
          box.append(b);
        }
      })
      .catch(() => {});
  }
  if (!results.length) return list.prepend(el('p', 'hint pad no-hits', `No chat says “${convQuery}”.`));
  const box0 = list.querySelector('.meaning-hits');
  const put = (x) => (box0 ? list.insertBefore(x, box0) : list.append(x));
  put(el('div', 'conv-section', `${results.length} chat${results.length === 1 ? '' : 's'}`));
  for (const r of results.slice(0, 80)) {
    const b = el('button', 'search-hit-item');
    const head = el('div', 'search-hit-head');
    head.append(isGroup(r.c) ? groupAvatar(groupMembers(r.c), 20) : avatarEl(chatPersona(r.c).avatar, 20), el('b', null, r.c.title || 'New chat'), el('span', 'dim', `${convIsRp(r.c) ? '🎭' : '💬'}${r.n ? ` · ${r.n} match${r.n === 1 ? '' : 'es'}` : ''}${r.c.archived ? ' · archived' : ''}`));
    b.append(head);
    if (r.first) {
      const sn = el('div', 'search-snip');
      sn.append(document.createTextNode(r.first.pre), el('mark', null, r.first.hit), document.createTextNode(r.first.post));
      b.append(sn);
    }
    b.onclick = () => {
      selectConv(r.c.id);
      openDrawer(false);
      if (r.n) {
        $('#find-input').value = convQuery;
        setTimeout(openFind, 150);
      }
    };
    put(b);
  }
}

function renderConvList() {
  listStale = false;
  const list = $('#conv-list');
  list.innerHTML = '';
  listDay = new Date().toDateString();
  const mine = state.convs.filter((c) => convIsRp(c) === (appMode === 'rp'));
  if (convQuery) return renderConvSearch(list);
  const active = mine.filter((c) => !c.archived);
  const archived = mine.filter((c) => c.archived);
  const pinned = active.filter((c) => c.pinned).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
  const counts = { chat: state.convs.filter((c) => !c.archived && !convIsRp(c)).length, rp: state.convs.filter((c) => !c.archived && convIsRp(c)).length };
  document.querySelectorAll('.mode-tab').forEach((t) => (t.querySelector('.mode-count').textContent = counts[t.dataset.mode] || ''));
  if (!active.length && !archived.length) {
    list.append(el('p', 'hint pad', appMode === 'rp' ? 'No roleplays yet. Pick a character on the right, or import a character card in 🎭 Personas.' : 'No chats yet.'));
    return;
  }
  if (pinned.length) {
    list.append(el('div', 'conv-section', '📌 Pinned'));
    pinned.forEach((c) => list.append(convItem(c)));
  }
  // folders (of this mode); a chat shows once: pinned first, then in its folder, otherwise under its time (Today, …)
  const folders = folderList();
  const inFolder = new Set();
  for (const f of folders) {
    const chats = active.filter((c) => !c.pinned && c.folderId === f.id);
    chats.forEach((c) => inFolder.add(c.id));
    list.append(folderHeader(f, chats.length));
    if (!f.collapsed) chats.forEach((c) => list.append(convItem(c, true)));
  }
  const rest = active.filter((c) => !c.pinned && !inFolder.has(c.id));
  // each time group is its own box, so its sticky header leaves with it (the next one pushes it up, no overlap)
  for (const g of groupConvs(rest)) {
    const box = el('div', 'conv-group');
    box.dataset.group = g.key;
    box.append(el('div', 'conv-section conv-when', g.label));
    g.items.forEach((c) => box.append(convItem(c)));
    list.append(box);
  }
  if (!active.length) list.append(el('p', 'hint pad', 'No active chats.'));
  if (archived.length) {
    const t = el('button', 'archived-toggle', `${showArchived ? '▾' : '▸'} Archived (${archived.length})`);
    t.onclick = () => {
      showArchived = !showArchived;
      renderConvList();
    };
    list.append(t);
    if (showArchived) archived.sort((a, b) => convTime(b) - convTime(a)).forEach((c) => list.append(convItem(c)));
  }
}

// ---------- folders ----------
const folderMode = () => (appMode === 'rp' ? 'rp' : 'chat');
const folderList = () => (state.settings.folders || []).filter((f) => (f.mode || 'chat') === folderMode());
const folderById = (id) => (state.settings.folders || []).find((f) => f.id === id);
function folderHeader(f, count) {
  const row = el('div', 'folder-row');
  const t = el('button', 'folder-title');
  t.append(el('span', 'folder-caret', f.collapsed ? '▸' : '▾'), el('span', 'folder-name', `📁 ${f.name}`), el('span', 'folder-count', String(count)));
  t.onclick = () => {
    f.collapsed = !f.collapsed;
    saveSettings(state.settings);
    renderConvList();
  };
  const more = el('button', 'conv-more', '⋮');
  more.setAttribute('aria-label', 'Folder options');
  more.onclick = (e) => {
    e.stopPropagation();
    openFolderMenu(f);
  };
  row.append(t, more);
  return row;
}
let menuFolder = null;
function openFolderMenu(f) {
  menuFolder = f;
  $('#fm-title').textContent = `📁 ${f.name}`;
  $('#fm-actions').hidden = false;
  $('#fm-rename-box').hidden = true;
  openSheet('#folder-menu', true);
}
async function newFolder(name, mode = folderMode()) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!n) return null;
  const f = { id: 'f_' + uid().slice(0, 8), name: n, mode, createdAt: Date.now() };
  (state.settings.folders ||= []).push(f);
  saveSettings(state.settings);
  return f;
}
$('#new-folder').onclick = () => {
  $('#nf-input').value = '';
  openSheet('#new-folder-sheet', true);
  $('#nf-input').focus();
};
$('#nf-create').onclick = async () => {
  const f = await newFolder($('#nf-input').value);
  if (!f) return toast('Give the folder a name');
  openSheet('#new-folder-sheet', false);
  renderConvList();
};
$('#nf-input').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), $('#nf-create').click()));
$('#fm-rename').onclick = () => {
  $('#fm-actions').hidden = true;
  $('#fm-rename-box').hidden = false;
  $('#fm-rename-input').value = menuFolder.name;
  $('#fm-rename-input').focus();
};
$('#fm-rename-save').onclick = () => {
  const v = $('#fm-rename-input').value.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!v) return toast('Enter a name');
  menuFolder.name = v;
  saveSettings(state.settings);
  openSheet('#folder-menu', false);
  renderConvList();
};
$('#fm-rename-cancel').onclick = () => {
  $('#fm-rename-box').hidden = true;
  $('#fm-actions').hidden = false;
};
$('#fm-new-chat').onclick = () => {
  const f = menuFolder;
  openSheet('#folder-menu', false);
  openDrawer(false);
  newChat();
  state.current.folderId = f.id;
  toast(`New chat in “${f.name}”`);
};
$('#fm-delete').onclick = async () => {
  const f = menuFolder;
  const inside = state.convs.filter((c) => c.folderId === f.id);
  if (!confirm(`Delete the folder “${f.name}”? ${inside.length ? `Its ${inside.length} chat${inside.length === 1 ? '' : 's'} stay, just not in a folder.` : ''}`)) return;
  for (const c of inside) {
    delete c.folderId;
    await conversations.put(JSON.parse(JSON.stringify(c)));
  }
  if (state.current?.folderId === f.id) delete state.current.folderId;
  state.settings.folders = state.settings.folders.filter((x) => x.id !== f.id);
  saveSettings(state.settings);
  openSheet('#folder-menu', false);
  renderConvList();
};
// the chat menu: move to a folder
function renderFolderPicker() {
  const box = $('#cm-folder-list');
  box.innerHTML = '';
  const mode = convIsRp(menuConv) ? 'rp' : 'chat';
  const folders = (state.settings.folders || []).filter((f) => (f.mode || 'chat') === mode);
  for (const f of folders) {
    const b = el('button', 'menu-item' + (menuConv.folderId === f.id ? ' current' : ''), `${menuConv.folderId === f.id ? '✓ ' : ''}📁 ${f.name}`);
    b.onclick = () => moveToFolder(f.id);
    box.append(b);
  }
  if (menuConv.folderId && folderById(menuConv.folderId)) {
    const b = el('button', 'menu-item', '✕ Remove from its folder');
    b.onclick = () => moveToFolder(null);
    box.append(b);
  }
  if (!folders.length) box.append(el('p', 'hint', 'No folders yet – make one below.'));
}
async function moveToFolder(id) {
  const c = menuConv;
  if (id) c.folderId = id;
  else delete c.folderId;
  openSheet('#chat-menu', false);
  if (isSaved(c)) await saveConv(c);
  else renderConvList();
  toast(id ? `Moved to “${folderById(id)?.name}”` : 'Removed from its folder');
}
$('#cm-folder').onclick = () => {
  $('#cm-actions').hidden = true;
  $('#cm-folder-box').hidden = false;
  $('#cm-folder-new').value = '';
  renderFolderPicker();
};
$('#cm-folder-add').onclick = async () => {
  const f = await newFolder($('#cm-folder-new').value, convIsRp(menuConv) ? 'rp' : 'chat');
  if (!f) return toast('Give the folder a name');
  moveToFolder(f.id);
};
$('#cm-folder-cancel').onclick = () => {
  $('#cm-folder-box').hidden = true;
  $('#cm-actions').hidden = false;
};

// ---------- chat menu: rename / auto-name / archive / delete ----------
let menuConv = null;
let lastAnchor = null;
function openChatMenu(c, anchor = null, { compact = false } = {}) {
  if (!c) return;
  // from the side menu only the chat-list actions (pin, rename, folder, fork, archive, delete); the chat's own ⋮ has everything
  if (compact) $('#chat-menu').dataset.compact = '1';
  else delete $('#chat-menu').dataset.compact;
  lastAnchor = anchor;
  menuConv = c;
  const saved = state.convs.some((x) => x.id === c.id);
  $('#cm-title').textContent = c.title || 'New chat';
  const label = (id, text) => ($(id).querySelector('.cm-label').textContent = text);
  label('#cm-archive', c.archived ? 'Unarchive' : 'Archive');
  label('#cm-pin', c.pinned ? 'Unpin' : 'Pin to top');
  $('#cm-pin').disabled = !saved || !!c.archived;
  $('#cm-archive').disabled = !saved;
  $('#cm-delete').disabled = !saved;
  $('#cm-autoname').disabled = !c.messages?.some((m) => m.role === 'assistant' && m.content);
  $('#cm-compact').disabled = (c.messages?.length || 0) - (c.summary?.upto || 0) < 6;
  $('#cm-to-persona').hidden = !convIsRp(c) || isGroup(c);
  label('#cm-to-persona', `Make a chat persona from ${chatPersona(c).name}`);
  $('#cm-rename-box').hidden = true;
  $('#cm-folder-box').hidden = true;
  $('#cm-export-box').hidden = true;
  label('#cm-folder', c.folderId && folderById(c.folderId) ? `Folder: ${folderById(c.folderId).name}…` : 'Move to a folder…');
  $('#cm-character').hidden = isGroup(c);
  $('#cm-more-list').hidden = true;
  $('#cm-more').setAttribute('aria-expanded', 'false');
  $('#cm-export').disabled = !c.messages?.some((m) => !m.greeting);
  $('#cm-actions').hidden = false;
  openSheet('#chat-menu', true);
  placeMenu(anchor);
}
/** The menu is a small popover under the button that opened it (or in the corner), not a full-width sheet. */
function placeMenu(anchor) {
  const card = $('#chat-menu .sheet-card');
  const W = Math.min(264, window.innerWidth - 16);
  card.style.width = W + 'px';
  const r = anchor?.getBoundingClientRect?.() || { right: window.innerWidth - 8, bottom: 56 };
  card.style.left = Math.max(8, Math.min(window.innerWidth - W - 8, r.right - W)) + 'px';
  card.style.top = Math.max(8, r.bottom + 6) + 'px';
  requestAnimationFrame(() => {
    const h = card.getBoundingClientRect().height;
    const room = window.innerHeight - 12;
    if (parseFloat(card.style.top) + h > room) card.style.top = Math.max(8, room - h) + 'px';
  });
}
$('#cm-more').onclick = () => {
  const open = $('#cm-more-list').hidden;
  $('#cm-more-list').hidden = !open;
  $('#cm-more').setAttribute('aria-expanded', String(open));
  $('#cm-more .cm-chev').textContent = open ? '▴' : '▾';
  if (open) setTimeout(() => $('#cm-more-list').scrollIntoView({ block: 'nearest' }), 30);
  placeMenu(lastAnchor);
};
// shortcuts to the screens that have their own page (the chat has to be the one on screen)
const goTo = (fn) => () => {
  openSheet('#chat-menu', false);
  if (menuConv && state.current?.id !== menuConv.id) selectConv(menuConv.id);
  fn();
};
$('#cm-settings').onclick = goTo(() => hooks.openChatSheet?.());
$('#cm-character').onclick = goTo(() => hooks.openPersonaEditor?.(chatPersona(state.current)?.id));
$('#cm-memory').onclick = goTo(() => hooks.openMemory?.(chatPersona(state.current)?.id));
const isSaved = (c) => state.convs.some((x) => x.id === c.id);
async function saveConv(c) {
  await conversations.put(JSON.parse(JSON.stringify(c)));
  renderConvList();
  if (state.current?.id === c.id) updateHeader();
}
$('#cm-rename').onclick = () => {
  $('#cm-actions').hidden = true;
  $('#cm-rename-box').hidden = false;
  const i = $('#cm-rename-input');
  i.value = menuConv.title || '';
  i.focus();
  i.select();
};
$('#cm-rename-save').onclick = async () => {
  const v = $('#cm-rename-input').value.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!v) return toast('Enter a name');
  menuConv.title = v;
  menuConv.titleSource = 'user';
  openSheet('#chat-menu', false);
  if (isSaved(menuConv)) await saveConv(menuConv);
  else updateHeader();
  toast('Renamed');
};
$('#cm-rename-input').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), $('#cm-rename-save').click()));
$('#cm-rename-cancel').onclick = () => {
  $('#cm-rename-box').hidden = true;
  $('#cm-actions').hidden = false;
};
$('#cm-autoname').onclick = async () => {
  const c = menuConv;
  openSheet('#chat-menu', false);
  toast('Naming…');
  const ok = await autoTitle(c, true);
  toast(ok ? `Named “${c.title}”` : 'Could not create a name');
};
$('#cm-fork').onclick = async () => {
  const c = menuConv;
  openSheet('#chat-menu', false);
  if (!c || !c.messages?.some((m) => !m.greeting)) return toast('Nothing to fork yet');
  if (state.current?.id === c.id) await persist();
  openDrawer(false);
  hooks.forkChat?.(c);
};
$('#cm-pin').onclick = async () => {
  const c = menuConv;
  c.pinned = !c.pinned || undefined;
  c.pinnedAt = c.pinned ? Date.now() : undefined;
  openSheet('#chat-menu', false);
  await saveConv(c);
  toast(c.pinned ? 'Pinned' : 'Unpinned');
};
$('#cm-archive').onclick = async () => {
  const c = menuConv;
  c.archived = !c.archived;
  openSheet('#chat-menu', false);
  await saveConv(c);
  if (c.archived && state.current?.id === c.id) newChat();
  toast(c.archived ? 'Chat archived – find it under “Archived” in the menu' : 'Chat restored');
};
/** A roleplay's memories belong to that chat: deleting the chat deletes them. */
function forgetChatMemories(convId) {
  const before = state.settings.memories.length;
  state.settings.memories = state.settings.memories.filter((m) => m.conv !== convId);
  if (state.settings.memories.length !== before) saveSettings(state.settings);
}
// ---------- export a chat / import chats (Chronicle .json, SillyTavern .jsonl) ----------
$('#cm-export').onclick = () => {
  $('#cm-actions').hidden = true;
  $('#cm-export-box').hidden = false;
};
function exportNames(c) {
  const userN = (state.settings.userPersonas.find((u) => u.id === c.userPersonaId) || state.settings.userPersonas.find((u) => u.id === state.settings.defaultUserPersonaId) || state.settings.userPersonas[0])?.name || 'User';
  const nameOf = (m) => personaById(m.personaId)?.name || chatPersona(c).name;
  const character = isGroup(c) ? c.group.name || groupMembers(c).map((p) => p.name).join(', ') : chatPersona(c).name;
  return { user: userN, nameOf, character };
}
async function exportChat(kind) {
  const c = menuConv;
  const n = exportNames(c);
  const base = (c.title || n.character || 'chat').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 50) || 'chat';
  if (kind === 'json') {
    openSheet('#chat-menu', false);
    try {
      await shareBytes(`${base}.chronicle.json`, new TextEncoder().encode(JSON.stringify(await chronicleExport(c))));
    } catch (e) {
      if (!/cancel/i.test(e?.message || '')) toast('Export failed: ' + e.message);
    }
    return;
  }
  let text = kind === 'st' ? toStChat(c, n) : toReadable(c, { title: c.title || n.character, user: n.user, nameOf: n.nameOf, markdown: kind === 'md' });
  if (kind !== 'st' && text.includes('```map')) {
    // a map is a path into the chat's files: outside the app it is written out as the list of its places
    const files = (await getWorkspace(c.id).catch(() => null))?.files || {};
    text = expandMapBlocks(text, (p) => (files[p] ? new TextDecoder().decode(files[p].data) : null));
  }
  openSheet('#chat-menu', false);
  try {
    await shareBytes(`${base}.${kind === 'st' ? 'jsonl' : kind}`, new TextEncoder().encode(text));
  } catch (e) {
    if (!/cancel/i.test(e?.message || '')) toast('Export failed: ' + e.message);
  }
}
$('#cm-export-md').onclick = () => exportChat('md');
$('#cm-export-txt').onclick = () => exportChat('txt');
$('#cm-export-st').onclick = () => exportChat('st');
$('#cm-export-json').onclick = () => exportChat('json');

/** The Chronicle file of a chat: the chat with copies of its characters (and their pictures), you and its lorebooks. */
async function chronicleExport(c) {
  const pics = {};
  for (const id of chatPersonaIds(c)) if (personaById(id)?.hasArt) pics[id] = await art.get(id).catch(() => null);
  const s = state.settings;
  return buildChatExport(c, { personas: s.personas, userPersonas: s.userPersonas, defaultUserPersonaId: s.defaultUserPersonaId, lorebooks: s.lorebooks, art: pics, memories: s.memories, app: 'Chronicle' });
}

/** Import a Chronicle chat file: characters that are not on this phone are made from the copy inside it. */
async function importChronicleChat(text) {
  const data = parseChatExport(text);
  const s = state.settings;
  const plan = planChatImport(data, { personas: s.personas, userPersonas: s.userPersonas, lorebooks: (s.lorebooks ||= []), newId: uid, newPersonaId, newMemoryId: () => 'm_' + uid().replace(/-/g, '').slice(0, 10) });
  for (const a of plan.art) await art.put(a.id, a.dataUrl).catch(() => {});
  s.personas.push(...plan.addPersonas);
  s.userPersonas.push(...plan.addUserPersonas);
  s.lorebooks.push(...plan.addLorebooks);
  if (plan.memories.length) (s.memories ||= []).push(...plan.memories);
  if (plan.addPersonas.length || plan.addUserPersonas.length || plan.addLorebooks.length || plan.memories.length) saveSettings(s);
  await conversations.put(plan.conv);
  return { conv: plan.conv, made: [], added: plan.made };
}
async function importChatFile(file, forPersona = null) {
  const text = await file.text();
  const kind = detectChatFile(text);
  if (kind === 'chronicle') {
    const r = await importChronicleChat(text);
    // from a character's page: the chat is this character's (a group chat keeps its members)
    if (forPersona && r.conv && !r.conv.group?.members?.length && r.conv.personaId !== forPersona.id) {
      r.conv.personaId = forPersona.id;
      await conversations.put(r.conv);
    }
    return r;
  }
  if (kind === 'st' || /\.jsonl$/i.test(file.name)) return importStChat(file, forPersona);
  throw new Error(/^\s*\{/.test(text) ? 'not a chat file (a character card? import it in 🎭 Personas)' : 'not a Chronicle (.json) or SillyTavern (.jsonl) chat');
}

/** Import a SillyTavern chat: characters are matched by name (a placeholder is made if there's none). */
async function importStChat(file, forPersona = null) {
  const c = parseStChat(await file.text());
  const made = [];
  const lower = (s) => String(s || '').trim().toLowerCase();
  const personaFor = (name) => {
    // from a character's page: the chat's character is that one, whatever the file calls it
    if (forPersona && lower(name) === lower(c.character)) return forPersona;
    let p = state.settings.personas.find((x) => lower(x.name) === lower(name)) || state.settings.personas.find((x) => lower(x.name).split(/\s+/)[0] === lower(name).split(/\s+/)[0]);
    if (!p) {
      p = { id: newPersonaId(), name, avatar: { emoji: '🎭', bg: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] }, description: 'From a SillyTavern chat – import its card to give it a full character', prompt: `You are ${name}.`, rp: true };
      state.settings.personas.push(p);
      made.push(name);
    }
    return p;
  };
  const members = (c.characters.length ? c.characters : [c.character]).map(personaFor);
  const conv = {
    id: uid(),
    title: `${c.character} (imported)`.slice(0, 80),
    titleSource: 'user',
    createdAt: c.created || c.messages[0]?.at || Date.now(),
    updatedAt: Date.now(),
    personaId: members[0].id,
    messages: c.messages.map((m) => {
      if (m.role === 'user') return { role: 'user', content: m.content, at: m.at };
      const pid = personaFor(m.name || c.character).id;
      return { role: 'assistant', content: m.content, at: m.at, personaId: pid, model: '', ...(m.swipes ? { alts: m.swipes.map((s) => ({ content: s, personaId: pid })), altIndex: m.swipeIndex } : {}) };
    }),
  };
  if (members.length > 1) conv.group = { members: members.map((p) => p.id), mode: 'auto', name: '', scenario: '' };
  if (made.length) saveSettings(state.settings);
  await conversations.put(conv);
  return { conv, made };
}
$('#st-import').onclick = () => $('#st-file').click();
// ⤵ Import chat on a character's page: the chats picked next are that character's
let importFor = null;
hooks.importChatFor = (p) => {
  importFor = p;
  $('#st-file').click();
};
$('#st-import').addEventListener('click', () => (importFor = null), true);
$('#st-file').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const forPersona = importFor;
  importFor = null;
  let last = null;
  let n = 0;
  const made = new Set();
  const added = new Set();
  for (const f of files) {
    try {
      const r = await importChatFile(f, forPersona);
      last = r.conv;
      n++;
      r.made.forEach((x) => made.add(x));
      (r.added || []).forEach((x) => added.add(x));
    } catch (err) {
      toast(`${f.name}: ${err.message}`, 5000);
    }
  }
  if (!last) return;
  await loadConvs();
  document.querySelectorAll('.sheet.open').forEach((x) => openSheet('#' + x.id, false));
  openDrawer(false);
  selectConv(last.id); // also switches to its side (💬 Chats or 🎭 Roleplay)
  const notes = [added.size ? `added ${[...added].join(', ')} from the file` : '', made.size ? `no character called ${[...made].join(', ')} yet, so a placeholder was made (import the card to replace it)` : ''].filter(Boolean);
  toast(`Imported ${n > 1 ? `${n} chats` : `“${last.title}”`}${notes.length ? ` – ${notes.join('; ')}` : ''}`, 6000);
};

$('#cm-delete').onclick = async () => {
  const c = menuConv;
  if (!confirm(`Delete “${c.title || 'New chat'}”? This also deletes its files.`)) return;
  openSheet('#chat-menu', false);
  markDeleted(c.id);
  // a Claude Code / PC agent chat: its session goes too (in Claude Code each one is a running process)
  if (c.acp?.sessionId) hooks.acpCloseSession?.(c.acp.agentId, c.acp.sessionId);
  await conversations.remove(c.id);
  vectors.remove(c.id).catch(() => {}); // its search index goes with it
  deleteWorkspace(c.id);
  forgetChatMemories(c.id);
  if (state.current?.id === c.id) newChat();
  await loadConvs();
  toast('Chat deleted');
};
const syncBrowserBtn = () => { $('#browser-view-btn').hidden = !browserOpen(state.current?.id); };
hooks.syncBrowserBtn = syncBrowserBtn;
onBrowserChange(syncBrowserBtn);
$('#browser-view-btn').onclick = async () => { if (!(await viewBrowser(state.current?.id))) toast('No browser page is open in this chat.'); };
$('#chat-more-btn').onclick = () => openChatMenu(state.current, $('#chat-more-btn'));
$('#cm-impersonate').onclick = () => {
  openSheet('#chat-menu', false);
  if (menuConv !== state.current) selectConv(menuConv.id);
  impersonate();
};
$('#cm-to-persona').onclick = () => {
  openSheet('#chat-menu', false);
  makeChatPersona(chatPersona(menuConv), menuConv.messages.some((m) => !m.greeting) ? menuConv : null);
};
$('#cm-compact').onclick = () => {
  openSheet('#chat-menu', false);
  if (menuConv !== state.current) selectConv(menuConv.id);
  compactChat(state.current, { keep: 4 });
};
$('#cm-find').onclick = () => {
  openSheet('#chat-menu', false);
  if (menuConv !== state.current) selectConv(menuConv.id);
  openFind();
};
$('#cm-inspect').onclick = () => {
  openSheet('#chat-menu', false);
  if (menuConv !== state.current) selectConv(menuConv.id);
  openInspector();
};
$('#ctx-inspect').onclick = () => {
  openSheet('#ctx-sheet', false);
  openInspector();
};
$('#ctx-compact').onclick = () => {
  openSheet('#ctx-sheet', false);
  // a Claude Code chat: Claude Code compacts its own context (its /compact, sent as a message)
  if (hooks.agentContext?.()) return hooks.sendClaudeCommand?.('compact');
  compactChat(state.current, { keep: 4 });
};

// ---------- automatic chat names from the chat's model ----------
function cleanTitle(t) {
  return t
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0]
    ?.replace(/^(title|name)\s*[:：-]\s*/i, '')
    .replace(/^["'“”‘’*#`\s]+|["'“”‘’*`.\s]+$/g, '')
    .slice(0, 70);
}

/** Ask the chat's model for a title. force = also when one exists (but never over a user's own name unless forced). */
function autoTitle(conv, force = false) {
  if (!force && (conv.titleSource === 'user' || conv.titleSource === 'auto')) return Promise.resolve(false);
  const user = conv.messages.find((m) => m.role === 'user');
  const reply = conv.messages.find((m) => m.role === 'assistant' && m.content);
  if (!user || !reply || !state.settings.apiKey) return Promise.resolve(false);
  const model = conv.model || state.settings.model;
  const userText = [user.content, ...(user.files || []).map((f) => `[file: ${f.name}]`), user.images?.length ? '[image]' : ''].filter(Boolean).join('\n');
  return new Promise((resolve) => {
    let out = '';
    streamChat(
      state.settings,
      {
        model,
        sessionId: conv.id + '-title',
        temperature: 0.3,
        messages: [
          { role: 'system', content: P('title') },
          { role: 'user', content: `USER: ${userText.slice(0, 2000)}\n\nASSISTANT: ${reply.content.slice(0, 1200)}\n\nTitle:` },
        ],
      },
      {
        onContent: (t) => (out += t),
        onReasoning: () => {},
        onDone: async () => {
          const t = cleanTitle(out);
          if (!t || (conv.titleSource === 'user' && !force)) return resolve(false);
          conv.title = t;
          conv.titleSource = 'auto';
          if (isSaved(conv)) await saveConv(conv);
          resolve(true);
        },
        onError: () => resolve(false),
      },
    );
  });
}

/** A fresh chat. The keyboard only opens when you asked for a new chat yourself (not when switching tabs or at start-up). */
function newChat({ focus = false } = {}) {
  hooks.leaveChat?.(state.current);
  hooks.stopForeground?.(state.current); // a reply that is still writing carries on in the background
  if (typeof setEditing === 'function') setEditing(null);
  $('#usage').textContent = '';
  state.current = { id: uid(), title: '', createdAt: Date.now(), updatedAt: Date.now(), messages: [], personaId: defaultPersona().id };
  // ⚡ Bypass for new chats (Settings › Tools & agent) – agent chats only: a roleplay has no tools to run unasked
  if (pref('bypassDefault') === true && appMode !== 'rp') state.current.permMode = 'bypass';
  hooks.syncRuns?.();
  // roleplay: start on the character grid (like Chats); the greeting appears once you pick someone
  if (appMode !== 'rp') addGreeting(state.current);
  updateHeader();
  hooks.updateModelUI?.(); // a Claude Code chat before: the button shows what this one will use (decision 165)
  updateToolsChip();
  updateFilesChip();
  renderMessages();
  renderConvList();
  if (focus && appMode !== 'rp') $('#input').focus(); // a roleplay starts on the character grid
}

function selectConv(id) {
  if (state.current && state.current.id !== id) {
    hooks.leaveChat?.(state.current);
    hooks.stopForeground?.(state.current); // a reply that is still writing carries on in the background
  }
  setEditing(null);
  const c = state.convs.find((x) => x.id === id);
  if (!c) return;
  state.current = c;
  state.unseen.delete(c.id);
  hooks.syncRuns?.(); // the send button shows whether THIS chat is writing
  if (convIsRp(c) !== (appMode === 'rp')) setMode(convIsRp(c) ? 'rp' : 'chat', { fresh: false });
  updateHeader();
  updateToolsChip();
  getWorkspace(c.id).then(updateFilesChip);
  // the chat's last model becomes the selected one – unless its roleplay preset picked it (that stays the preset's)
  if (c.model && state.models.some((m) => m.id === c.model) && !hooks.presetHere?.(c)?.decides) {
    state.settings.model = c.model;
    saveSettings(state.settings);
  }
  updateModelUI(); // also when nothing was selected: the button shows this chat's preset (or no longer the last chat's)
  renderMessages();
  renderConvList();
  hooks.enterChat?.(c);
}

const deleted = new Set(); // chats deleted in this session: a reply that was still running must not save them back
const chatDeleted = (id) => deleted.has(id);
/** A chat is being deleted: a reply (or a queued message) of it must not bring it back – stop it, and never save it again. */
function markDeleted(id) {
  deleted.add(id);
  state.queues.delete(id);
  state.stopped.add(id); // a recipe stops at this step
  state.runs.get(id)?.cancel?.();
}
async function persist(conv = state.current) {
  const c = conv;
  if (!c || deleted.has(c.id) || !c.messages.some((m) => !m.greeting)) return; // a chat with only a greeting isn't saved yet
  c.updatedAt = Date.now();
  if (!c.title) {
    const first = c.messages.find((m) => m.role === 'user');
    c.title = (first?.content || first?.files?.[0]?.name || 'Image').replace(/\s+/g, ' ').slice(0, 60);
  }
  await conversations.put(c);
  const before = state.convs.map((x) => x.id).join();
  if (!state.convs.some((x) => x.id === c.id)) state.convs.unshift(c);
  state.convs.sort((a, b) => b.updatedAt - a.updatedAt);
  // the list is rebuilt when you can see it, or when a chat moved or arrived; while the drawer is shut and the order is the
  // same (a reply being saved every few seconds), it is only marked stale and rebuilt when the drawer opens (decision 239)
  if (listShown() || before !== state.convs.map((x) => x.id).join() || c.title !== titled.get(c.id)) renderConvList();
  else listStale = true;
  titled.set(c.id, c.title);
  if (c === state.current) updateShortcuts();
}

export { anchorPopover, placeAbove, anySheetOpen, autoTitle, chatDeleted, convListChanged, loadConvs, markDeleted, newChat, openDrawer, openSheet, persist, refreshUsage, renderConvList, resetUsageAt, selectConv, setMode, usageAt };
