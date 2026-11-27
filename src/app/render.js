// Rendering the chat: message bubbles, character art, tool cards, lazy loading, in-chat search,
// the context meter and the HTML preview.
import { mcpDestructive } from '../mcphints.js';
import { fmtResume } from '../autoresume.js';
import { parseChoices, stripChoices } from '../choices.js';
import { art, saveSettings } from '../store.js';
import { cleanPath } from '../sandbox.js';
import { wsPathIn as wsPath } from './wspath.js';
import { fileToPrompt } from '../files.js';
import { renderUserText, previewDoc, hydrateRich } from '../markdown.js';
import { memoryBlock } from '../memory.js';
import { groupBlock } from '../group.js';
import { toolDefs, toolsSystemPrompt, TOOL_LABELS, skillDefs } from '../tools.js';
import { expandMacros, DEFAULT_MAIN, RP_GUIDE } from '../rp.js';
import { avatarEl } from '../personas.js';
import { openSheet, persist } from './chatlist.js';
import { makeSortable } from './sortable.js';
import { fileChip, openModels } from './composer.js';
import { applyRegexScripts } from '../regexscripts.js';
import { $, appMode, cardFor, chatPersona, chatPrompt, convIsRp, copyText, currentModel, el, enabledTools, fmtTokens, fmtUsage, groupMembers, hooks, isGroup, mdOpts, memoryOn, personaById, personas, pref, renderMarkdown, rpPersonaFlag, state, toast, toolsOn, userPersona } from './core.js';
import { undoFileChanges, apiMessages, autoGrow, contextLimit, continueReply, undoMemory, openMsgMenu, editMessage, editReply, loreFor, nextSpeaker, pager, regenerate, rpCtx, storyOn, switchAlt, switchVersion } from './engine.js';
import { openExternal, openImageViewer, openMemory, openWsFile, wsCacheSync } from './extras.js';
import { isCreditsOut } from '../anthropic.js';
import { openChatSheet, openGroupEditor, openPersonaEditor } from './personas-ui.js';
import { openSettings } from './settings.js';

// ---------- messages ----------
const messagesEl = $('#messages');
// Auto-scroll follows a streaming reply only while you're at the bottom. Any scroll *you* make
// (touch, wheel, scrollbar) away from the bottom stops it immediately; scrolling back down or
// tapping the ↓ button resumes it. Our own programmatic scrolls are ignored by the handler.
let stickToBottom = true;
let touching = false;
let ownScroll = 0; // scrollTop we set ourselves
const distFromBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
function setStick(v) {
  stickToBottom = v;
  $('#jump-btn').hidden = v || distFromBottom() < 40;
}
messagesEl.addEventListener('scroll', () => {
  if (Math.abs(messagesEl.scrollTop - ownScroll) < 2 && !touching) return; // caused by scrollBottom()
  setStick(distFromBottom() < 24);
});
messagesEl.addEventListener('touchstart', () => (touching = true), { passive: true });
const endTouch = () => setTimeout(() => (touching = false), 700); // allow for momentum scrolling
messagesEl.addEventListener('touchend', endTouch, { passive: true });
messagesEl.addEventListener('touchcancel', endTouch, { passive: true });
messagesEl.addEventListener('wheel', (e) => e.deltaY < 0 && setStick(false), { passive: true });
$('#jump-btn').onclick = () => {
  setStick(true);
  scrollBottom(true);
};
const scrollBottom = (force) => {
  if (!force && (!stickToBottom || touching)) {
    if (!stickToBottom) $('#jump-btn').hidden = distFromBottom() < 40;
    return;
  }
  if (force) stickToBottom = true; // a forced jump to the end means: stay there
  messagesEl.scrollTop = messagesEl.scrollHeight;
  ownScroll = messagesEl.scrollTop;
  $('#jump-btn').hidden = true;
  // messages off screen are laid out with a guessed height (content-visibility); the ones that come into view at the
  // bottom then grow and push the end down. Follow the end for a few frames until it holds still.
  let n = 0;
  const follow = () => {
    if (!stickToBottom || touching || n++ > 12) return;
    if (distFromBottom() > 2) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      ownScroll = messagesEl.scrollTop;
    }
    requestAnimationFrame(follow);
  };
  if (messagesEl.querySelector('.msg')) requestAnimationFrame(follow); // not on the start screen: that one stays where it is
};

function emptyState() {
  const wrap = el('div', 'empty');
  if (!state.settings.apiKey) {
    wrap.append(el('div', 'empty-logo', 'opencode'));
    wrap.append(el('p', null, 'Add your OpenCode Go API key to start chatting.'));
    const b = el('button', 'primary-btn', 'Open settings');
    b.onclick = () => openSettings('account');
    wrap.append(b);
    return wrap;
  }
  if (isGroup()) {
    const ms = groupMembers();
    wrap.append(groupAvatar(ms, 72));
    wrap.append(el('div', 'empty-name', state.current.group.name || 'Group chat'));
    wrap.append(el('p', 'empty-sub', ms.map((x) => x.name).join(' · ')));
    const scene = ms.find((p) => p.id === state.current.group.sceneId);
    if (scene) wrap.append(el('p', 'hint', `🎬 ${scene.name} is the scenario – it narrates the world and plays everyone you meet.`));
    const lead = ms.find((p) => p.id === state.current.group.mainId);
    if (lead) wrap.append(el('p', 'hint', `⭐ ${lead.name} is the main character – their card sets the scene.`));
    wrap.append(el('p', 'hint', state.current.group.mode !== 'all' ? 'The conversation decides who answers each message. @mention someone to ask them directly.' : 'Everyone answers in turn. @mention someone to ask only them.'));
    const edit = el('button', 'ghost-btn', 'Edit group');
    edit.onclick = () => openGroupEditor();
    const single = el('button', 'ghost-btn', 'Back to a single persona');
    single.onclick = () => {
      delete state.current.group;
      updateHeader();
      renderMessages();
    };
    const row = el('div', 'row gap');
    row.append(edit, single);
    wrap.append(row);
    return wrap;
  }
  const p = chatPersona();
  wrap.append(avatarEl(p.avatar, 64, 'empty-avatar'));
  wrap.append(el('div', 'empty-name', p.name));
  const m = currentModel();
  const mName = hooks.shownModelName?.() || m?.name;
  wrap.append(el('p', 'empty-sub', mName ? `${p.description || 'Custom persona'} · ${mName}` : 'Pick a model to start.'));
  if (!mName) {
    const b = el('button', 'primary-btn', 'Choose model');
    b.onclick = openModels;
    wrap.append(b);
  }
  wrap.append(el('div', 'empty-label', appMode === 'rp' ? 'Roleplay with' : 'Talk to'));
  const row = el('div', 'persona-row');
  const picks = [];
  for (const x of personas().filter((q) => rpPersonaFlag(q) === (appMode === 'rp') || q.id === p.id)) {
    const b = appMode === 'rp' ? charCard(x, x.id === p.id) : el('button', 'persona-pick' + (x.id === p.id ? ' active' : ''));
    b.dataset.pid = x.id;
    if (appMode !== 'rp') b.append(avatarEl(x.avatar, 40), el('span', null, x.name));
    // roleplay: a tap opens the character's page (with Chat / Edit); assistants start straight away
    b.onclick = () => (appMode === 'rp' && hooks.openCharacter ? hooks.openCharacter(x) : setChatPersona(x.id));
    picks.push(b);
  }
  const add = el('button', 'persona-pick add');
  add.append(el('div', 'avatar add-avatar', '+'), el('span', null, 'New'));
  add.onclick = () => openPersonaEditor(null, { rp: appMode === 'rp' });
  const grp = el('button', 'persona-pick add');
  grp.append(el('div', 'avatar add-avatar', '👥'), el('span', null, 'Group'));
  grp.onclick = () => openGroupEditor();
  if (appMode === 'rp') {
    const imp = el('button', 'persona-pick add');
    imp.append(el('div', 'avatar add-avatar', '⤵'), el('span', null, 'Import card'));
    imp.onclick = () => $('#card-file').click();
    row.append(add, imp, grp);
  } else row.append(add, grp);
  // New / Import / Group first, so they stay reachable however many personas there are
  wrap.append(row);
  const reorder = (box) => makeSortable(box, { item: '.persona-pick[data-pid]', onDone: (els) => savePersonaOrder(els.map((e) => e.dataset.pid)) });
  if (appMode === 'rp') {
    const grid = el('div', 'char-grid');
    const sorted = sortCharacters(picks, charSort);
    grid.append(...sorted);
    if (picks.length > 3) wrap.append(charTools(grid, picks));
    wrap.append(grid);
    reorder(grid); // dragging changes "Your order" – it is offered only there (see charTools)
    grid.classList.toggle('no-drag', charSort !== 'own');
    filterCharacters(grid);
  } else {
    row.append(...picks);
    reorder(row);
  }
  return wrap;
}

// ---------- 🎭 the Roleplay start screen: search and sort the characters ----------
let charQuery = ''; // kept while the app is open (the screen is redrawn often)
let charSort = (() => {
  try {
    return localStorage.getItem('ocm-char-sort') || 'own';
  } catch {
    return 'own';
  }
})();
const CHAR_SORTS = [
  ['own', 'Your order'],
  ['recent', 'Recently chatted'],
  ['name', 'Name A–Z'],
  ['added', 'Newest added'],
  ['chats', 'Most chats'],
];
/** What a character card is found by: its name, blurb, tags and creator. */
const charText = (x) => [x.name, x.description, x.card?.creator_notes, x.card?.creator, ...(x.card?.tags || [])].filter((t) => typeof t === 'string').join(' ').toLowerCase();
/** Each character's chats: how many, and when the last one was used. */
function chatStats() {
  const out = new Map();
  for (const c of state.convs || []) {
    const ids = c.group?.members?.length ? c.group.members : [c.personaId];
    for (const id of ids) {
      const s = out.get(id) || { n: 0, last: 0 };
      s.n++;
      s.last = Math.max(s.last, c.updatedAt || c.createdAt || 0);
      out.set(id, s);
    }
  }
  return out;
}
/** The cards (buttons with data-pid) in the chosen order. */
function sortCharacters(cards, how) {
  if (how === 'own') return cards;
  const list = state.settings.personas;
  const at = new Map(list.map((p, i) => [p.id, i])); // a new or imported character is added at the end
  const stats = chatStats();
  const by = {
    name: (a, b) => (personaById(a)?.name || '').localeCompare(personaById(b)?.name || '', undefined, { sensitivity: 'base' }),
    added: (a, b) => (at.get(b) ?? 0) - (at.get(a) ?? 0),
    recent: (a, b) => (stats.get(b)?.last || 0) - (stats.get(a)?.last || 0) || (at.get(a) ?? 0) - (at.get(b) ?? 0),
    chats: (a, b) => (stats.get(b)?.n || 0) - (stats.get(a)?.n || 0) || (at.get(a) ?? 0) - (at.get(b) ?? 0),
  }[how];
  return by ? [...cards].sort((a, b) => by(a.dataset.pid, b.dataset.pid)) : cards;
}
/** Hide the cards that do not match the search (no redraw: typing keeps its place and the keyboard). */
function filterCharacters(grid) {
  const q = charQuery.trim().toLowerCase();
  let shown = 0;
  for (const b of grid.querySelectorAll('.persona-pick[data-pid]')) {
    const hit = !q || q.split(/\s+/).every((w) => charText(personaById(b.dataset.pid) || {}).includes(w));
    b.hidden = !hit;
    if (hit) shown++;
  }
  let none = grid.querySelector(':scope > .char-none');
  if (!shown && q) {
    if (!none) grid.append((none = el('p', 'hint char-none')));
    none.textContent = `No character matches “${charQuery.trim()}”.`;
  } else none?.remove();
  grid.classList.toggle('no-drag', charSort !== 'own' || !!q);
}
/** The search field and the sort menu above the characters. */
function charTools(grid, picks) {
  const bar = el('div', 'char-tools');
  const search = el('input', 'field char-search search-field');
  search.type = 'search';
  search.placeholder = 'Search'; // like Files' search: a longer word is cut off beside the sort menu at a big text size
  search.setAttribute('aria-label', 'Search characters');
  search.value = charQuery;
  search.oninput = () => {
    charQuery = search.value;
    filterCharacters(grid);
  };
  const sort = el('select', 'field char-sort');
  sort.setAttribute('aria-label', 'Sort characters');
  for (const [v, label] of CHAR_SORTS) sort.append(new Option(label, v));
  sort.value = charSort;
  sort.onchange = () => {
    charSort = sort.value;
    try {
      localStorage.setItem('ocm-char-sort', charSort);
    } catch {
      /* the order is kept for this visit only */
    }
    const none = grid.querySelector(':scope > .char-none');
    grid.replaceChildren(...sortCharacters(picks, charSort));
    if (none) grid.append(none);
    filterCharacters(grid);
  };
  bar.append(search, sort);
  return bar;
}

/** The order of the characters/assistants on the start screen is yours: dragged ones take each other's slots. */
function savePersonaOrder(ids) {
  const list = state.settings.personas;
  const slots = ids.map((id) => list.findIndex((p) => p.id === id)).filter((i) => i >= 0).sort((a, b) => a - b);
  const moved = ids.map((id) => list.find((p) => p.id === id)).filter(Boolean);
  slots.forEach((slot, i) => (list[slot] = moved[i]));
  saveSettings(state.settings);
}

/** A Chub-style card: name on top, art on the left, the character's blurb and tags beside it. */
function charCard(x, active) {
  const b = el('button', 'persona-pick char-card' + (active ? ' active' : ''));
  b.append(el('div', 'cc-title', x.name));
  const body = el('div', 'cc-body');
  const art = el('div', 'cc-art');
  if (x.avatar?.image) art.style.backgroundImage = `url("${x.avatar.image}")`;
  else {
    art.style.background = x.avatar?.bg || 'var(--bg-3, #333)';
    art.textContent = x.avatar?.emoji || '🎭';
  }
  const side = el('div', 'cc-side');
  const blurb = (x.description || x.card?.creator_notes || x.card?.description || x.prompt || '').replace(/[#*_`>[\]]+/g, '').replace(/\s+/g, ' ').trim();
  side.append(el('div', 'cc-blurb', blurb || 'No description'));
  const tags = (x.card?.tags || []).filter((t) => typeof t === 'string').slice(0, 4);
  if (tags.length) {
    const tr = el('div', 'cc-tags');
    for (const t of tags) tr.append(el('span', 'cc-tag', t));
    side.append(tr);
  }
  body.append(art, side);
  b.append(body);
  return b;
}

function setChatPersona(id) {
  state.current.personaId = id;
  state.current.systemPrompt = null;
  const onlyGreeting = state.current.messages.every((m) => m.greeting);
  if (onlyGreeting) {
    state.current.messages = [];
    addGreeting(state.current);
  }
  updateHeader();
  if (onlyGreeting) renderMessages();
  else persist();
}

/** Characters with a greeting (first message) open the chat with it; alternate greetings are swipes. */
function addGreeting(conv) {
  if (conv.messages.length) return;
  // a group opens with the scenario card's (or the main character's) first message
  const p = isGroup(conv) ? groupMembers(conv).find((x) => x.id === conv.group.sceneId) || groupMembers(conv).find((x) => x.id === conv.group.mainId) : chatPersona(conv);
  if (!p) return;
  const pc = cardFor(p, conv);
  const greetings = [pc.first_mes, ...(pc.alternate_greetings || [])].filter((g) => g && g.trim());
  if (!greetings.length) return;
  const ctx = rpCtx(conv, p);
  const mk = (g) => ({ content: expandMacros(g, ctx), personaId: p.id, model: '' });
  conv.messages.push({ role: 'assistant', greeting: true, ...mk(greetings[0]), alts: greetings.length > 1 ? greetings.map(mk) : undefined, altIndex: 0 });
}

function groupAvatar(members, size) {
  const g = el('div', 'group-avatar');
  g.style.width = g.style.height = size + 'px';
  members.slice(0, 3).forEach((p, i) => {
    const a = avatarEl(p.avatar, Math.round(size * 0.62));
    a.classList.add('ga-' + i);
    g.append(a);
  });
  return g;
}

// ---------- character art ----------
/** "Character art" chat background: the current roleplay character's full card art. */
let artToken = 0;
hooks.applyChatArt = () => applyChatArt();
/** The art scaled down to about screen size once (full card art can be thousands of pixels; painting that behind
 * a scrolling chat made every send/scroll stall on phones). Cached per picture. */
const screenArt = new Map();
async function screenSized(key, url) {
  if (screenArt.has(key)) return screenArt.get(key);
  let out = url;
  try {
    const img = new Image();
    img.src = url;
    // a huge picture can take very long to decode on a phone: give up and use it as it is
    await Promise.race([img.decode(), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000))]);
    const max = Math.round(Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1));
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    if (s < 1) {
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (blob) out = URL.createObjectURL(blob);
    }
  } catch {
    /* use the original */
  }
  screenArt.set(key, out);
  return out;
}
function applyChatArt() {
  const m = document.getElementById('messages');
  const bg = document.getElementById('chat-bg');
  if (!m) return;
  // chats with assistants and roleplays each have their own background setting
  const kind = state.current && convIsRp(state.current) ? pref('rpBg') : pref('chatBg');
  m.classList.remove('bg-dots', 'bg-grid', 'bg-gradient');
  if (['dots', 'grid', 'gradient'].includes(kind)) m.classList.add('bg-' + kind);
  const p = (kind === 'card' || kind === 'avatar') && state.current && !isGroup() ? chatPersona() : null;
  const t = ++artToken;
  const show = (url) => {
    m.classList.toggle('bg-image', !!url);
    if (bg) bg.hidden = !url;
    if (url && bg) {
      bg.style.setProperty('--bg-url', `url("${url}")`);
      bg.style.setProperty('--bg-dim', String(Number(pref('bgDim')) / 100));
    }
  };
  const set = async (url, key = p?.id) => {
    if (!url) return t === artToken && show(null);
    const k = `${key}:${url.length}:${url.slice(-32)}`;
    // this chat's picture goes up at once (as it is, until the screen-sized copy is ready): the last chat's must
    // never stay behind while a big picture is being resized
    if (t === artToken) show(screenArt.get(k) || url);
    if (screenArt.has(k)) return;
    const small = await screenSized(k, url);
    if (t === artToken) show(small);
  };
  if (!p) return kind === 'image' && state.settings.bgImage ? set(state.settings.bgImage, 'photo') : set(null);
  // "Character avatar": the picture you gave the character; "Character art": its full card picture if it has one
  if (kind === 'card' && p.hasArt) {
    show(p.avatar?.image || null); // until the card art has loaded
    art.get(p.id).then((u) => set(u || p.avatar?.image || null)).catch(() => set(p.avatar?.image || null));
  } else set(p.avatar?.image || null);
}
/** Tap a character's / persona's picture → full-screen preview (full card art when there is one). */
async function openArt(p) {
  if (!p || document.querySelector('.art-view')) return;
  const url = (p.hasArt && (await art.get(p.id).catch(() => null))) || p.avatar?.image;
  const box = el('div', 'art-view');
  if (url) {
    const img = el('img');
    img.src = url;
    img.alt = p.name;
    box.append(img);
  } else {
    const big = avatarEl(p.avatar, 160, 'art-emoji');
    box.append(big);
  }
  const cap = el('div', 'art-cap', p.name);
  // the full blurb (the stored short description is clipped), scrollable
  const full = [p.card?.creator_notes, p.card?.description, p.description].map((t) => String(t || '').trim()).find((t) => t.length > 0) || '';
  const desc = (full.length >= (p.description || '').length ? full : p.description).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  box.append(cap);
  if (desc) {
    const d = el('div', 'art-desc md');
    d.innerHTML = renderMarkdown(desc.slice(0, 12000), mdOpts(false));
    d.onclick = (e) => e.stopPropagation();
    box.append(d);
  }
  const img = box.querySelector('img');
  if (img) {
    // tap the picture: full resolution (scroll around); tap again: fit to screen
    img.onclick = (e) => {
      e.stopPropagation();
      const zoom = !box.classList.contains('zoomed');
      const r = img.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      box.classList.toggle('zoomed', zoom);
      if (zoom) requestAnimationFrame(() => box.scrollTo(fx * box.scrollWidth - box.clientWidth / 2, fy * box.scrollHeight - box.clientHeight / 2));
    };
    img.onload = () => img.naturalWidth && cap.append(el('span', 'art-res', ` · ${img.naturalWidth}×${img.naturalHeight}`));
  }
  const x = el('button', 'art-close', '✕');
  x.setAttribute('aria-label', 'Close');
  x.onclick = (e) => {
    e.stopPropagation();
    closeArt();
  };
  box.append(x);
  box.onclick = () => closeArt();
  document.body.append(box);
}
const closeArt = () => {
  const v = document.querySelector('.art-view');
  if (v) v.remove();
  return !!v;
};


/** Regex scripts that only change what you see (the stored message stays as it is). */
const rxShow = (text, who, personaId) => (state.settings.regexScripts?.length ? applyRegexScripts(text, state.settings.regexScripts, { who, stage: 'display', personaId: personaId || chatPersona(state.current)?.id }) : text);

function updateHeader() {
  applyChatArt(); // first: nothing below may keep the last chat's background up
  hooks.syncBrowserBtn?.();
  hooks.toolsChanged?.(); // a persona can turn tools on by itself (Skill Creator)
  hooks.updatePresetChip?.(); // 🎛 only in roleplays: a new chat or another persona must not keep the last chat's chip
  const slot = $('#persona-avatar');
  slot.innerHTML = '';
  const incog = state.current?.noMemory && pref('useMemory') ? ' 🕶' : '';
  if (isGroup()) {
    const ms = groupMembers();
    slot.append(groupAvatar(ms, 32));
    $('#persona-name').textContent = (state.current.group.name || ms.map((p) => p.name).join(', ')) + incog;
  } else {
    const p = chatPersona();
    slot.append(avatarEl(p.avatar, 30));
    $('#persona-name').textContent = p.name + (state.current?.systemPrompt != null || state.current?.cardOverride ? ' ✎' : '') + incog;
  }
  renderMentionBar();
}

function renderMentionBar() {
  const bar = $('#mention-bar');
  bar.innerHTML = '';
  bar.hidden = !isGroup();
  if (!isGroup()) return;
  const leadId = state.current.group.mainId;
  const sceneId = state.current.group.sceneId;
  for (const p of groupMembers()) {
    const b = el('button', 'mention-chip' + (p.id === sceneId ? ' scene' : p.id === leadId ? ' lead' : ''));
    b.append(avatarEl(p.avatar, 18), el('span', null, '@' + p.name.split(/\s+/)[0]));
    b.onclick = () => {
      const i = $('#input');
      const tag = '@' + p.name.split(/\s+/)[0] + ' ';
      if (!i.value.includes(tag.trim())) i.value = (i.value && !i.value.endsWith(' ') ? i.value + ' ' : i.value) + tag;
      i.focus();
      autoGrow();
    };
    bar.append(b);
  }
  const next = el('button', 'mention-chip next', '▶ Next');
  next.title = 'Let the next member speak without writing anything';
  next.onclick = () => nextSpeaker();
  bar.append(next);
  const add = el('button', 'mention-chip add', '＋');
  add.title = 'Add or remove members';
  add.onclick = () => openGroupEditor();
  bar.append(add);
  const mode = el('span', 'mention-mode', state.current.group.mode !== 'all' ? 'natural replies' : 'everyone replies');
  bar.append(mode);
}

// formatters made once (each toLocale…String call makes a new one: a tenth of opening a long chat, decision 258)
const F_TIME = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const F_DAY = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
const F_DAY_Y = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' });
const F_FULL = new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'medium' });
function fmtTime(at) {
  const d = new Date(at);
  const t = F_TIME.format(d);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${t}`;
  return `${(d.getFullYear() !== now.getFullYear() ? F_DAY_Y : F_DAY).format(d)}, ${t}`;
}
const timeEl = (at) => {
  const t = el('span', 'msg-time', fmtTime(at));
  t.title = F_FULL.format(new Date(at));
  return t;
};

// monochrome line icons for the message actions (the words stay in the page for screen readers and tests)
const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  next: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  retry: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
  speak: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
};
function iconAct(icon, label, onclick, extra = '') {
  const b = el('button', 'act act-icon' + (extra ? ' ' + extra : ''));
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>`;
  b.append(el('span', 'sr-only', label));
  b.setAttribute('aria-label', label);
  b.title = label;
  b.onclick = onclick;
  return b;
}

/** reuse: the node this one replaces – while a reply streams, its finished part is moved over instead of drawn again. */
function messageNode(msg, index, reuse = null) {
  const node = el('div', `msg ${msg.role}${msg.streaming ? ' streaming-msg' : ''}${msg.hidden ? ' ai-hidden' : ''}`);
  node.dataset.mi = index;
  // a message the app itself sent into the chat (an ask_model job that ended, decision 181): a notice, not a user bubble
  if (msg.role === 'user' && msg.fromApp) {
    node.className = 'msg app-note';
    const agent = state.current?.acp ? (state.current.acp.agentId === 'acp_claude_phone' || state.current.acp.cc ? 'Claude Code' : 'the agent') : 'the assistant';
    node.append(el('div', 'app-note-text', `🔔 Chronicle → ${agent}: ${String(msg.content || '').replace(/^\[Message from the Chronicle app, not from the user\]\s*/, '')}`));
    return node;
  }
  if (msg.role === 'user') {
    const bubble = el('div', 'bubble');
    if (msg.recipe) bubble.append(el('div', 'recipe-tag', `🧪 ${msg.recipe.label}`));
    if (msg.images?.length) {
      const imgs = el('div', 'msg-images');
      msg.images.forEach((src, n) => {
        const i = el('img');
        i.src = src;
        i.onclick = () => openImageViewer(src, (msg.imagePaths?.[n] || `image-${n + 1}.jpg`).split('/').pop());
        imgs.append(i);
      });
      bubble.append(imgs);
    }
    if (msg.files?.length) {
      const files = el('div', 'msg-files');
      msg.files.forEach((f) => files.append(fileChip(f)));
      bubble.append(files);
    }
    if (msg.content) {
      const t = el('div', 'user-text md');
      t.innerHTML = renderUserText(rxShow(msg.content, 'user', msg.personaId), mdOpts(false));
      if (t.querySelector('.code-wrap')) bubble.classList.add('has-code');
      bubble.append(t);
    }
    node.append(bubble);
    const actions = el('div', 'msg-actions user-actions');
    const copy = iconAct('copy', 'Copy', () => copyText(msg.content || ''));
    const edit = iconAct('edit', 'Edit', () => editMessage(state.current.messages.indexOf(msg)));
    if (msg.versions?.length > 1) actions.append(pager(msg.vIndex, msg.versions.length, () => switchVersion(index, -1), () => switchVersion(index, 1)));
    const more = el('button', 'act act-more', '⋯');
    more.setAttribute('aria-label', 'More');
    more.onclick = () => openMsgMenu(index);
    actions.append(copy, edit, more);
    if (msg.at) actions.append(timeEl(msg.at));
    node.append(actions);
  } else {
    const p = personaById(msg.personaId) || chatPersona();
    const av = avatarEl(p.avatar, 32, 'msg-avatar');
    av.classList.add('tappable');
    av.onclick = () => openArt(p);
    node.append(av);
    const col = el('div', 'msg-col');
    node.append(col);
    const who = el('div', 'msg-model');
    who.append(el('b', null, p.name));
    if (msg.model) who.append(document.createTextNode(' · ' + modelName(msg.model) + (msg.fallbackFrom ? ` (instead of ${modelName(msg.fallbackFrom)})` : '')));
    if (msg.at && !msg.streaming) who.append(timeEl(msg.at));
    col.append(who);
    const thinking = pref('thinking');
    if (msg.reasoning && thinking !== 'hidden') {
      const det = el('details', 'reasoning');
      if (thinking === 'stream' && msg.streaming && !msg.content) det.open = true;
      det.append(el('summary', null, msg.streaming && !msg.content ? 'Thinking…' : 'Thought process'));
      det.append(el('div', 'reasoning-body', msg.reasoning));
      col.append(det);
    }
    // tool calls in a row (no text between them) are drawn as one folded "N steps" box once there are a few
    let run = [];
    const cache = liveCache(msg);
    const flush = () => {
      col.append(...toolRun(run, cache));
      run = [];
    };
    (msg.rounds || []).forEach((r, ri) => {
      if (r.content?.trim()) {
        flush();
        col.append(roundText(r, cache, ri));
      }
      r.calls.forEach((c, ci) => run.push({ c, k: `${ri}.${ci}` }));
      if (r.auto === 'goal' || r.steer) {
        flush();
        if (r.auto === 'goal') col.append(el('div', 'steer-note goal-note', '🎯 Goal still open – kept working'));
        else if (r.auto === 'check') {
          // which files: so nobody (you, or the next agent reading the chat) has to go looking for "what changed"
          const files = /exactly these files: (.*?) – and ran nothing/.exec(r.steer || '')?.[1] || '';
          col.append(el('div', 'steer-note check-note', `🔎 ${files ? `Wrote ${files}` : 'Files were written'} and ran nothing to check them – sent back once to check (Settings › Tools & agent)`));
        }
        else col.append(el('div', 'steer-note', `↪ You added: ${r.steer}`));
      }
    });
    (msg.live || []).forEach((c, li) => run.push({ c: { ...c, status: 'writing' }, k: `live.${li}` }));
    flush();
    const body = el('div', 'md');
    if (msg.streaming) streamInto(body, msg, reuse);
    else {
      body.innerHTML = renderMarkdown(rxShow(stripChoices(msg.content), 'ai', msg.personaId));
      markWsPaths(body);
    }
    const busyTool = (msg.rounds || []).some((r) => r.calls.some((c) => c.status === 'running')) || msg.live?.length;
    if (msg.streaming && !msg.content && !busyTool && (!msg.reasoning || thinking === 'hidden'))
      body.innerHTML = `<span class="dots"><i></i><i></i><i></i></span>${msg.reasoning ? '<span class="dots-label">thinking</span>' : ''}`;
    col.append(body);
    // pictures the assistant showed you (show_image, decision 225): under the reply, not folded into the tool steps
    const shown = [...(msg.rounds || []).flatMap((r) => r.calls.filter((c) => c.name === 'show_image' && c.display?.shown?.length).map((c) => c.display)), ...(msg.shownImages || [])];
    for (const d of shown) {
      const imgs = el('div', 'msg-images shown-images');
      for (const x of d.shown) {
        const i = el('img');
        i.src = x.url;
        i.alt = x.name;
        i.title = x.path;
        i.onclick = () => openImageViewer(x.url, x.name);
        imgs.append(i);
      }
      col.append(imgs);
      if (d.caption) col.append(el('div', 'shown-caption dim', d.caption));
    }
    const choices = !msg.streaming && index === state.current.messages.length - 1 ? parseChoices(msg.content) : [];
    if (choices.length) {
      const row = el('div', 'choice-chips');
      for (const c of choices) {
        const b = el('button', 'chip choice', c);
        b.onclick = () => hooks.pickChoice?.(c);
        row.append(b);
      }
      col.append(row);
    }
    if (msg.proactive && !msg.streaming) col.append(el('div', 'msg-note proactive-note', '💬 Wrote first, while you were away'));
    if (msg.note && msg.streaming) col.append(el('div', 'msg-note', msg.note));
    if (msg.error) col.append(el('div', 'msg-error', msg.error));
    // out of Anthropic credits (decision 227): top up in the browser, or send it again with another model
    if (msg.error && !msg.streaming && isCreditsOut(msg.error)) {
      const row = el('div', 'msg-resume-row credits-row');
      const bill = el('button', 'act', '💳 Open Billing');
      bill.onclick = () => openExternal('https://platform.claude.com/settings/billing');
      const other = el('button', 'act', '↻ Another model');
      other.title = 'Send it again with a model from another provider';
      other.onclick = () => {
        openMsgMenu(state.current.messages.indexOf(msg));
        document.getElementById('mm-retry-model')?.click();
      };
      row.append(bill, other);
      col.append(row);
    }
    // an agent reply that stopped after some tool steps goes on from them – Retry starts it over (decision 199)
    const resumable = !msg.streaming && hooks.canResume?.(state.current, msg);
    if (resumable && msg.error) {
      const row = el('div', 'msg-resume-row');
      const go = el('button', 'act', '▶ Resume');
      go.title = 'Go on from the steps it finished – they are not run again';
      go.onclick = () => hooks.resumeReply?.();
      const n = (msg.rounds || []).reduce((k, r) => k + r.calls.length, 0);
      row.append(go, el('span', 'dim', ` from its ${n} finished step${n === 1 ? '' : 's'} (Retry starts over)`));
      col.append(row);
    }
    if (msg.error && state.current?.resumeAt && index === state.current.messages.length - 1) {
      const row = el('div', 'msg-resume', `Tries again at ${fmtResume(state.current.resumeAt)}, when your allowance resets. `);
      const x = el('button', 'link-btn', 'Cancel');
      x.onclick = () => hooks.cancelResume?.(state.current);
      row.append(x);
      col.append(row);
    }
    if (msg.cut && !msg.streaming) {
      const note = el('div', 'msg-cut');
      const lim = msg.cut.maxTokens ? ` (${msg.cut.maxTokens} tokens)` : '';
      if (msg.cut.reason === 'length')
        note.append(el('b', null, msg.content?.trim() ? `✂ Cut off – this reply hit its length limit${lim}.` : `✂ No reply – the model used up its length limit${lim} before writing anything.`), el('span', 'dim', ' Raise “Max reply length” in the character’s or this chat’s sampler settings, in Settings › Roleplay › samplers, or the endpoint’s max tokens.'));
      else if (msg.cut.reason === 'closed') note.append(el('b', null, '⚠ The app was closed (or Android stopped it) before this reply was finished.'));
      else if (msg.cut.reason === 'repeat') note.append(el('b', null, '🔁 Stopped: the model kept writing the same words over and over. One copy is kept – Retry, or try another model.'));
      else note.append(el('b', null, '⚠ The connection ended before the reply was finished.'));
      // text was being written when it stopped: Continue finishes the text; stopped between tool steps: Resume
      if (resumable && !msg.content?.trim()) {
        const go = el('button', 'act', '▶ Resume');
        go.onclick = () => hooks.resumeReply?.();
        note.append(go);
      } else if (index === state.current.messages.length - 1 && msg.content?.trim()) {
        const go = el('button', 'act', '↻ Continue');
        go.onclick = continueReply;
        note.append(go);
      }
      col.append(note);
    }
    if (!msg.streaming && msg.checkpoint?.files?.length && !msg.checkpoint.undone) col.append(changesCard(msg.checkpoint.files));
    if (!msg.streaming) {
      const actions = el('div', 'msg-actions');
      actions.append(iconAct('copy', 'Copy', () => copyText(msg.content || '')));
      const here = () => state.current.messages.indexOf(msg); // by message, not by the position it had when drawn
      actions.append(iconAct('edit', 'Edit', () => editReply(here(), node)));
      if (index === state.current.messages.length - 1 && msg.content && !msg.error && !state.current.acp) actions.append(iconAct('next', 'Continue', continueReply)); // an agent's reply: ask it to go on
      if (msg.checkpoint && !msg.checkpoint.undone && !msg.streaming) {
        const undo = iconAct('undo', `Undo ${msg.checkpoint.count} file change${msg.checkpoint.count === 1 ? '' : 's'}`, () => undoFileChanges(msg), 'with-count');
        undo.append(el('span', 'act-count', String(msg.checkpoint.count)));
        actions.append(undo);
      }
      if (msg.alts?.length > 1) actions.append(pager(msg.altIndex, msg.alts.length, () => switchAlt(here(), -1), () => switchAlt(here(), 1), !msg.greeting));
      if (!msg.greeting) actions.append(iconAct('retry', 'Retry', () => (state.stream ? toast('Wait for the reply to finish') : regenerate({ index: here() }))));
      if (hooks.speak && msg.content?.trim()) actions.append(iconAct('speak', 'Read aloud', () => hooks.speak(msg)));
      const more = el('button', 'act act-more', '⋯');
      more.setAttribute('aria-label', 'More');
      more.onclick = () => openMsgMenu(index);
      actions.append(more);
      const u = fmtUsage(msg.usage);
      if (u) actions.append(el('span', 'act-meta', u));
      col.append(actions);
      if (msg.storyNote) {
        const sn = el('button', 'act story-note', '📜 Story memory updated');
        sn.onclick = () => {
          openChatSheet();
          $('#story-box').open = true;
        };
        col.append(sn);
      }
      if (msg.memoryNotes?.length) {
        const det = el('details', 'mem-note');
        det.append(el('summary', null, `🧠 ${(personaById(msg.personaId) || chatPersona()).name} remembered (${msg.memoryNotes.length})`));
        const ul = el('ul');
        msg.memoryNotes.forEach((n) => ul.append(el('li', null, n)));
        const manage = el('button', 'act', 'Manage memory');
        manage.onclick = () => openMemory(msg.personaId);
        det.append(ul, manage);
        if (msg.memoryLog) {
          const undo = el('button', 'act', 'Undo');
          undo.title = 'Forget what this reply taught';
          undo.onclick = () => undoMemory(msg);
          det.append(undo);
        }
        col.append(det);
      }
    }
  }
  // a chat that only has a character's greeting: let the user still pick another character
  if (msg.greeting && index === 0 && state.current?.messages.every((m) => m.greeting) && !isGroup()) {
    const strip = el('div', 'greet-picker');
    strip.append(el('span', 'empty-label', appMode === 'rp' ? 'Roleplay with' : 'Talk to'));
    const row = el('div', 'persona-row compact');
    for (const x of personas().filter((q) => rpPersonaFlag(q) === (appMode === 'rp') || q.id === msg.personaId)) {
      const b = el('button', 'persona-pick' + (x.id === msg.personaId ? ' active' : ''));
      b.append(avatarEl(x.avatar, 34), el('span', null, x.name));
      b.onclick = () => setChatPersona(x.id);
      row.append(b);
    }
    strip.append(row);
    node.classList.add('has-divider');
    node.prepend(strip);
  }
  // the summary divider lives inside the first message that's still sent in full,
  // so messagesEl.children stays index-aligned with conv.messages
  const ws = state.current?.windowStart;
  if (ws && ws === index && ws > (state.current.summary?.upto || 0)) {
    node.classList.add('has-divider');
    const lim = contextLimit(state.current);
    node.prepend(el('div', 'window-divider', `🪟 ${ws} older message${ws === 1 ? '' : 's'} above are no longer sent (${lim.auto ? `kept just under the model's limit: ${fmtTokens(lim.tokens)} tokens` : `this chat is limited to ${fmtTokens(lim.tokens)} tokens`}).${state.current.story?.text ? ' 📜 Story memory keeps the important events.' : storyOn(state.current) ? ' 📜 Story memory will record them.' : ''}`));
  }
  if (state.current?.summary?.upto && state.current.summary.upto === index) {
    node.classList.add('has-divider');
    node.prepend(summaryDivider());
  }
  return node;
}

// ---------- tool cards ----------
// a call's arguments, parsed once per change (the subject and the card both need them, every frame while streaming)
const argsSeen = new WeakMap();
function callArgs(c) {
  const raw = c.arguments || '{}';
  const got = argsSeen.get(c);
  if (got?.raw === raw) return got.a;
  let a = {};
  try {
    a = JSON.parse(raw);
  } catch {
    /* streaming / partial */
  }
  argsSeen.set(c, { raw, a });
  return a;
}
function toolSubject(c) {
  const a = callArgs(c);
  if (c.name === 'web_search') return a.query || '';
  if (c.name === 'places' || c.name === 'phone_status' || c.name === 'phone_control' || c.name === 'take_photo' || c.name === 'notifications' || c.name === 'messages') return c.display?.path || a.category || a.name || a.action || a.what || '';
  if (c.name === 'save_tool') return 'tool_' + (a.name || '');
  if (c.name === 'claude_code') return String(a.task || '').replace(/\s+/g, ' ').slice(0, 80);
  if (c.name.startsWith('mcp_') && mcpDestructive(c.name)) return '⚠ its server says this can delete or overwrite · ' + Object.values(a).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ').slice(0, 70);
  if (c.name.startsWith('tool_') || c.name.startsWith('mcp_')) return Object.values(a).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ').slice(0, 80);
  if (c.name === 'browser') return [a.action, a.url || a.selector || a.text || (a.element != null ? '#' + a.element : '') || a.property].filter(Boolean).join(' ').slice(0, 80);
  if (c.name === 'fetch_url') return (a.urls || []).map((u) => u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)).join(', ');
  if (c.name === 'run_python') return (a.code || c.arguments || '').split('\n').find((l) => l.trim() && !l.startsWith('import') && !l.startsWith('from')) || '';
  return a.path || '';
}

/** The point of a failure in one line: the last line of a Python traceback, or the first line of the message. */
function shortError(c) {
  const raw = String(c.display?.error || c.result || '').replace(/^Error:\s*/i, '').trim();
  if (!raw) return '';
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const pick = /Traceback|File "/.test(raw) ? lines.filter((l) => !/^(File |Traceback|\^|~)/.test(l)).at(-1) : lines[0];
  return (pick || lines[0]).slice(0, 110);
}

/** Which files a reply changed, each with its diff (folded). */
function changesCard(files) {
  const det = el('details', 'changes-card');
  const add = files.reduce((n, f) => n + (f.added || 0), 0);
  const del = files.reduce((n, f) => n + (f.removed || 0), 0);
  const sum = el('summary', null, `📝 ${files.length} file${files.length === 1 ? '' : 's'} changed `);
  sum.append(el('span', 'ch-add', `+${add}`), ' ', el('span', 'ch-del', `−${del}`));
  det.append(sum);
  for (const f of files) {
    const fd = el('details', 'ch-file');
    const s = el('summary', null, f.path + ' ');
    s.append(el('span', 'ch-kind', f.kind === 'created' ? 'new ' : f.kind === 'deleted' ? 'deleted ' : ''), el('span', 'ch-add', f.added ? `+${f.added} ` : ''), el('span', 'ch-del', f.removed ? `−${f.removed}` : ''));
    fd.append(s);
    if (f.diff?.length) fd.append(diffBlock(f.diff));
    else fd.append(el('div', 'hint', f.binary ? 'Binary file' : 'No text changes'));
    det.append(fd);
  }
  return det;
}

/** [{ t: ' ' | '+' | '-' | '…', s }] → a small coloured diff. */
export function diffBlock(ops) {
  const pre = el('pre', 'tool-out tool-diff');
  for (const o of ops) pre.append(el('span', o.t === '+' ? 'd-add' : o.t === '-' ? 'd-del' : o.t === '…' ? 'd-gap' : 'd-same', (o.t === '…' ? '  … ' : o.t + ' ') + (o.s || ' ')));
  return pre;
}

const GROUP_AT = 3; // this many calls in a row fold into one box
const toolName = (c) => (TOOL_LABELS[c.name] || [null, c.name.startsWith('tool_') ? c.name.slice(5) : c.name])[1];

/**
 * A run of tool calls → nodes for the chat. A short run is drawn card by card; a longer one becomes one folded box
 * whose header says how many steps, which tools (browser ×7 · python ×2 …), what is running now and what failed.
 * The pictures calls made stay visible under the box. run: [{ c, k }] (k: a stable key, for keeping the box open).
 */
// A reply still arriving is drawn again on every update (paintMessage). Its earlier rounds' text and its finished tool
// cards do not change any more: each is built once (markdown, code colouring) and copied after that, with the HTML it was
// built as noted, so patchStreaming does not have to read it back either (decision 256). Kept per message by place
// (round n, call n.m) and checked against what it was built from – a Claude Code reply's rounds and calls are new objects
// on every update. Only while it streams: a finished reply is built fresh, so a changed setting (maths, code colours) shows.
const builtOnce = new WeakMap();
let builtSeq = 0; // each build's own number (_v): a "N steps" box is the same as before when all its cards are (258)
function cachedNode(cache, key, of, build) {
  const hit = cache?.get(key);
  if (hit && hit.of.length === of.length && hit.of.every((v, i) => v === of[i])) {
    const n = hit.tpl.cloneNode(true);
    n._src = hit.src;
    n._v = hit.v;
    return n;
  }
  const n = build();
  n._v = ++builtSeq;
  if (!cache) return n;
  const tpl = n.cloneNode(true); // kept as built: the copy on screen gets its emoji turned into icons
  n._src = tpl.outerHTML;
  cache.set(key, { of, tpl, src: n._src, v: n._v });
  return n;
}
// what a finished card's output is compared by: a Claude Code call's display is a new { output } on every update – its
// text is compared; any other display is set once when the call ends, so the object itself (no copy to text, 258)
const displayKey = (d) => {
  if (!d) return null;
  const k = Object.keys(d);
  return k.length === 1 && k[0] === 'output' ? d.output : k.length ? d : null;
};
const liveCache = (msg) => {
  if (!msg.streaming) return null;
  let c = builtOnce.get(msg);
  if (!c) builtOnce.set(msg, (c = new Map()));
  return c;
};
function roundText(r, cache, ri) {
  return cachedNode(cache, 'r' + ri, [r.content], () => {
    const t = el('div', 'md round-text');
    t.innerHTML = renderMarkdown(r.content);
    return t;
  });
}
const FINISHED = new Set(['done', 'error', 'cancelled']);
function toolRun(run, cache = null) {
  if (!run.length) return [];
  const card = ({ c, k }) => {
    const build = () => {
      const d = toolCard(c);
      d.dataset.k = 'c' + k;
      return d;
    };
    // a call still running or being written changes from one update to the next: built each time
    if (!cache || !FINISHED.has(c.status)) {
      const n = build();
      n._v = ++builtSeq;
      return n;
    }
    return cachedNode(cache, 'c' + k, [c.name, c.status, c.statusText, c.arguments, c.result, c.error, displayKey(c.display)], build);
  };
  if (run.length < GROUP_AT) return run.flatMap((x) => [card(x), callGallery(x.c)].filter(Boolean));
  const calls = run.map((x) => x.c);
  const busy = calls.filter((c) => c.status === 'running' || c.status === 'writing');
  const failed = calls.filter((c) => c.status === 'error').length;
  const counts = new Map();
  for (const c of calls) counts.set(toolName(c), (counts.get(toolName(c)) || 0) + 1);
  const det = el('details', `tool-group${busy.length ? ' running' : ''}${failed ? ' has-error' : ''}`);
  det.dataset.k = 'g' + run[0].k;
  const sum = el('summary');
  sum.append(el('span', 'tool-icon', '🛠'), el('span', 'tool-label', `${calls.length} steps`));
  sum.append(el('span', 'tool-subj tg-kinds', [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(' · ')));
  const ms = calls.reduce((t, c) => t + (c.display?.ms || 0), 0);
  sum.append(
    busy.length
      ? el('span', 'tool-status spin', 'working…')
      : el('span', 'tool-status', (failed ? `✗ ${failed} failed · ` : '✓') + (ms ? ` ${(ms / 1000).toFixed(1)}s` : '')),
  );
  // what it is doing right now, so the folded box still shows progress
  const now = busy[busy.length - 1];
  if (now) {
    const line = el('span', 'tg-now');
    const subj = toolSubject(now);
    line.append(el('b', null, toolName(now)), subj ? ' ' + subj.slice(0, 80) : '', now.statusText ? ` – ${now.statusText}` : '');
    sum.append(line);
  }
  det.append(sum);
  const body = el('div', 'tool-group-body');
  for (const x of run) body.append(card(x));
  det.append(body);
  // while the reply streams: the box is told apart by its cards' build numbers – not by reading back its HTML (all its
  // cards) on every update to see whether it changed (258)
  if (cache) det._src = `g:${det.dataset.k}:${[...body.children].map((n) => n._v).join(',')}`;
  const pics = run.map((x) => callGallery(x.c)).filter(Boolean);
  return [det, ...pics];
}

function toolCard(c) {
  const mcpName = c.name.startsWith('mcp_') && c.name !== 'mcp';
  const [icon, label] =
    TOOL_LABELS[c.name] ||
    (c.name.startsWith('tool_') ? ['🧰', c.name.slice(5)] : mcpName ? ['🔌', c.display?.server ? `${c.display.server}: ${c.name.split('_').slice(2).join('_')}` : c.name.slice(4)] : c.name === 'mcp' ? ['🔌', 'MCP'] : ['🛠', c.name]);
  const det = el('details', `tool-card ${c.status || ''}`);
  const sum = el('summary');
  sum.append(el('span', 'tool-icon', icon), el('span', 'tool-label', label));
  const subj = toolSubject(c);
  if (subj) sum.append(el('span', 'tool-subj', subj.slice(0, 80)));
  const st = c.status === 'running' || c.status === 'writing' ? el('span', 'tool-status spin', c.statusText || (c.status === 'writing' ? 'writing…' : 'running…')) : el('span', 'tool-status', c.status === 'error' ? '✗' : c.status === 'cancelled' ? '–' : '✓' + (c.display?.ms ? ` ${(c.display.ms / 1000).toFixed(1)}s` : ''));
  sum.append(st);
  det.append(sum);
  const body = el('div', 'tool-body');
  const d = c.display || {};
  const args = callArgs(c);
  if (c.name === 'save_tool') {
    const code = el('div', 'md');
    code.innerHTML = renderMarkdown('```python\n' + (args.code ?? '') + '\n```', c.status === 'writing');
    body.append(el('div', 'hint', args.description || ''), code);
  } else if (c.name === 'run_python') {
    const code = el('div', 'md');
    code.innerHTML = renderMarkdown('```python\n' + (args.code ?? c.arguments ?? '') + '\n```', c.status === 'writing');
    body.append(code);
    if (d.output) body.append(el('pre', 'tool-out', d.output));
    if (c.status === 'error' && !d.output && c.result) body.append(el('pre', 'tool-out err', c.result.slice(0, 3000))); // the full reason is in here when you open the card
  } else if (c.name === 'run_script') {
    // the program, then each tool call it made (what it was about, and whether it worked), then what it printed
    const code = el('div', 'md');
    code.innerHTML = renderMarkdown('```js\n' + (args.code ?? d.code ?? '') + '\n```', c.status === 'writing');
    body.append(code);
    if (d.steps?.length) {
      body.append(el('div', 'hint', `${d.calls} tool call${d.calls === 1 ? '' : 's'} from the script:`));
      const ul = el('ul', 'todo-list script-steps');
      for (const s of d.steps) ul.append(el('li', s.status === 'error' ? 'todo-pending' : 'todo-done', `${s.status === 'error' ? '✗' : s.status === 'running' ? '…' : '✓'} ${s.name}${s.label ? ' · ' + s.label : ''}`));
      if (d.more) ul.append(el('li', 'dim', `… and ${d.more} more`));
      body.append(ul);
    }
    if (d.output) body.append(el('pre', 'tool-out', d.output.slice(0, 3000)));
    else if (c.result) body.append(el('pre', 'tool-out', c.result.slice(0, 3000)));
  } else if (c.name === 'todo_write' || (d.todos && d.todos.length)) {
    const ul = el('ul', 'todo-list');
    for (const it of d.todos || []) ul.append(el('li', 'todo-' + it.status, `${it.status === 'done' ? '☑' : it.status === 'in_progress' ? '▶' : '☐'} ${it.text}`));
    body.append(ul);
  } else if (c.name === 'ask_user' && d.answer) {
    body.append(el('div', 'hint', `You answered: ${d.answer}`));
  } else if (c.name === 'web_search' && d.results?.length) {
    if (d.engines?.length) body.append(el('div', 'tool-engines', 'via ' + d.engines.join(', ')));
    const ul = el('ul', 'tool-links');
    d.results.forEach((r) => {
      const li = el('li');
      const a = el('a', null, r.title || r.url);
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      li.append(a, el('span', 'dim', ' ' + r.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]));
      ul.append(li);
    });
    body.append(ul);
  } else if ((c.name === 'delegate' || c.name === 'claude_code') && (d.task || args.task)) {
    // what the helper (or Claude Code, decision 167) was asked, which steps it took on its own, and what it answered
    if (c.name === 'claude_code') body.append(el('div', 'hint', `${d.path || 'Claude Code'} · in this chat's files, on your Claude plan`));
    else body.append(el('div', 'hint', `${d.path ? d.path + ' · ' : ''}${{ read: 'may read', full: 'may run code and write' }[d.mode || args.tools] || 'no tools'}`));
    body.append(el('pre', 'tool-out', String(d.task || args.task).slice(0, 600)));
    if (d.steps?.length) {
      const ul = el('ul', 'todo-list');
      const mark = { error: '✗', running: '…', waiting: '⏳', 'not run': '–' };
      for (const s of d.steps) ul.append(el('li', s.status === 'error' || s.status === 'not run' ? 'todo-pending' : 'todo-done', `${mark[s.status] || '✓'} ${s.name}${s.label ? ' · ' + s.label : ''}${s.status === 'not run' ? ' (not run)' : ''}`));
      body.append(ul);
    }
    if (d.output) body.append(el('pre', 'tool-out', d.output.slice(0, 3000)));
    else if (c.result) body.append(el('pre', 'tool-out', c.result.slice(0, 3000)));
  } else if (d.diff?.length) {
    // edit_file / write_file over an existing file: what changed, not the whole result
    if (d.syntax) body.append(el('div', 'tool-syntax', '⚠ ' + d.syntax));
    body.append(diffBlock(d.diff));
  } else if (c.result) body.append(el('pre', 'tool-out', c.result.slice(0, 3000)));
  if (d.error && c.name === 'run_python' && !d.output) body.append(el('pre', 'tool-out err', d.error));
  if (d.files?.length) {
    const files = el('div', 'tool-files');
    d.files.forEach((f) => files.append(wsFileChip(f)));
    body.append(files);
  }
  det.append(body);
  // a failed step stays folded (an opened code box per failure buries the chat); its reason is one line under the title
  if (c.status === 'error') {
    const why = shortError(c);
    if (why) {
      det.classList.add('has-err');
      sum.append(el('span', 'tool-errmsg', why));
    }
  }
  return det;
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', csv: 'text/csv', json: 'application/json', html: 'text/html', txt: 'text/plain', md: 'text/markdown', zip: 'application/zip' };
const mimeOf = (p) => MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream';
// a picture's address for an <img>: the newest 150 used are kept, older ones let go (each held a full copy of its file for
// the whole session, decision 258). A picture already shown stays on screen; drawn again, it gets a new address.
const blobUrls = new Map();
const BLOBS_KEPT = 150;
function wsBlobUrl(convId, path, data) {
  const k = convId + ':' + path + ':' + data.byteLength;
  let u = blobUrls.get(k);
  if (u) blobUrls.delete(k);
  else u = URL.createObjectURL(new Blob([data], { type: mimeOf(path) }));
  blobUrls.set(k, u);
  while (blobUrls.size > BLOBS_KEPT) {
    const [old, url] = blobUrls.entries().next().value;
    blobUrls.delete(old);
    URL.revokeObjectURL(url);
  }
  return u;
}
/** img.src = make() once the picture comes near the screen: a long list of files makes addresses only for what you see. */
let nearScreen = null;
function lazySrc(img, make) {
  if (typeof IntersectionObserver !== 'function') return void (img.src = make());
  nearScreen ||= new IntersectionObserver(
    (list) => {
      for (const e of list) {
        if (!e.isIntersecting) continue;
        nearScreen.unobserve(e.target);
        const m = e.target._make;
        delete e.target._make;
        if (m) e.target.src = m();
      }
    },
    { rootMargin: '300px' },
  );
  img._make = make;
  nearScreen.observe(img);
}

/** Images one tool call made or changed (run_python, saved tools, screenshots). */
function callGallery(c) {
  const ws = state.current && wsCacheSync(state.current.id);
  if (!ws || c.status === 'error' || c.status === 'cancelled' || c.status === 'running' || c.status === 'writing') return null;
  if (!(c.name === 'run_python' || c.name === 'screenshot_page' || c.name === 'take_photo' || c.name.startsWith('tool_'))) return null;
  const paths = [];
  for (const f of c.display?.files || []) {
    const p = String(f).replace(/^\/?workspace\//, '').replace(/^\/+/, '');
    if (IMG_EXT.test(p) && ws.files[p] && !paths.includes(p)) paths.push(p);
  }
  return paths.length ? imageGallery(paths) : null;
}
function imageGallery(all) {
  const paths = all.slice(-8); // a long session can write dozens of intermediate pictures: show the newest
  const g = el('div', 'agent-images' + (paths.length === 1 ? ' one' : ''));
  if (all.length > paths.length) g.append(el('div', 'msg-image-more', `${all.length - paths.length} earlier image${all.length - paths.length === 1 ? '' : 's'} are in the chat's files`));
  for (const p of paths) {
    const b = el('button', 'msg-image');
    const img = el('img');
    img.src = wsBlobUrl(state.current.id, p, wsCacheSync(state.current.id).files[p].data);
    img.alt = p.split('/').pop();
    img.loading = 'lazy';
    b.append(img, el('span', 'msg-image-name', p.split('/').pop()));
    b.onclick = () => openWsFile(p);
    g.append(b);
  }
  return g;
}

function wsFileChip(path) {
  path = cleanPath(path) || path; // "/workspace/x" from a tool → the workspace's own name for it
  const conv = state.current;
  const chip = el('button', 'ws-chip');
  const ws = wsCacheSync(conv.id);
  const f = ws?.files[path];
  if (f && IMG_EXT.test(path)) {
    const img = el('img');
    img.src = wsBlobUrl(conv.id, path, f.data);
    chip.classList.add('img');
    chip.append(img);
  }
  chip.append(el('span', null, path.split('/').pop()));
  chip.onclick = (e) => {
    e.preventDefault();
    openWsFile(path);
  };
  return chip;
}

function summaryDivider() {
  const sum = state.current.summary;
  const d = el('details', 'summary-divider');
  d.append(el('summary', null, `📝 ${sum.upto} earlier messages were ${sum.style === 'structured' ? 'folded into a structured record (no model call)' : 'summarized'} to save context – tap to read`));
  const body = el('div', 'md');
  body.innerHTML = renderMarkdown(sum.text);
  const undo = el('button', 'act', 'Remove summary (send everything again)');
  undo.onclick = () => {
    delete state.current.summary;
    persist();
    renderMessages();
  };
  d.append(body, undo);
  return d;
}

function modelName(id) {
  // a background job on Claude Code (decision 169): "Claude Code · Sonnet"
  if (typeof id === 'string' && id.startsWith('claude-code:')) return `Claude Code · ${hooks.ccModelName?.(id.slice(12)) || id.slice(12)}`;
  return state.models.find((m) => m.id === id)?.name || id;
}

const RENDER_CHUNK = 24;
var renderedFrom = 0;
const msgNode = (i) => messagesEl.querySelector(`:scope > .msg[data-mi="${i}"]`);
const olderObserver = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && renderOlder(), { root: messagesEl, rootMargin: '600px 0px 0px 0px' });
function olderSentinel() {
  const b = el('button', 'older-msgs', `↑ ${renderedFrom} earlier message${renderedFrom === 1 ? '' : 's'}`);
  b.onclick = () => renderOlder();
  setTimeout(() => b.isConnected && olderObserver.observe(b), 400);
  return b;
}
/** Prepend the next chunk of older messages, keeping the visible position. */
function renderOlder(all = false) {
  const sentinel = messagesEl.querySelector(':scope > .older-msgs');
  if (!sentinel || !state.current) return;
  olderObserver.unobserve(sentinel);
  const from = all ? 0 : Math.max(0, renderedFrom - RENDER_CHUNK);
  const frag = document.createDocumentFragment();
  for (let i = from; i < renderedFrom; i++) frag.append(messageNode(state.current.messages[i], i));
  const h0 = messagesEl.scrollHeight;
  const top0 = messagesEl.scrollTop;
  renderedFrom = from;
  sentinel.after(frag);
  sentinel.remove();
  if (renderedFrom > 0) messagesEl.prepend(olderSentinel());
  messagesEl.scrollTop = top0 + (messagesEl.scrollHeight - h0);
}

// While streaming, finished paragraphs are rendered once and cached; only the unfinished tail is
// re-rendered each frame (long replies used to be fully re-parsed and re-highlighted per frame).
const streamMd = new WeakMap();
/**
 * A streaming reply drawn as two parts: the finished paragraphs (.md-done, the same element frame after frame while
 * they do not change, so they are not parsed, styled and laid out again) and the unfinished tail (.md-tail).
 */
function streamInto(body, msg, reuse) {
  const p = streamingParts(msg);
  const prev = reuse?.querySelector('.md > .md-done');
  const done = el('div', 'md-done');
  done.dataset.n = String(p.parts.length);
  done.dataset.k = String(p.key);
  const have = prev ? Number(prev.dataset.n) || 0 : -1;
  // the one on screen holds the first parts of this one: it stays, and only the newly finished parts are added to it
  if (prev && have <= p.parts.length && prev.dataset.k === String(have ? p.ends[have - 1] : 0)) {
    done.dataset.keep = '1';
    done._add = p.parts.slice(have); // see patchStreaming
    done._html = p.parts; // for when it cannot stay after all
  } else fillParts(done, p.parts);
  const tail = el('div', 'md-tail');
  tail.innerHTML = p.tail;
  body.append(done, tail);
}
function fillParts(done, parts) {
  done.replaceChildren(
    ...parts.map((h) => {
      const d = el('div', 'md-part');
      d.innerHTML = h;
      return d;
    }),
  );
}
function streamingHtml(msg) {
  const p = streamingParts(msg);
  return p.parts.join('') + p.tail;
}
/**
 * A streaming reply in finished parts (each rendered once, when it was finished) and the unfinished tail.
 * → { parts: [html], ends: [length of the text each part ends at], key: finished length, tail: html }
 */
function streamingParts(msg) {
  const text = msg.content || '';
  let c = streamMd.get(msg);
  if (!c || !text.startsWith(c.prefix)) c = { prefix: '', parts: [], ends: [] };
  // newest blank line that's outside a code fence / display math → everything before it is final (the finished part
  // is balanced, so only the text after it needs counting)
  let cut = c.prefix.length;
  for (let i = text.lastIndexOf('\n\n'); i > c.prefix.length; i = text.lastIndexOf('\n\n', i - 1)) {
    const head = text.slice(c.prefix.length, i);
    if ((head.match(/^\s*(```|~~~)/gm) || []).length % 2 === 0 && (head.match(/\$\$/g) || []).length % 2 === 0) {
      cut = i + 2;
      break;
    }
  }
  if (cut > c.prefix.length + 400 || (cut > c.prefix.length && !c.prefix)) {
    const seg = text.slice(c.prefix.length, cut);
    c = { prefix: text.slice(0, cut), parts: [...c.parts, renderMarkdown(stripChoices(seg), false)], ends: [...c.ends, cut] };
    streamMd.set(msg, c);
  }
  return { parts: c.parts, ends: c.ends, key: c.prefix.length, tail: renderMarkdown(stripChoices(text.slice(c.prefix.length)), true) };
}

// the device self-test (src/perfsim.js) times these on the phone
globalThis.__ocmRenderTest = { messageNode, streamingHtml, patchStreaming };

let renderedConv = null;
function renderMessages({ all = false } = {}) {
  if (findHits.length || !$('#find-bar').hidden) setTimeout(() => !$('#find-bar').hidden && runFind(), 0);
  // the same chat drawn again: code boxes you opened stay open
  const before = new Map();
  if (renderedConv === state.current) messagesEl.querySelectorAll('.code-wrap.expanded, .code-wrap[data-wrap-touched]').forEach((b) => {
    const m = b.closest('.msg[data-mi]');
    if (m) before.set(m.dataset.mi, m);
  });
  renderedConv = state.current;
  messagesEl.innerHTML = '';
  messagesEl.classList.toggle('rp-on', !!(pref('rpColors') && state.current && convIsRp(state.current)));
  if (state.current) {
    try {
      apiMessages(state.current, { agent: toolsOn(state.current) }); // sets windowStart for the divider
    } catch {
      /* ignore */
    }
  }
  const msgs = state.current?.messages || [];
  if (!msgs.length) messagesEl.append(emptyState());
  // long chats: render only the newest messages; older ones load when you scroll up
  renderedFrom = all ? 0 : Math.max(0, msgs.length - RENDER_CHUNK);
  if (renderedFrom > 0) messagesEl.append(olderSentinel());
  for (let i = renderedFrom; i < msgs.length; i++) {
    const node = messageNode(msgs[i], i);
    const old = before.get(String(i));
    if (old) keepCodeBoxes(old, node);
    messagesEl.append(node);
  }
  scrollBottom(true);
  if (!msgs.length) {
    // the start screen is read from the top: on a short phone it does not fit, and it opened scrolled to its end
    // with the persona's picture and name cut off
    messagesEl.scrollTop = 0;
    ownScroll = 0;
  }
  updateContextChip();
  hooks.updateSend?.();
}

// ---------- search in this chat ----------
var findHits = [];
var findPos = -1;
const hlOk = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
function openFind() {
  $('#find-bar').hidden = false;
  document.body.classList.add('finding');
  $('#find-input').focus();
  $('#find-input').select();
  if ($('#find-input').value) runFind();
}
function closeFind() {
  $('#find-bar').hidden = true;
  document.body.classList.remove('finding');
  findHits = [];
  findPos = -1;
  if (hlOk) {
    CSS.highlights.delete('find');
    CSS.highlights.delete('find-cur');
  }
  document.querySelectorAll('.msg.find-cur').forEach((n) => n.classList.remove('find-cur'));
  $('#find-count').textContent = '';
}
function runFind() {
  const q = $('#find-input').value.trim().toLowerCase();
  if (q && renderedFrom > 0) renderOlder(true);
  findHits = [];
  findPos = -1;
  document.querySelectorAll('.msg.find-cur').forEach((n) => n.classList.remove('find-cur'));
  if (hlOk) CSS.highlights.delete('find');
  if (!q) {
    $('#find-count').textContent = '';
    return;
  }
  // text ranges inside rendered messages (skips buttons, thinking and tool output)
  for (const node of messagesEl.querySelectorAll('.msg')) {
    const roots = node.querySelectorAll(':scope .bubble, :scope .msg-col > .md, :scope .round-text');
    for (const root of roots) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        const text = t.data.toLowerCase();
        for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
          const r = document.createRange();
          r.setStart(t, i);
          r.setEnd(t, i + q.length);
          findHits.push({ range: r, node });
        }
      }
    }
  }
  if (hlOk) CSS.highlights.set('find', new Highlight(...findHits.map((h) => h.range)));
  if (!findHits.length) {
    $('#find-count').textContent = '0';
    return;
  }
  findPos = findHits.length; // start from the newest match
  stepFind(-1);
}
function stepFind(dir) {
  if (!findHits.length) return;
  findPos = (findPos + dir + findHits.length) % findHits.length;
  const h = findHits[findPos];
  document.querySelectorAll('.msg.find-cur').forEach((n) => n.classList.remove('find-cur'));
  h.node.classList.add('find-cur');
  if (hlOk) CSS.highlights.set('find-cur', new Highlight(h.range));
  setStick(false);
  const rect = h.range.getBoundingClientRect();
  const box = messagesEl.getBoundingClientRect();
  messagesEl.scrollTo({ top: messagesEl.scrollTop + rect.top - box.top - box.height / 3, behavior: 'smooth' });
  $('#find-count').textContent = `${findPos + 1}/${findHits.length}`;
}
let findTimer;
$('#find-input').addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(runFind, 200);
});
$('#find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    stepFind(e.shiftKey ? 1 : -1);
  } else if (e.key === 'Escape') closeFind();
});
$('#find-prev').onclick = () => stepFind(-1);
$('#find-next').onclick = () => stepFind(1);
$('#find-close').onclick = closeFind;

// ---------- context window meter ----------
const estTokens = (s) => Math.ceil((s || '').length / 3.6);
const IMAGE_TOKENS = 1100; // rough cost of one resized image

/** Estimate what the next request would contain, split into parts. */
function contextBreakdown(conv = state.current) {
  const persona = isGroup(conv) ? groupMembers(conv)[0] || chatPersona(conv) : chatPersona(conv);
  const agent = toolsOn(conv);
  const wsCount = wsCacheSync(conv.id) ? Object.keys(wsCacheSync(conv.id).files).length : 0;
  const parts = { persona: 0, memory: 0, tools: 0, messages: 0, files: 0, toolResults: 0, images: 0 };
  parts.persona = estTokens(isGroup(conv) ? persona.prompt + groupBlock(persona, groupMembers(conv), conv.group.scenario) : chatPrompt(conv));
  if (memoryOn(conv)) parts.memory = estTokens(memoryBlock(state.settings.memories, persona.id, conv.id, { rp: convIsRp(conv), limit: pref('memLimit'), query: conv.messages.slice(-3).map((x) => x.content || '').join('\n') }));
  parts.summary = estTokens(conv.summary?.text);
  const lb = loreFor(conv, persona);
  parts.lore = estTokens(lb.text + lb.depth.map((d) => d.content).join(''));
  if (persona?.cardMode && persona.card) {
    const c = cardFor(persona, conv);
    parts.persona = estTokens([DEFAULT_MAIN, RP_GUIDE, c.system_prompt, c.description, c.personality, c.scenario, c.mes_example, c.depth_prompt?.prompt, c.post_history_instructions].filter(Boolean).join('\n'));
  }
  parts.persona += estTokens(userPersona(conv)?.description || '') + estTokens(conv.authorsNote?.text || '');
  if (agent) parts.tools = estTokens(toolsSystemPrompt({ ...enabledTools(), bypass: state.current.permMode === 'bypass' }, wsCount, state.current.phoneFolder, hooks.agentMode?.(state.current), state.current.lastReview) + JSON.stringify(toolDefs(enabledTools(), enabledTools().python ? skillDefs(state.settings.skills) : [])));
  parts.story = estTokens(conv.story?.text);
  for (const m of conv.messages.slice(Math.max(conv.summary?.upto || 0, conv.windowStart || 0))) {
    if (m.role === 'user') {
      parts.messages += estTokens(m.content);
      for (const f of m.files || []) parts.files += estTokens(fileToPrompt(f, agent));
      parts.images += (m.images?.length || 0) * IMAGE_TOKENS;
    } else {
      parts.messages += estTokens(m.content);
      for (const r of m.rounds || []) {
        parts.messages += estTokens(r.content);
        for (const c of r.calls) parts.toolResults += estTokens(c.arguments) + estTokens(c.result);
      }
    }
  }
  const off = new Set(conv.ctxOff || []);
  const full = { memory: parts.memory, lore: parts.lore, story: parts.story, examples: persona?.cardMode && persona.card ? estTokens(cardFor(persona, conv).mes_example) : 0 };
  for (const k of off) if (k in parts) parts[k] = 0;
  if (off.has('examples')) parts.persona = Math.max(0, parts.persona - full.examples);
  for (const m of conv.messages.slice(Math.max(conv.summary?.upto || 0, conv.windowStart || 0))) {
    if (!m.hidden) continue;
    parts.messages -= estTokens(m.content);
    for (const f of m.files || []) parts.files -= estTokens(fileToPrompt(f, agent));
    parts.images -= (m.images?.length || 0) * IMAGE_TOKENS;
    for (const r of m.rounds || []) {
      parts.messages -= estTokens(r.content);
      for (const c of r.calls) parts.toolResults -= estTokens(c.arguments) + estTokens(c.result);
    }
  }
  for (const k of ['messages', 'files', 'images', 'toolResults']) parts[k] = Math.max(0, parts[k]);
  const pending = state.pending.reduce((n, a) => n + (a.kind === 'image' ? IMAGE_TOKENS : estTokens(a.text)), 0) + estTokens($('#input').value);
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts, total, pending, persona, full, off };
}

/** Current context: the real count from the last reply if it used this model, else an estimate. */
function contextNow(conv = state.current) {
  const b = contextBreakdown(conv);
  const lastA = [...conv.messages].reverse().find((m) => m.role === 'assistant' && !m.streaming);
  const lastIdx = lastA ? conv.messages.lastIndexOf(lastA) : -1;
  const afterLast = conv.messages.slice(lastIdx + 1).filter((m) => m.role === 'user');
  const exact = lastA?.ctx && lastA.ctx.model === state.settings.model && !isGroup(conv) && !(conv.summary && conv.summary.at > lastA.ctx.at);
  // real count of the last request + estimate for anything added since
  const tokens = exact ? lastA.ctx.tokens + afterLast.reduce((n, m) => n + estTokens(m.content) + (m.files || []).reduce((k, f) => k + estTokens(fileToPrompt(f, toolsOn(conv))), 0), 0) : b.total;
  return { tokens, exact, breakdown: b };
}

// the estimate walks the whole prompt, so it runs just after the screen has been painted
let chipTimer = null;
function updateContextChip() {
  clearTimeout(chipTimer);
  chipTimer = setTimeout(updateContextChipNow, 40);
}
hooks.updateContextChip = updateContextChip;
/** Add the newest message to the screen without redrawing the whole (long) chat. */
function appendMessage(i) {
  if (i === 0 || !messagesEl.querySelector('.msg')) return renderMessages();
  paintMessage(i);
  scrollBottom(true);
  hooks.updateSend?.();
  updateContextChip();
}
/**
 * A chat with Claude Code (or a PC agent): the agent keeps its own context and compacts it itself – none of Chronicle's
 * limits (the model selected for other chats, Settings' or the persona's cap, the sliding window) apply. The chip shows
 * what the agent last reported, else its model's window.
 */
function agentContext(conv = state.current) {
  if (!conv?.acp && !hooks.ccShown?.()) return null;
  const r = conv.acp?.ctx;
  return { used: r ? r.used : null, size: r?.size || hooks.ccWindow?.() || 0, name: conv.acp && !conv.acp.cc ? 'The agent' : 'Claude Code' };
}
hooks.agentContext = agentContext;
function updateContextChipNow() {
  const chip = $('#ctx-btn');
  if (!chip || !state.current) return;
  const ag = agentContext();
  if (ag) {
    chip.hidden = !ag.size && ag.used == null;
    const pct = ag.size && ag.used != null ? ag.used / ag.size : 0;
    chip.textContent = `${ag.used == null ? '–' : fmtTokens(ag.used)} / ${ag.size ? fmtTokens(ag.size) : '?'}`;
    chip.title = `${ag.name}'s own context${ag.used == null ? ' (reported after its first reply)' : ''}`;
    chip.classList.toggle('warn', pct >= 0.8 && pct < 0.95);
    chip.classList.toggle('full', pct >= 0.95);
    chip.style.setProperty('--pct', Math.min(100, pct * 100).toFixed(1) + '%');
    return;
  }
  const m = currentModel();
  const lim = contextLimit(state.current);
  const max = lim.tokens;
  if (!max) return (chip.hidden = true);
  const { tokens, exact } = contextNow();
  const pct = tokens / max;
  chip.hidden = false;
  chip.textContent = `${lim.windowed ? '🪟 ' : ''}${exact ? '' : '~'}${fmtTokens(Math.min(tokens, lim.windowed ? max : Infinity))} / ${fmtTokens(max)}`;
  chip.title = lim.windowed ? `Sliding window: the chat is limited to ${fmtTokens(max)} tokens (model allows ${fmtTokens(lim.max)})` : `Context: ${Math.round(pct * 100)}% of ${m?.name}'s window`;
  chip.classList.toggle('warn', pct >= 0.8 && pct < 0.95);
  chip.classList.toggle('full', pct >= 0.95);
  chip.style.setProperty('--pct', Math.min(100, pct * 100).toFixed(1) + '%');
}

function toggleBtn(key, isOff) {
  const b = el('button', 'ctx-toggle', isOff ? 'Include' : 'Drop');
  b.title = isOff ? 'Send this part to the AI again' : 'Stop sending this part (nothing is deleted)';
  b.onclick = () => {
    const set = new Set(state.current.ctxOff || []);
    if (isOff) set.delete(key);
    else set.add(key);
    state.current.ctxOff = [...set];
    if (!set.size) delete state.current.ctxOff;
    persist();
    updateContextChip();
    openContextSheet();
  };
  return b;
}

/**
 * The context sheet of a Claude Code (or PC agent) chat (decision 173): the same sheet, with what the agent reported –
 * its own context, which Chronicle's limits, breakdown and prompt do not describe.
 */
function openAgentContextSheet(ag) {
  const pct = ag.size && ag.used != null ? ag.used / ag.size : 0;
  const model = hooks.ccShown?.()?.name;
  $('#ctx-model').textContent = `${ag.name}${model && ag.name === 'Claude Code' ? ` · ${model.replace(/^Claude Code · /, '')}` : ''} · context window ${ag.size ? fmtTokens(ag.size) : 'unknown'} tokens`;
  $('#ctx-total').textContent = ag.used == null ? 'Not reported yet' : `${ag.used.toLocaleString()} tokens used · ${Math.round(pct * 1000) / 10}%`;
  const at = state.current.acp?.ctx?.at;
  $('#ctx-source').textContent = ag.used == null ? `${ag.name} reports its context after its first reply.` : `As ${ag.name} reported it after its last reply${at ? ` (${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}.`;
  const fill = $('#ctx-bar');
  fill.innerHTML = '';
  const seg = el('i');
  seg.style.width = Math.min(100, pct * 100) + '%';
  seg.style.background = pct >= 0.95 ? 'var(--danger)' : pct >= 0.8 ? '#e0a43a' : '#3b82f6';
  fill.append(seg);
  const rows = $('#ctx-rows');
  rows.innerHTML = '';
  for (const [label, num] of [
    [`Kept by ${ag.name}: its own instructions and tools, this chat's messages and what its tools returned`, ag.used == null ? '–' : fmtTokens(ag.used)],
    ["Chronicle's context cap, sliding window and auto-compact", "don't apply"],
  ]) {
    const row = el('div', 'ctx-row');
    row.append(el('span', 'ctx-label', label), el('span', 'ctx-num', num));
    rows.append(row);
  }
  const cc = ag.name === 'Claude Code';
  $('#ctx-tips').textContent = pct > 0.7 ? `${ag.name} compacts its context by itself when it is nearly full.${cc ? ' To do it now, use Compact below (Claude Code’s /compact).' : ''}` : '';
  const compact = $('#ctx-compact');
  compact.hidden = !cc;
  compact.textContent = '📝 Compact now – Claude Code’s /compact';
  compact.disabled = !!state.stream || ag.used == null;
  $('#ctx-inspect').hidden = true; // no Chronicle prompt to inspect: Claude Code builds its own
  openSheet('#ctx-sheet', true);
}

function openContextSheet() {
  const ag = hooks.agentContext?.();
  if (ag) return openAgentContextSheet(ag);
  $('#ctx-compact').hidden = false;
  $('#ctx-compact').textContent = '📝 Compact now – summarize older messages';
  $('#ctx-inspect').hidden = false;
  const m = currentModel();
  const lim = contextLimit(state.current);
  const max = lim.tokens || 0;
  const { tokens, exact, breakdown } = contextNow();
  const { parts, pending, persona, full, off } = breakdown;
  $('#ctx-model').textContent = `${m?.name || 'Model'} · context window ${fmtTokens(lim.max)} tokens${lim.windowed ? ` · 🪟 this chat is limited to ${fmtTokens(max)} (oldest messages slide out)` : ''}${m?.limit?.output ? ` · max reply ${fmtTokens(m.limit.output)}` : ''}`;
  $('#ctx-total').textContent = `${exact ? '' : '~'}${tokens.toLocaleString()} tokens used · ${max ? Math.round((tokens / max) * 1000) / 10 : 0}%`;
  $('#ctx-source').textContent = exact
    ? 'Exact count reported by the model for the last request (plus an estimate for anything you sent since).'
    : 'Estimate (about 3.6 characters per token) – the exact count appears after the next reply.';
  const fill = $('#ctx-bar');
  fill.innerHTML = '';
  const rows = $('#ctx-rows');
  rows.innerHTML = '';
  const labels = [
    ['persona', isGroup() ? `Persona & group prompt (${persona.name})` : `System prompt (${persona.name}${state.current.systemPrompt != null ? ', custom' : ''})`, '#8b5cf6'],
    ['memory', 'Memories', '#ec4899'],
    ['summary', 'Summary of earlier messages', '#64748b'],
    ['story', 'Story memory', '#0ea5e9'],
    ['lore', 'World info (lorebook entries)', '#a855f7'],
    ['tools', 'Tool instructions & definitions', '#14b8a6'],
    ['messages', `Messages (${state.current.messages.length})`, '#3b82f6'],
    ['files', 'Attached files', '#f97316'],
    ['images', 'Images', '#eab308'],
    ['toolResults', 'Tool calls & results', '#22c55e'],
  ];
  const est = Object.values(parts).reduce((a, b) => a + b, 0) || 1;
  for (const [k, label, color] of labels) {
    if (!parts[k] && !(off.has(k) && full[k])) continue;
    const seg = el('i');
    seg.style.width = (max ? (parts[k] / est) * Math.min(1, tokens / max) * 100 : 0) + '%';
    seg.style.background = color;
    fill.append(seg);
    const row = el('div', 'ctx-row');
    const dot = el('span', 'ctx-dot');
    dot.style.background = color;
    row.append(dot, el('span', 'ctx-label', label), el('span', 'ctx-num', off.has(k) ? 'off' : '~' + fmtTokens(parts[k])));
    if (full[k]) row.append(toggleBtn(k, off.has(k)));
    if (off.has(k)) row.classList.add('off');
    rows.append(row);
  }
  {
    if (full.examples) {
      const row = el('div', `ctx-row${off.has('examples') ? ' off' : ''}`);
      row.append(el('span', 'ctx-dot'), el('span', 'ctx-label', 'Example dialogues'), el('span', 'ctx-num', off.has('examples') ? 'off' : '~' + fmtTokens(full.examples)), toggleBtn('examples', off.has('examples')));
      rows.append(row);
    }
  }
  const hiddenN = state.current.messages.filter((x) => x.hidden).length;
  if (hiddenN) {
    const row = el('div', 'ctx-row');
    const b = el('button', 'ghost-btn small', 'Show all again');
    b.onclick = () => {
      state.current.messages.forEach((x) => delete x.hidden);
      persist();
      renderMessages();
      updateContextChip();
      openContextSheet();
    };
    row.append(el('span', 'ctx-label', `🙈 ${hiddenN} message${hiddenN === 1 ? '' : 's'} hidden from the AI`), b);
    rows.append(row);
  }
  if (pending) rows.append(el('div', 'ctx-row pending', `+ ~${fmtTokens(pending)} in the message you’re writing`));
  const tips = [];
  if (max && tokens / max > 0.7) tips.push('The chat is getting long. Start a new chat (memories carry over) or switch to a model with a bigger window.');
  if (parts.files > est * 0.4) tips.push('Attached files take most of the space. With 🛠 Tools on, large files are read on demand instead of being pasted in full.');
  if (parts.toolResults > est * 0.4) tips.push('Tool results (searches, Python output) take a lot of space.');
  $('#ctx-tips').textContent = tips.join(' ');
  $('#ctx-compact').disabled = state.current.messages.length - (state.current.summary?.upto || 0) < 4 || !!state.stream;
  openSheet('#ctx-sheet', true);
}

// Repaints are batched per animation frame. Every message that asked for a repaint is remembered, not
// just "the last one at frame time": in group chats one speaker finishes and the next starts within the
// same frame, and the finished reply must still get its final repaint.
let rafPending = false;
const PAINT_GAP = 100;
const INPUT_QUIET = 150;
let lastPaint = 0;
let paintTimer = 0;
let lastInput = -1e9;
for (const ev of ['keydown', 'pointerdown', 'input']) addEventListener(ev, () => (lastInput = performance.now()), { capture: true, passive: true });
const dirtyMsgs = new Set();
// A finger (or its fling) on a box that scrolls by itself – the thinking box, code being written, tool output –
// holds the repaints: replacing the node under the finger on every token killed the gesture, which is what made
// the thinking box so hard to scroll. The text catches up the moment the box is let go.
const INNER = '.reasoning-body, .tool-body pre, .tool-out';
let innerHeld = false;
let innerUntil = 0;
const innerBusy = () => innerHeld || Date.now() < innerUntil;
messagesEl.addEventListener('touchstart', (e) => e.target.closest?.(INNER) && (innerHeld = true), { passive: true });
const letGo = () => {
  if (!innerHeld) return;
  innerHeld = false;
  innerUntil = Date.now() + 450; // the fling after the finger lifts
};
messagesEl.addEventListener('touchend', letGo, { passive: true });
messagesEl.addEventListener('touchcancel', letGo, { passive: true });
messagesEl.addEventListener('scroll', (e) => !innerHeld && e.target.matches?.(INNER) && Date.now() < innerUntil && (innerUntil = Date.now() + 200), { capture: true, passive: true });
function rerenderLast() {
  const msgs = state.current?.messages;
  const msg = msgs?.[msgs.length - 1];
  if (msg) dirtyMsgs.add(msg);
  const done = msg && !msg.streaming;
  // a reply that has just finished does not wait behind a slowed-down redraw already queued: it is drawn now
  if (rafPending && done && paintTimer) {
    clearTimeout(paintTimer);
    paintTimer = 0;
    rafPending = false;
  }
  if (rafPending) return;
  rafPending = true;
  // a reply arriving is drawn at most ~10 times a second, and not right after a key or a tap: on a mid-range phone a
  // redraw takes a good part of a frame, and one landing on a keystroke is what made typed letters show up late (239)
  const now = performance.now();
  // a message not on screen yet (a reply just started) and a reply that has just finished are drawn at once: the wait
  // is only for the updates in between
  const fresh = msg && (!msgNode(msgs.length - 1) || done);
  const wait = innerBusy() ? 120 : fresh ? 0 : Math.max(PAINT_GAP - (now - lastPaint), now - lastPaint < 1000 ? INPUT_QUIET - (now - lastInput) : 0, 0); // typing non-stop still sees it once a second
  if (wait > 0) {
    paintTimer = setTimeout(() => {
      paintTimer = 0;
      rafPending = false;
      rerenderLast();
    }, wait);
    return;
  }
  requestAnimationFrame(() => {
    rafPending = false;
    lastPaint = performance.now();
    const msgs = state.current?.messages || [];
    const todo = [...dirtyMsgs].map((m) => msgs.indexOf(m)).filter((i) => i >= 0).sort((a, b) => a - b);
    dirtyMsgs.clear();
    for (const i of todo) paintMessage(i);
    scrollBottom();
  });
}
/**
 * What of a message you are looking at, to keep in place while it is replaced: its bottom edge when it is above the
 * screen, the top of the reply text (the n-th bubble) when that is on screen and the message starts above it.
 * A message that starts on screen needs nothing – its top does not move.
 */
function viewAnchor(old) {
  const vt = messagesEl.getBoundingClientRect().top;
  const r = old.getBoundingClientRect();
  if (r.top >= vt) return null;
  if (r.bottom <= vt) return { edge: 'bottom', y: r.bottom };
  const bubbles = [...old.querySelectorAll('.bubble')];
  for (let k = bubbles.length - 1; k >= 0; k--) {
    const b = bubbles[k].getBoundingClientRect();
    if (b.top < vt + messagesEl.clientHeight && b.bottom > vt) return { bubble: k, of: bubbles.length, y: b.top };
  }
  return { edge: 'bottom', y: r.bottom };
}
function holdAnchor(a, node) {
  let y;
  if (a.edge === 'bottom') y = node.getBoundingClientRect().bottom;
  else {
    const bubbles = node.querySelectorAll('.bubble');
    // a reply that changed shape (steps folded into one box): the last text block is the one you were reading
    const b = bubbles.length === a.of ? bubbles[a.bubble] : a.bubble === a.of - 1 ? bubbles[bubbles.length - 1] : null;
    if (!b) return;
    y = b.getBoundingClientRect().top;
  }
  const d = Math.round(y - a.y);
  // scrollBy, not setting scrollTop from a value read earlier: a fling in progress keeps its own position
  if (d) messagesEl.scrollBy(0, d);
}
/** Redraw one finished message (a note was added under it) without redrawing the chat: if you were at the end you stay at the end, otherwise nothing moves. */
function repaintMessage(i) {
  if (i < 0 || !msgNode(i)) return;
  paintMessage(i); // keeps what you are looking at in place when you are not at the end
  if (stickToBottom) scrollBottom();
}
/** A redrawn message keeps the code boxes you opened (Show all) or switched to wrap, box by box. */
function keepCodeBoxes(old, node) {
  const was = [...old.querySelectorAll('.code-wrap')];
  [...node.querySelectorAll('.code-wrap')].forEach((nb, k) => {
    const ob = was[k];
    if (!ob) return;
    if (ob.classList.contains('expanded') && nb.classList.contains('collapsible')) {
      nb.classList.add('expanded');
      const btn = nb.querySelector('.code-more');
      if (btn) btn.textContent = 'Show less ▴';
    }
    if (ob.dataset.wrapTouched) {
      const on = ob.classList.contains('wrapped');
      nb.classList.toggle('wrapped', on);
      nb.dataset.wrapTouched = '1';
      const wb = nb.querySelector('[data-wrap]');
      if (wb) wb.textContent = on ? '⇥ No wrap' : '↩ Wrap';
    }
  });
}

/**
 * A streaming reply whose finished part did not change: update the message on screen in place – only the parts that
 * differ and the live tail – so the browser does not lay out the whole reply again every frame. → false when the
 * shape changed (a new tool card, …): then the node is replaced as usual.
 */
function patchStreaming(old, node) {
  const ph = node.querySelector('.md > .md-done[data-keep]');
  if (!ph) return false;
  const fill = () => {
    fillParts(ph, ph._html || []);
    delete ph.dataset.keep;
    return false;
  };
  const oDone = old.querySelector('.md > .md-done');
  const oMd = oDone?.parentElement;
  const nMd = ph.parentElement;
  const oCol = oMd?.parentElement;
  const nCol = nMd.parentElement;
  if (!oDone || old.className !== node.className || !oCol || oCol.children.length !== nCol.children.length || [...oCol.children].indexOf(oMd) !== [...nCol.children].indexOf(nMd) || old.children.length !== node.children.length) return fill();
  // the rest of the message (avatar, name, thinking, tool cards, notes): swap only what differs
  // compared as they were built: the ones on screen had their emoji turned into icons, so their HTML never matched a
  // fresh one and every tool card was replaced (and its icons redrawn) on every frame (decision 239)
  const built = (x) => (x._src ??= x.outerHTML);
  const swap = (o, n, skip) => {
    const os = [...o.children];
    [...n.children].forEach((c, k) => {
      if (c === skip || os[k] === skip) return;
      if (built(os[k]) !== built(c)) os[k].replaceWith(c);
    });
  };
  const oc = [...old.children];
  [...node.children].forEach((c, k) => {
    if (c === nCol) return;
    if (built(oc[k]) !== built(c)) oc[k].replaceWith(c);
  });
  swap(oCol, nCol, nMd);
  // newly finished parts: added once, the ones already there are not touched
  for (const h of ph._add || []) {
    const d = el('div', 'md-part');
    d.innerHTML = h;
    oDone.append(d);
  }
  oDone.dataset.n = ph.dataset.n;
  oDone.dataset.k = ph.dataset.k;
  const nt = nMd.querySelector(':scope > .md-tail');
  const ot = oMd.querySelector(':scope > .md-tail');
  if (ot && nt && ot.innerHTML !== nt.innerHTML) ot.replaceWith(nt);
  return true;
}

/** The scrollable output boxes of a message that are on view (not inside a folded card), keyed by their card and place. */
function scrollBoxes(root) {
  const out = [];
  const seen = new Map();
  for (const x of root.querySelectorAll('.tool-body pre, .tool-out')) {
    if (x.closest('details:not([open])')) continue;
    const card = x.closest('[data-k]')?.dataset.k || '';
    const n = seen.get(card) || 0;
    seen.set(card, n + 1);
    out.push([`${card}#${n}`, x]);
  }
  return out;
}

function paintMessage(i) {
  const msgs = state.current.messages;
  const old = msgNode(i);
  const node = messageNode(msgs[i], i, old);
  // the message is redrawn on every token while it streams: keep every box you opened or closed (thinking, tool
  // cards) as it was, and keep the scroll position inside boxes that scroll
  const oldDets = old ? [...old.querySelectorAll('details')] : [];
  const newDets = [...node.querySelectorAll('details')];
  // tool cards and step boxes carry a key (cards move into a box when a run gets long); the rest match by position
  const byKey = new Map(oldDets.filter((d) => d.dataset.k).map((d) => [d.dataset.k, d]));
  newDets.forEach((nd, k) => {
    const od = nd.dataset.k ? byKey.get(nd.dataset.k) : oldDets[k];
    if (od && od.className.split(' ')[0] === nd.className.split(' ')[0] && od.dataset.touched) {
      nd.open = od.open;
      nd.dataset.touched = '1';
    }
  });
  if (old) {
    // the thinking box scrolls on its own: keep where you were (or keep following the newest text if you were at the end)
    const ob = old.querySelector('.reasoning-body');
    const atEnd = ob ? ob.scrollHeight - ob.scrollTop - ob.clientHeight < 12 : true;
    const top = ob?.scrollTop || 0;
    // other scrollable boxes (code being written, tool output): remember where each was
    // only boxes you can see, and only where they were scrolled: reading or setting the scroll of a box inside a folded
    // card makes the browser lay out its hidden output – a Claude Code turn of 70+ cards froze the screen for seconds on
    // every update (decision 258)
    const oldBoxes = new Map();
    for (const [key, x] of scrollBoxes(old)) if (x.scrollTop || x.scrollLeft) oldBoxes.set(key, [x.scrollTop, x.scrollLeft]);
    // a streaming reply is updated in place when it can be; otherwise the node is replaced
    const patched = patchStreaming(old, node);
    if (!patched) {
      keepCodeBoxes(old, node);
      // replacing the node takes away the element the browser's own scroll anchoring holds on to, and a finished
      // reply changes shape (its steps fold into one box, it becomes content-visibility:auto). If you are not at the
      // end, keep what you are looking at where it is on screen.
      const anchor = stickToBottom ? null : viewAnchor(old);
      // the finished node starts at the height it had: an off-screen reply would otherwise shrink to the 240px guess
      if (old.offsetHeight) node.style.containIntrinsicSize = `auto ${old.offsetHeight}px`;
      // a reply still arriving: its parts are noted as built before the icons change them, so the next update keeps
      // the ones that did not change instead of replacing them all once (decision 239)
      if (node.classList.contains('streaming-msg')) {
        const col = node.querySelector('.md')?.parentElement;
        for (const c of [...node.children, ...(col ? col.children : [])]) c._src ??= c.outerHTML;
      }
      old.replaceWith(node);
      if (anchor) holdAnchor(anchor, node);
    }
    const root = patched ? old : node;
    const nb = root.querySelector('.reasoning-body');
    if (ob && nb && (nb !== ob || atEnd)) nb.scrollTop = atEnd ? nb.scrollHeight : top;
    if (oldBoxes.size)
      for (const [key, x] of scrollBoxes(root)) {
        const at = oldBoxes.get(key);
        if (at) [x.scrollTop, x.scrollLeft] = at;
      }
    return;
  }
  messagesEl.querySelector(':scope > .empty')?.remove();
  for (let j = i + 1; j < msgs.length; j++) {
    const next = msgNode(j);
    if (next) return next.before(node);
  }
  messagesEl.append(node);
}
// render math & diagrams in whatever gets added to the chat (lazy-loads KaTeX / Mermaid only when needed)
let hydrateTimer = null;
new MutationObserver(() => {
  clearTimeout(hydrateTimer);
  hydrateTimer = setTimeout(() => hydrateRich(messagesEl).catch((e) => console.warn('render failed', e)), 60);
}).observe(messagesEl, { childList: true, subtree: true });

// horizontal swipe on a reply with alternatives switches between them
let swipe0 = null;
messagesEl.addEventListener('touchstart', (e) => {
  const node = e.target.closest('.msg');
  if (!node || e.target.closest('pre, .code-wrap, .tool-card, table')) return (swipe0 = null);
  swipe0 = { node, x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
messagesEl.addEventListener('touchend', (e) => {
  if (!swipe0) return;
  const dx = e.changedTouches[0].clientX - swipe0.x;
  const dy = e.changedTouches[0].clientY - swipe0.y;
  const idx = Number(swipe0.node.dataset.mi ?? -1);
  const m = state.current?.messages[idx];
  const quick = Date.now() - swipe0.t < 600;
  swipe0 = null;
  if (!m || !quick || Math.abs(dx) < 70 || Math.abs(dy) > 40) return;
  if (m.role === 'assistant' && m.alts?.length > 1) switchAlt(idx, dx < 0 ? 1 : -1);
  else if (m.role === 'user' && m.versions?.length > 1) switchVersion(idx, dx < 0 ? 1 : -1);
}, { passive: true });

messagesEl.addEventListener(
  'toggle',
  (e) => {
    if (!e.target.matches?.('details')) return;
    e.target.dataset.touched = '1';
  },
  true,
);
// opened by a tap while it is still thinking: start at the newest thought (repaints follow it from there)
messagesEl.addEventListener('click', (e) => {
  const det = e.target.closest?.('.reasoning > summary')?.parentElement;
  if (!det || !det.closest('.msg')?.classList.contains('streaming-msg')) return;
  const mi = det.closest('.msg').dataset.mi;
  setTimeout(() => {
    // a repaint may have replaced the box in between: find this message's box as it is now
    const rb = messagesEl.querySelector(`.msg[data-mi="${mi}"] .reasoning[open] .reasoning-body`);
    if (rb) rb.scrollTop = rb.scrollHeight;
  }, 0);
});
// the toggle event arrives a moment after the tap; a redraw in between (while a reply streams) must still know you opened it
messagesEl.addEventListener('click', (e) => {
  const d = e.target.closest?.('summary')?.parentElement;
  if (d?.tagName === 'DETAILS') d.dataset.touched = '1';
}, true);
// code boxes: expand/collapse long code, toggle line wrapping (also works in sheets)
function codeBoxClick(e) {
  const dt = e.target.closest('[data-diagram-toggle]');
  if (dt) {
    const box = dt.closest('.code-wrap');
    const showCode = box.classList.toggle('show-code');
    dt.textContent = showCode ? '◇ Diagram' : '</> Code';
    return true;
  }
  const wrapBtn = e.target.closest('[data-wrap]');
  if (wrapBtn) {
    const box = wrapBtn.closest('.code-wrap');
    const on = box.classList.toggle('wrapped');
    box.dataset.wrapTouched = '1';
    wrapBtn.textContent = on ? '⇥ No wrap' : '↩ Wrap';
    return true;
  }
  const more = e.target.closest('[data-expand]');
  const box = e.target.closest('.code-wrap.collapsible');
  // tap the faded code (or the bar) to expand; tap the bar again to collapse
  if (more || (box && !box.classList.contains('expanded') && e.target.closest('pre') && !getSelection().toString())) {
    const b = more ? more.closest('.code-wrap') : box;
    const open = b.classList.toggle('expanded');
    const btn = b.querySelector('.code-more');
    btn.textContent = open ? 'Show less ▴' : `Show all ${btn.dataset.lines} lines ▾`;
    if (!open && b.getBoundingClientRect().top < 0) b.scrollIntoView({ block: 'start' });
    return true;
  }
  return false;
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#messages') && e.target.closest('.code-wrap')) codeBoxClick(e);
});

messagesEl.addEventListener('click', (e) => {
  if (codeBoxClick(e)) return;
  const b = e.target.closest('[data-copy]');
  if (b) copyText(b.closest('.code-wrap').querySelector('pre').innerText);
  const pv = e.target.closest('[data-preview]');
  if (pv) openHtmlPreview(pv.dataset.preview, pv.closest('.code-wrap').querySelector('pre').innerText);
  // a file path written in the reply opens that file – however it is written (see wsPathIn); only a file that is there
  const code = e.target.closest('code');
  if (code && !code.closest('pre')) {
    const p = wsPathIn(code.textContent, { any: true });
    if (p) hooks.openWsFile?.(p);
  }
});

// a path in a reply → the chat's file it names, however it is written (wspath.js)
const wsPathIn = (text, { any = false } = {}) => wsPath(text, { convId: state.current?.id || '', files: wsCacheSync(state.current?.id)?.files || null, any });
/** Inline code naming one of the chat's files is drawn as a link (underlined) – only when that file exists. */
function markWsPaths(root) {
  for (const code of root.querySelectorAll(':not(pre) > code')) code.classList.toggle('ws-file', !!wsPathIn(code.textContent));
}
// the chat's file list loaded or changed: the replies already on screen are marked again (once per frame at most)
let remark = 0;
hooks.wsChanged = (id) => {
  if (id !== state.current?.id || remark) return;
  remark = requestAnimationFrame(() => {
    remark = 0;
    for (const md of messagesEl.querySelectorAll('.md')) markWsPaths(md);
  });
};

// ---------- HTML preview (sandboxed webview) ----------
let lastPreview = '';
function openHtmlPreview(lang, code) {
  lastPreview = code;
  const frame = $('#html-frame');
  frame.srcdoc = previewDoc(lang, code);
  openSheet('#html-sheet', true);
}
$('#html-reload').onclick = () => {
  const f = $('#html-frame');
  const d = f.srcdoc;
  f.srcdoc = '';
  requestAnimationFrame(() => (f.srcdoc = d));
};
$('#html-copy').onclick = () => copyText(lastPreview);
window.addEventListener('message', (e) => {
  // external links clicked inside an HTML preview → open in the system browser
  if (e.source === $('#html-frame').contentWindow && typeof e.data?.ocmOpen === 'string' && /^(https?:|mailto:|tel:)/i.test(e.data.ocmOpen)) {
    if (confirm(`Open this link in your browser?\n\n${e.data.ocmOpen}`)) window.open(e.data.ocmOpen, '_blank');
  }
});
$('#html-sheet').addEventListener('transitionend', () => {
  if (!$('#html-sheet').classList.contains('open')) $('#html-frame').srcdoc = '';
});

export { changesCard, repaintMessage, IMG_EXT, addGreeting, applyChatArt, closeArt, closeFind, contextNow, groupAvatar, messageNode, messagesEl, mimeOf, modelName, msgNode, openArt, openContextSheet, openFind, openHtmlPreview, appendMessage, renderMessages, rerenderLast, scrollBottom, setChatPersona, setStick, toolSubject, updateContextChip, updateHeader, wsBlobUrl, lazySrc };
