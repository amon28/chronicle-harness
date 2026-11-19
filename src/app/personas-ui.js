// Personas and characters: chat/persona sheets, your personas, group setup, the persona editor,
// character card import and lorebooks.
import { Capacitor } from '@capacitor/core';
import { streamChat, downloadCardFromLink } from '../api.js';
import { canBrowseChub, browseSite, SITES, bytesFromBase64 } from '../chubbrowser.js';
import { saveSettings, art } from '../store.js';
import { readCard, cardLorebook, cardPrompt, exportCardPng, fillMacros, personaToCard } from '../cards.js';
import { cardSource, sourceSite, applyReimport, undoReimport, cardChanges } from '../reimport.js';
import { chooseOne } from './choose.js';
import { sha256Hex, shortHash } from '../hash.js';
import { newLorebook, newEntry, importLorebook } from '../lore.js';
import { ensurePersonas, restoreBuiltins, builtinFor, avatarEl, imageToAvatar, imageToArt, newPersonaId, AVATAR_COLORS } from '../personas.js';
import { openDrawer, openSheet, persist, renderConvList, selectConv, setMode } from './chatlist.js';
import { $, appMode, hooks, cardFor, chatPersona, chatPrompt, convIsRp, currentModel, defaultChatPersona, defaultRpPersona, el, enabledToolsAll, fmtTokens, groupMembers, isGroup, lorebookById, memoryOn, personaById, personas, pref, rpPersonaFlag, state, toast, uid, userPersona, userPersonaById } from './core.js';
import { BUILTIN_STYLES } from '../outputstyles.js';
import { TOOL_GROUPS, TOOLSET_PRESETS, picksFrom, toolsetFrom } from '../toolset.js';
import { TOOL_LABELS, toolDefs } from '../tools.js';
import { projectStyles } from '../projectfiles.js';
import { looksText, bytesToText } from '../sandbox.js';
import { autoLoreIds, suggestLore, fillSamplerBox, isRpConv, readSamplerBox, storyOn, updateStory, trackerOn, updateTracker } from './engine.js';
import { openMemory, shareBytes, updateShortcuts, wsMem } from './extras.js';
import { addGreeting, applyChatArt, openArt, renderMessages, setChatPersona, updateContextChip, updateHeader } from './render.js';
import { P } from '../prompts.js';
import { presetSamplers } from '../rppresets.js';
import { findPersona } from '../findpersona.js';
import { collapseDiff, diffStats, lineDiff } from '../diff.js';
import { GLOBAL, learnCandidates, isEvent, newMemory, selectMemories, visibleMemories } from '../memory.js';
import { canSpeak, listVoices, speak } from '../speech.js';

// ---------- persona & chat-prompt sheets ----------
function fillPersonaSelect(sel, value, filter = () => true) {
  sel.innerHTML = '';
  for (const p of personas().filter(filter)) {
    const o = el('option', null, `${p.avatar?.emoji && !p.avatar.image ? p.avatar.emoji + ' ' : ''}${p.name}`);
    o.value = p.id;
    sel.append(o);
  }
  sel.value = value;
}

// "This chat" sheet: pick persona + edit this chat's system prompt
// "This chat": the current character on one line; the full list only when you tap Change
// (filtered to this side of the app – roleplay characters or assistants – and searchable).
function renderChatPersonaCurrent() {
  const cur = chatPersona();
  const box = $('#chat-persona-current');
  box.innerHTML = '';
  const row = el('div', 'persona-item active');
  row.append(avatarEl(cur.avatar, 40));
  const t = el('div', 'persona-text');
  t.append(el('div', 'persona-title', cur.name), el('div', 'persona-desc', cur.description || (cur.card?.description ?? cur.prompt).slice(0, 90)));
  const change = el('button', 'ghost-btn small', $('#chat-persona-picker').hidden ? 'Change' : 'Close');
  change.onclick = () => {
    const pk = $('#chat-persona-picker');
    pk.hidden = !pk.hidden;
    renderChatPersonaCurrent();
    if (!pk.hidden) {
      renderChatPersonaList();
      $('#chat-persona-search').focus();
    }
  };
  row.append(t, change);
  box.append(row);
}
function renderChatPersonaList() {
  const list = $('#chat-persona-list');
  list.innerHTML = '';
  const cur = chatPersona();
  const rp = rpPersonaFlag(cur);
  const q = $('#chat-persona-search').value.trim().toLowerCase();
  const all = $('#chat-persona-all').checked;
  $('#chat-persona-all-label').textContent = rp ? 'Show assistants too' : 'Show roleplay characters too';
  const shown = personas().filter((p) => (all || rpPersonaFlag(p) === rp) && (!q || p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)));
  if (!shown.length) list.append(el('p', 'hint pad', 'No matches.'));
  for (const p of shown) {
    const b = el('button', 'persona-item' + (p.id === cur.id ? ' active' : ''));
    b.append(avatarEl(p.avatar, 36));
    const t = el('div', 'persona-text');
    t.append(el('div', 'persona-title', p.name), el('div', 'persona-desc', p.description || (p.card?.description ?? p.prompt).slice(0, 80)));
    b.append(t);
    if (p.id === cur.id) b.append(el('span', 'check', '✓'));
    b.onclick = () => {
      setChatPersona(p.id);
      $('#chat-persona-picker').hidden = true;
      openChatSheet();
    };
    list.append(b);
  }
}
$('#chat-persona-search').addEventListener('input', renderChatPersonaList);
$('#chat-persona-all').addEventListener('change', renderChatPersonaList);

function openChatSheet() {
  if (isGroup()) return openGroupEditor();
  if (!$('#chat-sheet').classList.contains('open')) {
    $('#chat-persona-picker').hidden = true; // opens compact; the list only on "Change"
    $('#chat-persona-search').value = '';
  }
  renderChatPersonaCurrent();
  if (!$('#chat-persona-picker').hidden) renderChatPersonaList();
  renderChatLore();
  updateLoreSuggestBtn();
  fillCtxSelect($('#chat-ctx'), state.current.ctxLimit, `Default (${(() => {
    const p = chatPersona();
    const v = Number(p?.ctxLimit ?? (isRpConv(state.current) ? pref('ctxLimitRp') : pref('ctxLimitOther'))) || 0;
    return v ? fmtTokens(v) : isRpConv(state.current) ? 'automatic – just under the model limit' : 'model max';
  })()})`);
  fillStyleSelect();
  renderStoryBox();
  renderTrackerBox();
  // story memory and the scene tracker are roleplay tools: in an ordinary chat they only show when switched on
  const rpish = isRpConv(state.current);
  $('#story-box').hidden = !rpish && !storyOn(state.current) && !state.current.story;
  $('#tracker-box').hidden = !rpish && !trackerOn(state.current) && !state.current.tracker;
  renderChatMemories();
  renderForkBox();
  fillUserPersonaSelect($('#chat-me'), state.current.userPersonaId || '');
  const an = state.current.authorsNote || {};
  $('#an-text').value = an.text || '';
  $('#an-depth').value = an.depth ?? 4;
  $('#an-role').value = an.role || 'system';
  {
    const p = chatPersona();
    fillSamplerBox('cs', state.current.samplers || {}, { ...(isRpConv(state.current) ? presetSamplers(state.settings, state.current) : {}), ...(p?.samplers || {}), ...(p?.temperature != null ? { temperature: p.temperature } : {}) });
    hooks.fillChatPreset?.();
    $('#chat-samplers').open = !!state.current.samplers;
  }
  $('#chat-proactive').value = String(state.current.proactive?.hours || '');
  $('#chat-memory').checked = !state.current.noMemory;
  $('#chat-memory').disabled = !pref('useMemory');
  $('#chat-prompt').value = chatPrompt();
  renderCardBox();
  $('#chat-prompt-note').textContent = state.current.systemPrompt != null ? 'Custom prompt for this chat (overrides the persona).' : `Using ${chatPersona().name}'s prompt. Edit it to customize just this chat.`;
  openSheet('#chat-sheet', true);
}
$('#persona-btn').onclick = () => (isGroup() ? openChatSheet() : openArt(chatPersona()));
$('#persona-name-btn').onclick = openChatSheet;
$('#chat-proactive').onchange = (e) => {
  const h = Number(e.target.value) || 0;
  if (h) state.current.proactive = { hours: h };
  else delete state.current.proactive;
  if (state.current.messages.length) persist();
  hooks.syncWakePlan?.();
  if (h && !pref('proactive')) toast('Also switch on Settings › Notifications › Characters can message me first', 4000);
};
$('#chat-memory').onchange = (e) => {
  state.current.noMemory = !e.target.checked;
  updateHeader();
  if (state.current.messages.length) persist();
  toast(e.target.checked ? 'Memory on for this chat' : 'Memory off for this chat – nothing is learned or used');
};
const CTX_CHOICES = [0, 8192, 16384, 24576, 32768, 49152, 65536, 98304, 131072, 200000];
function fillCtxSelect(sel, value, inheritLabel) {
  sel.innerHTML = '';
  const max = currentModel()?.limit?.context || 0;
  const steps = CTX_CHOICES.filter((v) => v && (!max || v < max));
  const list = [...(max ? [[String(max), `Model maximum (${fmtTokens(max)})`]] : []), ...steps.map((v) => [String(v), `${fmtTokens(v)} tokens`])]
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  const known = new Set(list.map((o) => o[0]));
  const own = Number(value) > 0 && !known.has(String(value)) ? [[String(value), `Custom: ${fmtTokens(Number(value))} tokens`]] : [];
  const opts = [...(inheritLabel ? [['', inheritLabel]] : []), ['0', max ? 'Automatic (roleplay keeps ~80% of the window)' : 'Automatic'], ...list, ...own, ['custom', 'Custom…']];
  for (const [v, l] of opts) {
    const o = el('option', null, l);
    o.value = v;
    sel.append(o);
  }
  sel.value = value == null ? '' : String(value);
  if (sel.value === '' && !inheritLabel) sel.value = '0';
  if (!sel.dataset.custom) {
    sel.dataset.custom = '1';
    let before = sel.value;
    sel.addEventListener('focus', () => (before = sel.value));
    sel.addEventListener('change', (e) => {
      if (sel.value !== 'custom') return (before = sel.value);
      e.stopImmediatePropagation();
      const raw = (globalThis.prompt('Context size in tokens (e.g. 60000 or 60k)', before > 0 ? before : '') || '').trim().toLowerCase().replace(/[, ]/g, '');
      const n = Math.round(parseFloat(raw) * (raw.endsWith('k') ? 1000 : raw.endsWith('m') ? 1e6 : 1));
      if (!(n >= 1000 && n <= 2e6)) {
        sel.value = before;
        return toast('Enter a number between 1,000 and 2,000,000');
      }
      let o = [...sel.options].find((x) => x.value === String(n));
      if (!o) {
        o = el('option', null, `Custom: ${fmtTokens(n)} tokens`);
        o.value = String(n);
        sel.insertBefore(o, sel.querySelector('option[value="custom"]'));
      }
      sel.value = before = String(n);
      sel.dispatchEvent(new Event('change'));
    }, true);
  }
}
$('#chat-ctx').onchange = (e) => {
  state.current.ctxLimit = e.target.value === '' ? undefined : Number(e.target.value);
  if (state.current.messages.some((m) => !m.greeting)) persist();
  renderMessages();
};

/** 🌿 Where this chat was forked from, and the forks made from it. */
function renderForkBox() {
  const box = $('#chat-fork-box');
  const c = state.current;
  box.innerHTML = '';
  const forks = state.convs.filter((x) => x.forkOf?.id === c.id);
  const parent = c.forkOf && state.convs.find((x) => x.id === c.forkOf.id);
  box.hidden = !c.forkOf && !forks.length;
  if (box.hidden) return;
  const go = (id) => {
    openSheet('#chat-sheet', false);
    selectConv(id);
  };
  if (c.forkOf) {
    box.append(el('div', null, `🌿 Forked from “${c.forkOf.title}”${c.forkOf.at != null ? ` at message ${c.forkOf.at + 1}` : ''}${parent ? '' : ' (the original was deleted)'}`));
    if (parent) {
      const b = el('button', 'ghost-btn small', 'Open the original');
      b.onclick = () => go(parent.id);
      box.append(el('div', 'row', ''));
      box.lastChild.append(b);
    }
  }
  if (forks.length) {
    box.append(el('div', null, `🌿 ${forks.length} fork${forks.length === 1 ? '' : 's'} of this chat`));
    const row = el('div', 'row gap-sm');
    for (const f of forks) {
      const b = el('button', 'ghost-btn small', f.title || 'Fork');
      b.onclick = () => go(f.id);
      row.append(b);
    }
    box.append(row);
  }
}

/** What this chat's persona remembers, and which of it goes out with the next message. */
function renderChatMemories() {
  const conv = state.current;
  const persona = isGroup(conv) ? groupMembers(conv)[0] || chatPersona(conv) : chatPersona(conv);
  const list = $('#chat-mem-list');
  list.innerHTML = '';
  $('#chat-mem-count').textContent = '';
  if (!persona) return;
  if (!memoryOn(conv)) {
    $('#chat-mem-info').textContent = 'Memory is off for this chat (incognito) – nothing is learned or used.';
    return;
  }
  const rp = isRpConv(conv, persona);
  const all = state.settings.memories || [];
  const facts = visibleMemories(all, persona.id, conv.id, rp);
  const query = conv.messages.filter((x) => !x.streaming && x.content).slice(-3).map((x) => x.content.slice(0, 1200)).join('\n');
  const sent = new Set(selectMemories(facts, query, pref('memLimit')).map((m) => m.id));
  const notes = all
    .filter((m) => isEvent(m) && m.scope === persona.id && (rp ? m.conv === conv.id : m.conv !== conv.id && !m.rp))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const total = facts.length + notes.length;
  $('#chat-mem-count').textContent = total ? `(${total})` : '';
  $('#chat-mem-info').textContent = total
    ? `${persona.name} sends ${sent.size} of ${facts.length} fact${facts.length === 1 ? '' : 's'} with each message${notes.length ? ' plus its notes' : ''}. ${rp ? 'In a roleplay these belong to this chat only.' : 'Facts about you are shared by every persona.'}`
    : `Nothing remembered yet. ${persona.name} learns from your messages as you chat.`;
  const refresh = () => {
    saveSettings(state.settings);
    renderChatMemories();
  };
  const row = (m, isNote) => {
    const r = el('div', 'cm-item' + (!isNote && !sent.has(m.id) ? ' off' : ''));
    r.append(el('div', 'cm-text', m.text));
    if (!isNote && !sent.has(m.id)) r.append(el('span', 'cm-tag', 'not sent now'));
    if (!isNote) {
      const pin = el('button', 'mem-btn', '📌');
      pin.style.opacity = m.pinned ? '1' : '0.35';
      pin.setAttribute('aria-label', m.pinned ? 'Unpin' : 'Always send');
      pin.onclick = () => ((m.pinned = !m.pinned), refresh());
      r.append(pin);
    }
    const edit = el('button', 'mem-btn', '✎');
    edit.setAttribute('aria-label', 'Edit memory');
    edit.onclick = () => {
      const ta = el('textarea', 'field');
      ta.value = m.text;
      ta.rows = isNote ? 5 : 2;
      const save = el('button', 'primary-btn small', 'Save');
      const cancel = el('button', 'ghost-btn small', 'Cancel');
      save.onclick = () => {
        const v = ta.value.trim();
        if (!v) state.settings.memories = state.settings.memories.filter((x) => x !== m);
        else if (v !== m.text) {
          m.text = isNote ? v.slice(0, 900) : v.slice(0, 300);
          m.updatedAt = Date.now();
          delete m.vec; // re-read by Smart memory next time
        }
        refresh();
      };
      cancel.onclick = () => renderChatMemories();
      const box = el('div', 'cm-edit');
      box.append(ta, el('div', 'row gap-sm'));
      box.lastChild.append(save, cancel);
      r.replaceChildren(box);
      ta.focus();
    };
    const del = el('button', 'mem-btn', '×');
    del.setAttribute('aria-label', 'Delete memory');
    del.onclick = () => ((state.settings.memories = state.settings.memories.filter((x) => x !== m)), refresh());
    r.append(edit, del);
    return r;
  };
  const section = (title, items, isNote) => {
    if (!items.length) return;
    list.append(el('div', 'cm-head', title));
    for (const m of items) list.append(row(m, isNote));
  };
  section('About you (all personas)', facts.filter((m) => (m.scope || GLOBAL) === GLOBAL));
  section(rp ? `Learned in this roleplay` : `${persona.name} learned`, facts.filter((m) => m.scope === persona.id));
  section(rp ? 'Notes on this roleplay' : 'Notes from other chats', notes, true);
  // add one by hand: for everyone, or only for this persona (in a roleplay: only this roleplay)
  const add = el('div', 'cm-add');
  const input = el('input', 'field');
  input.placeholder = 'Add a memory…';
  input.maxLength = 300;
  const where = el('select', 'field');
  for (const [v, l] of [[GLOBAL, 'About you (everyone)'], [persona.id, rp ? 'Only this roleplay' : `Only ${persona.name}`]]) {
    const o = el('option', null, l);
    o.value = v;
    where.append(o);
  }
  where.value = persona.id;
  const go = el('button', 'primary-btn small', 'Add');
  go.onclick = () => {
    const v = input.value.trim();
    if (!v) return;
    const m = newMemory(v, where.value);
    if (rp && where.value !== GLOBAL) m.conv = conv.id;
    state.settings.memories.push(m);
    refresh();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), go.click()));
  add.append(input, where, go);
  list.append(add);
  $('#chat-mem-open').onclick = () => openMemory(persona.id);
}
$('#chat-mem-box').addEventListener('toggle', () => $('#chat-mem-box').open && renderChatMemories());

function fillStyleSelect() {
  const sel = $('#chat-style');
  const w = wsMem.get(state.current.id);
  const proj = projectStyles(w?.files, (b) => (looksText(b) ? bytesToText(b) : null));
  sel.innerHTML = '';
  for (const [v, label] of [...BUILTIN_STYLES.map((s) => [s.name, s.label]), ...proj.map((s) => [s.name, `📁 ${s.name}${s.description ? ' – ' + s.description.slice(0, 40) : ''}`])]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.append(o);
  }
  sel.value = state.current.outputStyle || 'default';
  const rp = isRpConv(state.current);
  sel.hidden = rp;
  $('#chat-style-row').hidden = rp;
}
$('#chat-style').onchange = (e) => {
  state.current.outputStyle = e.target.value === 'default' ? undefined : e.target.value;
  persist();
};

function renderTrackerBox() {
  const c = state.current;
  $('#tracker-on').checked = trackerOn(c);
  $('#tracker-text').value = c.tracker?.text || '';
  $('#tracker-info').textContent = c.tracker ? `Updated ${new Date(c.tracker.at).toLocaleString()}` : trackerOn(c) ? 'Fills in after the next reply.' : 'Off for this chat.';
}
hooks.trackerChanged = () => $('#chat-sheet').classList.contains('open') && renderTrackerBox();
$('#tracker-on').onchange = (e) => {
  state.current.trackerOn = e.target.checked;
  persist();
  renderTrackerBox();
};
$('#tracker-text').addEventListener('change', (e) => {
  const t = e.target.value.trim();
  state.current.tracker = t ? { ...(state.current.tracker || {}), text: t, at: Date.now() } : undefined;
  persist();
});
$('#tracker-update').onclick = async () => {
  $('#tracker-info').textContent = 'Updating…';
  const ok = await updateTracker(state.current, { manual: true });
  renderTrackerBox();
  if (ok) toast('Scene sheet updated');
};

function renderStoryBox() {
  const c = state.current;
  $('#story-auto').checked = storyOn(c);
  $('#story-text').value = c.story?.text || '';
  const n = c.story?.upto || 0;
  $('#story-info').textContent = c.story
    ? `Covers the first ${n} message${n === 1 ? '' : 's'} · updated ${new Date(c.story.at).toLocaleString()}${c.messages.length > n ? ` · ${c.messages.length - n} newer not included yet` : ''}`
    : storyOn(c) ? `Updates automatically every ${pref('storyEvery')} messages, or when messages slide out of the context window.` : 'Off for this chat.';
}
$('#story-auto').onchange = (e) => {
  state.current.storyAuto = e.target.checked;
  persist();
  renderStoryBox();
};
$('#story-text').addEventListener('change', (e) => {
  const t = e.target.value;
  state.current.story = t.trim() ? { ...(state.current.story || { upto: state.current.messages.length, at: Date.now() }), text: t, at: Date.now() } : undefined;
  persist();
  updateContextChip();
});
$('#story-update').onclick = async () => {
  $('#story-info').textContent = 'Updating…';
  const ok = await updateStory(state.current, { manual: true });
  renderStoryBox();
  if (ok) toast('Story memory updated');
};
$('#story-rebuild').onclick = async () => {
  if (!confirm('Rebuild the story memory from the whole chat? Your edits will be replaced.')) return;
  state.current.story = undefined;
  $('#story-info').textContent = 'Rebuilding from the whole chat…';
  await updateStory(state.current, { manual: true });
  renderStoryBox();
};

function fillUserPersonaSelect(sel, value) {
  sel.innerHTML = '';
  const def = userPersonaById(state.settings.defaultUserPersonaId);
  [['', `Default (${def?.name || 'User'})`], ...state.settings.userPersonas.map((u) => [u.id, u.name])].forEach(([v, l]) => {
    const o = el('option', null, l);
    o.value = v;
    sel.append(o);
  });
  sel.value = value;
}
$('#chat-me').onchange = (e) => {
  state.current.userPersonaId = e.target.value || undefined;
  if (state.current.messages.every((m) => m.greeting)) {
    state.current.messages = [];
    addGreeting(state.current);
    renderMessages();
  } else persist();
  updateContextChip();
};
function saveAuthorsNote() {
  const text = $('#an-text').value;
  const d = Number($('#an-depth').value);
  state.current.authorsNote = text.trim() ? { text, depth: Number.isFinite(d) ? Math.max(0, d) : 4, role: $('#an-role').value } : undefined;
  if (state.current.messages.some((m) => !m.greeting)) persist();
  updateContextChip();
}
['#an-text', '#an-depth', '#an-role'].forEach((id) => $(id).addEventListener('change', saveAuthorsNote));

// ---------- your personas (user side of roleplay) ----------
let meDraft = null;
function openMePersonas() {
  const list = $('#me-list');
  list.innerHTML = '';
  for (const u of state.settings.userPersonas) {
    const b = el('button', 'persona-item');
    b.append(el('span', 'slash-cmd big', '👤'));
    const t = el('div', 'persona-text');
    t.append(el('div', 'persona-title', u.name + (u.id === state.settings.defaultUserPersonaId ? ' · default' : '')), el('div', 'persona-desc', u.description || 'No description'));
    b.append(t, el('span', 'chev', '›'));
    b.onclick = () => editMe(u);
    list.append(b);
  }
  $('#me-edit').hidden = true;
  $('#me-main').hidden = false;
  openSheet('#settings-sheet', false);
  openSheet('#chat-sheet', false);
  openSheet('#me-sheet', true);
}
function editMe(u) {
  meDraft = u ? { ...u } : { id: 'up_' + uid().slice(0, 8), name: '', description: '' };
  $('#me-name').value = meDraft.name;
  $('#me-desc').value = meDraft.description;
  const mlb = $('#me-lorebook');
  mlb.innerHTML = '';
  for (const [v, l] of [['', 'None'], ...state.settings.lorebooks.map((b) => [b.id, `📚 ${b.name} (${b.entries.length})`])]) {
    const o = el('option', null, l);
    o.value = v;
    mlb.append(o);
  }
  mlb.value = meDraft.lorebookId && lorebookById(meDraft.lorebookId) ? meDraft.lorebookId : '';
  $('#me-default').checked = meDraft.id === state.settings.defaultUserPersonaId;
  $('#me-delete').hidden = !u || state.settings.userPersonas.length <= 1;
  $('#me-main').hidden = true;
  $('#me-edit').hidden = false;
}
$('#me-new').onclick = () => editMe(null);
$('#me-back').onclick = openMePersonas;
$('#me-save').onclick = () => {
  const name = $('#me-name').value.trim();
  if (!name) return toast('Give your persona a name');
  const u = { ...meDraft, name: name.slice(0, 40), description: $('#me-desc').value, lorebookId: $('#me-lorebook').value || undefined };
  const i = state.settings.userPersonas.findIndex((x) => x.id === u.id);
  if (i >= 0) state.settings.userPersonas[i] = u;
  else state.settings.userPersonas.push(u);
  if ($('#me-default').checked) state.settings.defaultUserPersonaId = u.id;
  saveSettings(state.settings);
  openMePersonas();
};
$('#me-delete').onclick = () => {
  state.settings.userPersonas = state.settings.userPersonas.filter((x) => x.id !== meDraft.id);
  if (state.settings.defaultUserPersonaId === meDraft.id) state.settings.defaultUserPersonaId = state.settings.userPersonas[0].id;
  saveSettings(state.settings);
  openMePersonas();
};
$('#open-me').onclick = openMePersonas;
$('#chat-me-manage').onclick = openMePersonas;

// ---------- character definitions for this chat (like Chub's "Override Character Definitions") ----------
const CC_FIELDS = ['first_mes', 'description', 'personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions'];
function renderCardBox() {
  const c = state.current;
  const p = chatPersona();
  const card = !isGroup(c) && p?.cardMode && p.card ? cardFor(p, c) : null;
  $('#chat-card-box').hidden = !card;
  // a character card edits its definitions field by field; the whole combined prompt is the advanced option
  $('#chat-prompt-sum').textContent = card ? 'Advanced: replace the whole prompt' : 'System prompt for this chat';
  $('#chat-prompt-hint').textContent = card ? 'Everything combined as one text. Editing this REPLACES the character definitions above for this chat (examples, notes and so on are no longer built in).' : '';
  if (!card) return;
  $('#chat-card-box').open = !!c.cardOverride;
  for (const k of CC_FIELDS) $('#cc-' + k).value = card[k] || '';
  $('#cc-depth_prompt').value = card.depth_prompt?.prompt || '';
  $('#cc-depth').value = card.depth_prompt?.depth ?? 4;
  $('#cc-note').textContent = c.cardOverride ? `Customized in this chat: ${Object.keys(c.cardOverride).map((k) => k.replace(/_/g, ' ')).join(', ')}.` : `Using ${p.name}'s own definitions.`;
  $('#chat-prompt').value = c.systemPrompt != null ? c.systemPrompt : chatPrompt();
}
const norm = (s) => String(s || '').replace(/\r/g, '').trim();
$('#cc-save').onclick = () => {
  const c = state.current;
  const p = chatPersona();
  const base = p.card || {};
  const over = {};
  for (const k of CC_FIELDS) if (norm($('#cc-' + k).value) !== norm(base[k])) over[k] = $('#cc-' + k).value.trim();
  const dp = $('#cc-depth_prompt').value.trim();
  const depth = Math.max(0, Math.min(50, Number($('#cc-depth').value) || 0));
  if (dp !== norm(base.depth_prompt?.prompt) || (dp && depth !== (base.depth_prompt?.depth ?? 4))) over.depth_prompt = { ...(base.depth_prompt || {}), prompt: dp, depth };
  if (Object.keys(over).length) c.cardOverride = over;
  else delete c.cardOverride;
  // the greeting is only a message so far: show the new one
  if (c.messages.length === 1 && c.messages[0].greeting) {
    c.messages = [];
    addGreeting(c);
    renderMessages();
  }
  updateHeader();
  updateContextChip();
  persist();
  renderCardBox();
  toast(c.cardOverride ? 'Saved for this chat' : 'Back to the character’s own definitions');
};
$('#cc-reset').onclick = () => {
  const c = state.current;
  if (!c.cardOverride) return toast('Nothing customized');
  delete c.cardOverride;
  if (c.messages.length === 1 && c.messages[0].greeting) {
    c.messages = [];
    addGreeting(c);
    renderMessages();
  }
  updateHeader();
  updateContextChip();
  persist();
  renderCardBox();
  toast('Reset to the character');
};

$('#chat-prompt-save').onclick = () => {
  const v = $('#chat-prompt').value;
  state.current.systemPrompt = v === chatPersona().prompt ? null : v;
  updateHeader();
  persist();
  openSheet('#chat-sheet', false);
  toast('Chat prompt saved');
};
$('#chat-prompt-reset').onclick = () => {
  state.current.systemPrompt = null;
  $('#chat-prompt').value = chatPersona().prompt;
  updateHeader();
  persist();
  toast('Reset to persona prompt');
};
$('#chat-make-group').onclick = () => {
  openSheet('#chat-sheet', false);
  openGroupEditor([chatPersona().id]);
};
$('#chat-manage').onclick = () => {
  openSheet('#chat-sheet', false);
  openPersonaManager();
};

// Group editor
let groupDraft = null;
$('#ge-search').addEventListener('input', () => renderGroupMembers());
$('#ge-all').addEventListener('change', () => renderGroupMembers());
function openGroupEditor(preselect) {
  const g = state.current.group;
  groupDraft = g ? { ...g, members: [...g.members] } : { members: preselect || [], mode: 'auto', name: '', scenario: '' };
  if (!g) groupDraft.mainId = (preselect || []).map(personaById).find((p) => p?.cardMode && !p.scenarioCard)?.id;
  $('#ge-search').value = '';
  $('#ge-all').checked = false;
  $('#ge-name').value = groupDraft.name || '';
  $('#ge-scenario').value = groupDraft.scenario || '';
  $('#ge-mode').value = groupDraft.mode || 'all';
  $('#ge-main').onchange = () => (groupDraft.mainId = $('#ge-main').value || null);
  $('#ge-scene').onchange = () => {
    groupDraft.sceneId = $('#ge-scene').value || null;
    if (groupDraft.mainId === groupDraft.sceneId) groupDraft.mainId = null;
    renderGroupMembers();
  };
  $('#ge-remove').hidden = !g;
  $('#ge-memory').checked = !state.current.noMemory;
  renderGroupMembers();
  openSheet('#chat-sheet', false);
  openSheet('#group-sheet', true);
}
function renderGroupMembers() {
  const list = $('#ge-members');
  list.innerHTML = '';
  // only this side of the app (assistants in Chats, characters in Roleplay); members you already
  // picked always stay visible; a checkbox shows the other side too
  const rp = convIsRp(state.current) || (appMode === 'rp' && !state.current.group);
  const q = $('#ge-search').value.trim().toLowerCase();
  const all = $('#ge-all').checked;
  $('#ge-all-label').textContent = rp ? 'Show assistants too' : 'Show roleplay characters too';
  const shown = personas().filter((p) => groupDraft.members.includes(p.id) || ((all || rpPersonaFlag(p) === rp) && (!q || p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q))));
  for (const p of shown) {
    const on = groupDraft.members.includes(p.id);
    const b = el('button', 'persona-item' + (on ? ' active' : ''));
    b.append(avatarEl(p.avatar, 36));
    const t = el('div', 'persona-text');
    const mdl = p.model && state.models.find((x) => x.id === p.model);
    t.append(el('div', 'persona-title', p.name), el('div', 'persona-desc', (mdl ? `${mdl.name} · ` : '') + (p.description || p.prompt.slice(0, 80))));
    b.append(t, el('span', 'check', on ? '✓' : ''));
    b.onclick = () => {
      groupDraft.members = on ? groupDraft.members.filter((x) => x !== p.id) : [...groupDraft.members, p.id];
      renderGroupMembers();
    };
    list.append(b);
  }
  if (!shown.length) list.append(el('p', 'hint pad', 'No matches.'));
  $('#ge-count').textContent = `${groupDraft.members.length} selected – order of selection = order of replies`;
  // roleplay groups: a scenario card (narrates the world) and/or a main character (their card sets the scene)
  const cardMembers = groupDraft.members.map(personaById).filter((p) => p?.cardMode);
  $('#ge-scene-row').hidden = !cardMembers.length;
  const sc = $('#ge-scene');
  sc.innerHTML = '';
  sc.append(new Option('None', ''));
  cardMembers.forEach((p) => sc.append(new Option(p.name, p.id)));
  if (groupDraft.sceneId && !groupDraft.members.includes(groupDraft.sceneId)) groupDraft.sceneId = undefined;
  if (groupDraft.sceneId === undefined) groupDraft.sceneId = cardMembers.find((p) => p.scenarioCard)?.id || null; // cards marked as scenario cards are picked automatically
  sc.value = groupDraft.sceneId || '';
  const rpMembers = groupDraft.members.map(personaById).filter((p) => p && rpPersonaFlag(p) && p.id !== groupDraft.sceneId);
  $('#ge-main-row').hidden = !rpMembers.length;
  const sel = $('#ge-main');
  sel.innerHTML = '';
  sel.append(new Option('None – every character is equal', ''));
  rpMembers.forEach((p) => sel.append(new Option(p.name + (p.cardMode ? '' : ' (no card)'), p.id)));
  if (groupDraft.mainId && !rpMembers.some((p) => p.id === groupDraft.mainId)) groupDraft.mainId = undefined;
  if (groupDraft.mainId === undefined) groupDraft.mainId = groupDraft.sceneId ? null : rpMembers.find((p) => p.cardMode && !p.scenarioCard)?.id || null;
  sel.value = groupDraft.mainId || '';
}
$('#ge-save').onclick = () => {
  if (groupDraft.members.length < 2) return toast('Pick at least 2 personas');
  groupDraft.name = $('#ge-name').value.trim().slice(0, 60);
  groupDraft.scenario = $('#ge-scenario').value;
  groupDraft.mode = $('#ge-mode').value;
  groupDraft.mainId = $('#ge-main-row').hidden ? undefined : $('#ge-main').value || null;
  groupDraft.sceneId = $('#ge-scene-row').hidden ? undefined : $('#ge-scene').value || null;
  state.current.group = groupDraft;
  // a group with a scenario card / main character opens with its first message
  if (state.current.messages.every((m) => m.greeting)) {
    state.current.messages = [];
    addGreeting(state.current);
  }
  state.current.noMemory = !$('#ge-memory').checked;
  state.current.personaId = groupDraft.members[0];
  state.current.systemPrompt = null;
  openSheet('#group-sheet', false);
  updateHeader();
  if (state.current.messages.length) persist();
  renderMessages();
  toast('Group ready – say hi to everyone');
};
$('#ge-remove').onclick = () => {
  delete state.current.group;
  openSheet('#group-sheet', false);
  updateHeader();
  if (state.current.messages.length) persist();
  renderMessages();
};

// Persona manager
// Persona manager: New / Import at the top, one side at a time (Assistants | Roleplay), searchable
let personaTab = 'chat';
function openPersonaManager(tab) {
  if (!$('#personas-sheet').classList.contains('open')) {
    personaTab = tab || (appMode === 'rp' ? 'rp' : 'chat');
    $('#persona-search').value = '';
  } else if (tab) personaTab = tab;
  renderPersonaManager();
  openDrawer(false);
  openSheet('#personas-sheet', true);
}
function renderPersonaManager() {
  const list = $('#persona-list');
  list.innerHTML = '';
  const q = $('#persona-search').value.trim().toLowerCase();
  document.querySelectorAll('#persona-tabs [data-ptab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.ptab === personaTab);
    b.querySelector('.mode-count').textContent = personas().filter((p) => (rpPersonaFlag(p) ? 'rp' : 'chat') === b.dataset.ptab).length;
  });
  $('#persona-new').textContent = '+ New';
  $('#chub-row').hidden = personaTab !== 'rp';
  $('#chub-browse').hidden = $('#botbooru-browse').hidden = $('#chararc-browse').hidden = personaTab !== 'rp' || !canBrowseChub();
  $('#persona-new').title = personaTab === 'rp' ? 'New roleplay character' : 'New assistant';
  const shown = personas().filter((p) => (rpPersonaFlag(p) ? 'rp' : 'chat') === personaTab && (!q || p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)));
  if (!shown.length) list.append(el('p', 'hint pad', q ? 'No matches.' : personaTab === 'rp' ? 'No characters yet – import a card or create one.' : 'No assistants yet.'));
  for (const p of shown) {
    const b = el('button', 'persona-item');
    b.append(avatarEl(p.avatar, 40));
    const t = el('div', 'persona-text');
    t.append(el('div', 'persona-title', p.name + (p.id === defaultChatPersona().id || p.id === defaultRpPersona().id ? ' · default' : '')), el('div', 'persona-desc', p.description || (p.card?.description ?? p.prompt).slice(0, 90)));
    b.append(t, el('span', 'chev', '›'));
    b.onclick = () => openPersonaEditor(p.id);
    list.append(b);
  }
}
document.querySelectorAll('#persona-tabs [data-ptab]').forEach((b) => (b.onclick = () => ((personaTab = b.dataset.ptab), renderPersonaManager())));
$('#persona-search').addEventListener('input', () => renderPersonaManager());
$('#open-personas').onclick = () => openPersonaManager();
$('#settings-personas').onclick = () => {
  openSheet('#settings-sheet', false);
  openPersonaManager();
};
$('#persona-new').onclick = () => openPersonaEditor(null, { rp: personaTab === 'rp' });
$('#persona-restore').onclick = () => {
  const n = restoreBuiltins(state.settings);
  saveSettings(state.settings);
  toast(n ? `Restored ${n} persona${n > 1 ? 's' : ''}` : 'All built-in personas are already there');
  openPersonaManager();
};

// Persona editor / system prompt creator
let draft = null;
let pendingArt; // undefined = unchanged, null = remove, string = new art

// ---------- per-persona voice (read aloud) ----------
function voiceLabel(v) {
  return `${v.name.replace(/[-_#]+/g, ' ').trim()}${v.lang ? ` · ${v.lang}` : ''}${v.network ? ' · online' : ''}`;
}
async function fillVoices(engine, selected) {
  const sel = $('#pe-voice');
  const status = $('#pe-voice-status');
  sel.innerHTML = '';
  sel.append(new Option('Default voice', ''));
  status.textContent = 'Loading voices…';
  try {
    const r = await listVoices(engine || null);
    const eng = $('#pe-voice-engine');
    if (!eng.options.length) {
      eng.append(new Option(`Phone default${r.defaultEngine ? ` (${(r.engines.find((e) => e.name === r.defaultEngine) || {}).label || r.defaultEngine})` : ''}`, ''));
      for (const e of r.engines) if (e.name !== 'browser') eng.append(new Option(e.label || e.name, e.name));
      eng.value = engine || '';
    }
    const vs = [...r.voices].sort((a, b) => (a.network - b.network) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    for (const v of vs) sel.append(new Option(voiceLabel(v), v.name));
    sel.value = vs.some((v) => v.name === selected) ? selected : '';
    status.textContent = vs.length ? `${vs.length} voices` : 'This engine reports no separate voices – it uses its default.';
  } catch (e) {
    status.textContent = e.message || 'Could not load voices';
  }
  updateVoiceSummary();
}
function updateVoiceSummary() {
  const v = $('#pe-voice').value;
  $('#pe-voice-sum').textContent = v ? `– ${$('#pe-voice').selectedOptions[0]?.textContent || v}` : '';
}
function initVoicePicker() {
  const box = $('#pe-voice-box');
  box.hidden = !canSpeak();
  if (box.hidden) return;
  $('#pe-voice-engine').innerHTML = '';
  $('#pe-voice').innerHTML = '';
  const v = draft.voice || {};
  box.open = false;
  $('#pe-voice-sum').textContent = v.name ? `– ${v.name}` : '';
  // voices load when the section is opened (asking the engines takes a moment)
  box.ontoggle = () => box.open && !$('#pe-voice').options.length && fillVoices(v.engine, v.name);
}
function readVoicePicker() {
  if (!$('#pe-voice').options.length) return draft.voice; // never opened: unchanged
  const name = $('#pe-voice').value;
  const engine = $('#pe-voice-engine').value;
  return name || engine ? { name: name || undefined, engine: engine || undefined } : undefined;
}
$('#pe-voice-engine').addEventListener('change', () => fillVoices($('#pe-voice-engine').value, ''));
$('#pe-voice').addEventListener('change', updateVoiceSummary);
$('#pe-voice-test').onclick = () => {
  const name = $('#pe-name').value.trim() || 'this persona';
  speak(`Hi, I'm ${name}. This is how I sound.`, { voice: $('#pe-voice').value || null, engine: $('#pe-voice-engine').value || null, rate: Number(pref('ttsRate')) || 1 }).catch((e) => toast(e.message));
};
/** A chat assistant waits for you to write first – the greeting field only matters for roleplay characters. */
function updateGreetingBox() {
  $('#pe-greeting-box').hidden = !($('#pe-rp').checked || draft?.cardMode || $('#pe-greeting').value.trim());
}
$('#pe-rp').addEventListener('change', updateGreetingBox);

// ---------- a persona's toolset (which tool groups its chats get, and single tools on top) ----------
let toolsetOn = new Set();
let pickOn = new Set(); // single tools given although their group is off
let pickOff = new Set(); // single tools taken away although their group is on
let toolMap = null; // { groups: [[key, label, names]], groupOf: { name: [keys] } } – read from the tool list once per editor
const openGroups = new Set();
const TOOL_BASE = { web: false, python: false, files: false, shell: false, browser: false, preview: false, delegate: false, claudecode: false, creator: false, phone: false, intents: false, device: false, phonectl: false, private: false, skills: false, autonomy: false, advisor: false, modAuthor: false, planMode: false, agents: [], models: [] };
/** Which tools each group brings (the ones every chat has are "base"): from the app's own tool list. */
function readToolMap() {
  const names = (en) => {
    try {
      return toolDefs(en).map((d) => d.function.name);
    } catch {
      return [];
    }
  };
  const base = names(TOOL_BASE);
  const baseSet = new Set(base);
  const mine = enabledToolsAll(state.current);
  const groupOf = Object.fromEntries(base.map((n) => [n, ['base']]));
  const groups = [['base', '⚙ In every chat', base]];
  for (const [k, label] of TOOL_GROUPS) {
    const v = mine[k] && mine[k] !== true ? mine[k] : k === 'skills' ? state.settings.agentSkills || [] : true;
    const list = k === 'mcp' || k === 'mods' ? [] : names({ ...TOOL_BASE, [k]: v }).filter((n) => !baseSet.has(n));
    for (const n of list) (groupOf[n] ||= []).push(k);
    groups.push([k, label, list]);
  }
  return { groups, groupOf };
}
const groupOnFor = (n) => (toolMap.groupOf[n] || []).some((g) => g === 'base' || toolsetOn.has(g));
const toolOn = (n) => (groupOnFor(n) ? !pickOff.has(n) : pickOn.has(n));
function paintToolset() {
  toolMap ||= readToolMap();
  const box = $('#pe-toolset');
  box.innerHTML = '';
  for (const [k, label, list] of toolMap.groups) {
    const row = el('div', 'toolset-group');
    if (k !== 'base') {
      const l = el('label', 'toggle small');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = toolsetOn.has(k);
      c.onchange = () => {
        if (c.checked) toolsetOn.add(k);
        else toolsetOn.delete(k);
        paintToolset();
      };
      l.append(c, el('span', null, label));
      row.append(l);
    }
    if (list.length) {
      const d = el('details', 'toolset-tools');
      d.dataset.group = k;
      d.open = openGroups.has(k);
      d.ontoggle = () => (d.open ? openGroups.add(k) : openGroups.delete(k));
      const on = list.filter(toolOn).length;
      d.append(el('summary', null, `${k === 'base' ? label + ' – ' : ''}${on} of ${list.length} tool${list.length === 1 ? '' : 's'}${on && k !== 'base' && !toolsetOn.has(k) ? ' (given one by one)' : ''}`));
      for (const n of list) {
        const l = el('label', 'toggle small tool-pick');
        const c = el('input');
        c.type = 'checkbox';
        c.dataset.tool = n;
        c.checked = toolOn(n);
        c.onchange = () => {
          if (groupOnFor(n)) c.checked ? pickOff.delete(n) : pickOff.add(n);
          else c.checked ? pickOn.add(n) : pickOn.delete(n);
          paintToolset();
        };
        const t = el('span');
        t.append(el('code', null, n));
        const what = TOOL_LABELS[n]?.[1];
        if (what) t.append(el('span', 'dim', ' ' + what));
        l.append(c, t);
        d.append(l);
      }
      row.append(d);
    }
    box.append(row);
  }
  sumToolset();
}
function sumToolset() {
  const n = toolsetOn.size;
  const v = $('#pe-tools-on').value;
  const picks = toolMap ? picksFrom(pickOn, pickOff, toolMap.groupOf, new Set([...toolsetOn, 'base'])) : null;
  const single = [picks?.on?.length && `+${picks.on.length}`, picks?.off?.length && `−${picks.off.length}`].filter(Boolean).join(' ');
  $('#pe-tools-sum').textContent = `(${v === 'off' ? 'off · ' : v === 'on' ? 'on · ' : ''}${n === TOOL_GROUPS.length ? 'all tools' : n ? `${n} of ${TOOL_GROUPS.length} groups` : 'no tools'}${single ? ` · ${single} single` : ''})`;
}
function fillToolset(p) {
  toolMap = null;
  openGroups.clear();
  toolsetOn = new Set(TOOL_GROUPS.map(([k]) => k).filter((k) => p.toolset?.[k] !== false));
  pickOn = new Set(p.toolPicks?.on || []);
  pickOff = new Set(p.toolPicks?.off || []);
  $('#pe-tools-on').value = p.tools === true ? 'on' : p.tools === false ? 'off' : '';
  paintToolset();
}
/** The assistant's add_tools / remove_tools (creatortools.js picksArg) over the persona's picks: a list given replaces that list. */
function mergePicks(old, p) {
  const on = p.keepOn ? old?.on || [] : p.on || [];
  const off = p.keepOff ? old?.off || [] : p.off || [];
  return on.length || off.length ? { ...(on.length ? { on } : {}), ...(off.length ? { off } : {}) } : undefined;
}
/** The single tools to store with the persona (only what differs from its groups). */
const toolPicksNow = () => (toolMap ? picksFrom(pickOn, pickOff, toolMap.groupOf, new Set([...toolsetOn, 'base'])) : undefined);
$('#pe-tools-on').onchange = sumToolset;
document.querySelectorAll('#pe-toolset-presets [data-preset]').forEach((b) => {
  b.onclick = () => {
    toolsetOn = new Set(TOOLSET_PRESETS[b.dataset.preset]);
    paintToolset();
  };
});

function openPersonaEditor(id, opts = {}) {
  const p = id ? personaById(id) : null;
  pendingArt = undefined;
  fillWriterModels();
  draft = p
    ? JSON.parse(JSON.stringify(p))
    : { id: null, name: '', description: '', avatar: { emoji: opts.rp ? '🎭' : '🤖', bg: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] }, prompt: '', rp: !!opts.rp };
  $('#pe-rp').checked = rpPersonaFlag(draft);
  $('#pe-rp').disabled = !!draft.cardMode;
  fillToolset(draft);
  $('#pe-title').textContent = p ? 'Edit persona' : 'New persona';
  $('#pe-name').value = draft.name;
  $('#pe-desc').value = draft.description || '';
  $('#pe-prompt').value = draft.prompt;
  $('#pe-emoji').value = draft.avatar.image ? '' : draft.avatar.emoji || '';
  $('#pe-temp').value = draft.temperature == null ? '' : String(draft.temperature);
  fillSamplerBox('pes', draft.samplers || {});
  initVoicePicker();
  $('#pe-samplers').open = !!draft.samplers;
  $('#pe-greeting').value = draft.card?.first_mes || '';
  updateGreetingBox();
  fillCtxSelect($('#pe-ctx'), draft.ctxLimit, 'Default (from Settings)');
  $('#pe-history').hidden = !draft.history?.length;
  const cm = !!draft.cardMode;
  $('#pe-card').hidden = !cm;
  $('#pe-prompt-block').hidden = cm;
  $('#pe-to-card').hidden = cm;
  const c = draft.card || {};
  $('#pc-desc').value = c.description || '';
  $('#pe-scenario-card').checked = !!draft.scenarioCard;
  $('#pc-personality').value = c.personality || '';
  $('#pc-scenario').value = c.scenario || '';
  $('#pc-examples').value = c.mes_example || '';
  $('#pc-note').value = c.depth_prompt?.prompt || '';
  $('#pc-note-depth').value = c.depth_prompt?.depth ?? 4;
  $('#pc-note-role').value = c.depth_prompt?.role || 'system';
  $('#pc-system').value = c.system_prompt || '';
  $('#pc-phi').value = c.post_history_instructions || '';
  $('#pc-creator').textContent = [c.creator_notes, c.creator && `by ${c.creator}`, c.tags?.length && `tags: ${c.tags.join(', ')}`, c.related_lorebooks?.length && `links ${c.related_lorebooks.length} lorebook(s) on chub.ai${c.chub_path ? ` (${c.chub_path})` : ''} – download it there and import it in 📚 Lorebooks`].filter(Boolean).join('\n');
  $('#pc-creator').hidden = !$('#pc-creator').textContent;
  $('#pe-alt-count').textContent = draft.card?.alternate_greetings?.length ? `+ ${draft.card.alternate_greetings.length} alternate greetings (swipe in chat)` : '';
  const lb = $('#pe-lorebook');
  lb.innerHTML = '';
  [['', 'None'], ...state.settings.lorebooks.map((b) => [b.id, `📚 ${b.name} (${b.entries.length})`])].forEach(([v, l]) => {
    const o = el('option', null, l);
    o.value = v;
    lb.append(o);
  });
  lb.value = draft.lorebookId && lorebookById(draft.lorebookId) ? draft.lorebookId : '';
  $('#pe-export').hidden = !p;
  $('#pe-to-chat').hidden = !p || !rpPersonaFlag(p);
  $('#pe-pin').hidden = !p || !Capacitor.isNativePlatform();
  const ms = $('#pe-model');
  ms.innerHTML = '';
  [['', 'Chat’s selected model (default)'], ...state.models.map((m) => [m.id, m.name])].forEach(([v, l]) => {
    const o = el('option', null, l);
    o.value = v;
    ms.append(o);
  });
  ms.value = draft.model && state.models.some((m) => m.id === draft.model) ? draft.model : '';
  $('#pe-default').checked = !!p && (p.id === state.settings.defaultPersonaId || p.id === state.settings.defaultRpPersonaId);
  $('#pe-delete').hidden = !p || personas().length <= 1;
  $('#pe-reset').hidden = !(p && builtinFor(p.id));
  $('#pe-gen-input').value = '';
  $('#pe-gen-status').textContent = '';
  renderAvatarEditor();
  openSheet('#personas-sheet', false);
  openSheet('#chat-sheet', false);
  openSheet('#persona-editor', true);
}

function renderAvatarEditor() {
  const slot = $('#pe-avatar');
  slot.innerHTML = '';
  slot.append(avatarEl(draft.avatar, 72));
  const colors = $('#pe-colors');
  colors.innerHTML = '';
  for (const c of AVATAR_COLORS) {
    const b = el('button', 'swatch' + (!draft.avatar.image && draft.avatar.bg === c ? ' active' : ''));
    b.style.background = c;
    b.setAttribute('aria-label', 'Color ' + c);
    b.onclick = () => {
      draft.avatar = { emoji: draft.avatar.emoji || $('#pe-emoji').value || '🤖', bg: c };
      renderAvatarEditor();
    };
    colors.append(b);
  }
  $('#pe-photo-remove').hidden = !draft.avatar.image;
}
$('#pe-emoji').addEventListener('input', () => {
  const v = [...new Intl.Segmenter().segment($('#pe-emoji').value.trim())].map((x) => x.segment)[0] || '';
  if (!v) return;
  draft.avatar = { emoji: v, bg: draft.avatar.bg || AVATAR_COLORS[0] };
  renderAvatarEditor();
});
$('#pe-photo').onclick = () => $('#pe-photo-input').click();
$('#pe-avatar').onclick = () => $('#pe-photo-input').click();
$('#pe-photo-input').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    draft.avatar = { ...draft.avatar, image: await imageToAvatar(f) };
    pendingArt = await imageToArt(f);
    renderAvatarEditor();
  } catch (err) {
    toast(err.message);
  }
};
$('#pe-photo-remove').onclick = () => {
  delete draft.avatar.image;
  pendingArt = null;
  if (!draft.avatar.emoji) draft.avatar.emoji = '🤖';
  if (!draft.avatar.bg) draft.avatar.bg = AVATAR_COLORS[0];
  renderAvatarEditor();
};

let genStream = null;
$('#pe-generate').onclick = () => {
  if (genStream) {
    genStream.cancel();
    genStream = null;
    $('#pe-generate').textContent = '✨ Generate';
    $('#pe-gen-status').textContent = 'Stopped.';
    return;
  }
  const idea = $('#pe-gen-input').value.trim() || $('#pe-name').value.trim();
  const status = $('#pe-gen-status');
  if (!idea) return (status.textContent = 'Describe the assistant you want first.');
  if (!state.settings.apiKey || !currentModel()) return (status.textContent = 'Set your API key and pick a model first.');
  const before = $('#pe-prompt').value;
  writePrompt({
    model: writerModel(state.settings.model),
    messages: [
      { role: 'system', content: P('prompt_writer') },
      { role: 'user', content: `Assistant description: ${idea}` + (before.trim() ? `\n\nCurrent draft to improve:\n${before}` : '') },
    ],
    onDone: () => {
      if (!$('#pe-name').value.trim() && $('#pe-gen-input').value.trim()) $('#pe-name').value = $('#pe-gen-input').value.trim().split(/\s+/).slice(0, 3).join(' ').replace(/^./, (c) => c.toUpperCase());
    },
  });
};

// ---------- roleplay character → chat persona ----------
// Rewrites a character card (and, from a roleplay chat, what happened in it) as a system prompt for a
// one-on-one chat persona that *is* the character – like a hand-written "You *are* Vesper…" prompt.

function personaSource(src, conv) {
  const c = src.card || {};
  const userN = conv ? userPersona(conv)?.name || 'User' : userPersonaById(state.settings.defaultUserPersonaId)?.name || 'User';
  const fill = (t) => fillMacros(String(t || ''), src.name, userN).trim();
  const parts = [`CHARACTER NAME: ${src.name}`, `THE USER'S NAME: ${userN}`];
  if (src.cardMode) {
    if (c.description) parts.push(`DESCRIPTION:\n${fill(c.description)}`);
    if (c.personality) parts.push(`PERSONALITY:\n${fill(c.personality)}`);
    if (c.scenario) parts.push(`SCENARIO (the roleplay's setup):\n${fill(c.scenario)}`);
    if (c.mes_example) parts.push(`EXAMPLE DIALOGUE FROM THE CARD:\n${fill(c.mes_example)}`);
    if (c.system_prompt) parts.push(`CARD'S OWN INSTRUCTIONS:\n${fill(c.system_prompt)}`);
    if (c.creator_notes) parts.push(`CREATOR NOTES:\n${fill(c.creator_notes).slice(0, 1500)}`);
  } else parts.push(`CHARACTER PROMPT:\n${fill(src.prompt)}`);
  if (conv) {
    const me = userPersona(conv);
    if (me?.description?.trim()) parts.push(`THE USER'S OWN PERSONA IN THE ROLEPLAY:\n${me.description.trim()}`);
    if (conv.story?.text?.trim()) parts.push(`STORY SO FAR (from the roleplay with the user):\n${conv.story.text.trim()}`);
    const recent = conv.messages
      .filter((m) => m.content && !m.greeting && typeof m.content === 'string')
      .slice(-30)
      .map((m) => `${m.role === 'user' ? userN : personaById(m.personaId)?.name || src.name}: ${m.content}`)
      .join('\n\n');
    if (recent) parts.push(`RECENT ROLEPLAY MESSAGES (for the voice and what the user is like):\n${recent.slice(-14000)}`);
  }
  return parts.join('\n\n');
}

/** Model that writes persona prompts: your pick in the editor, else the chat's / character's model. */
const writerModel = (fallback) => {
  const v = $('#pe-gen-model').value;
  if (v && state.models.some((x) => x.id === v)) return v;
  return (fallback && state.models.some((x) => x.id === fallback) && fallback) || state.settings.model;
};
function fillWriterModels() {
  const sel = $('#pe-gen-model');
  const keep = sel.value;
  sel.innerHTML = '';
  sel.append(new Option('Same as the chat', ''));
  for (const m of state.models) sel.append(new Option(m.name || m.id, m.id));
  sel.value = state.models.some((x) => x.id === keep) ? keep : state.settings.prefs?.personaWriter && state.models.some((x) => x.id === state.settings.prefs.personaWriter) ? state.settings.prefs.personaWriter : '';
}
$('#pe-gen-model').addEventListener('change', () => {
  state.settings.prefs = { ...state.settings.prefs, personaWriter: $('#pe-gen-model').value };
  saveSettings(state.settings);
});

/** Open the persona editor with a new chat persona made from `src` (its prompt is written by the model). */
async function makeChatPersona(src, conv = null) {
  if (!state.settings.apiKey) return toast('Set your API key first');
  openPersonaEditor(null, { rp: false });
  draft.avatar = JSON.parse(JSON.stringify(src.avatar || { emoji: '🤖', bg: AVATAR_COLORS[0] }));
  if (src.hasArt) pendingArt = (await art.get(src.id).catch(() => null)) || undefined;
  $('#pe-name').value = src.name;
  $('#pe-desc').value = `Chat persona of ${src.name}`.slice(0, 80);
  $('#pe-gen-input').value = `Chat persona made from the roleplay character ${src.name}${conv ? ' and your roleplay with them' : ''}`;
  renderAvatarEditor();
  const model = writerModel(conv?.model || src.model);
  writePrompt({
    model,
    messages: [
      { role: 'system', content: P('to_chat_persona') },
      { role: 'user', content: personaSource(src, conv) },
    ],
    doneMsg: `Done – read it over, edit anything, then Save. (It's a new persona; ${src.name} the roleplay character stays as it is.)`,
  });
}

/** Stream a generated system prompt into the editor's prompt box (Stop button, status line). */
function writePrompt({ model, messages, doneMsg = 'Done – edit it as you like.', onDone }) {
  const out = $('#pe-prompt');
  const status = $('#pe-gen-status');
  const before = out.value;
  const name = state.models.find((x) => x.id === model)?.name || model;
  out.value = '';
  status.textContent = `Writing with ${name}…`;
  $('#pe-generate').textContent = '■ Stop';
  let text = '';
  const finish = (msg) => {
    genStream = null;
    $('#pe-generate').textContent = '✨ Generate';
    status.textContent = msg;
  };
  genStream = streamChat(
    state.settings,
    // long output: lift any per-endpoint reply cap for this job
    { model, sessionId: 'persona-' + uid(), kind: 'persona', messages, samplers: { max_tokens: 8000 }, temperature: 0.7 },
    {
      onContent(t) {
        text += t;
        out.value = text.replace(/^```\w*\n?|```\s*$/g, '').trimStart();
        out.scrollTop = out.scrollHeight;
      },
      onReasoning() {
        status.textContent = `${name} is thinking…`;
      },
      onDone(reason) {
        if (!text.trim()) out.value = before;
        finish(!text.trim() ? 'No output. Try another model.' : reason === 'length' ? '⚠ Cut off (the model hit its length limit) – sections may be missing. Press ✨ Generate to extend it, or try another model.' : doneMsg);
        if (text.trim()) onDone?.();
      },
      onError(e) {
        if (!text.trim()) out.value = before;
        finish('✗ ' + e.message);
      },
    },
  );
}
$('#pe-to-chat').onclick = () => {
  const src = personaById(draft.id);
  if (!src) return;
  if (genStream) genStream.cancel();
  const conv = state.current && !isGroup() && chatPersona().id === src.id && state.current.messages.some((m) => !m.greeting) ? state.current : null;
  makeChatPersona(src, conv);
};

$('#pe-reset').onclick = () => {
  const b = builtinFor(draft.id);
  if (!b) return;
  $('#pe-prompt').value = b.prompt;
  $('#pe-name').value = b.name;
  $('#pe-desc').value = b.description;
  draft.avatar = { ...b.avatar };
  renderAvatarEditor();
};

$('#pe-to-card').onclick = () => {
  draft.cardMode = true;
  draft.card = { ...(draft.card || {}), description: draft.card?.description ?? $('#pe-prompt').value };
  $('#pc-desc').value = draft.card.description;
  $('#pe-card').hidden = false;
  $('#pe-prompt-block').hidden = true;
  $('#pe-to-card').hidden = true;
};
// ---------- version history of a persona's prompt ----------
const HIST_CARD_FIELDS = ['description', 'personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions', 'depth_prompt', 'first_mes'];
const histCard = (c) => (c ? Object.fromEntries(HIST_CARD_FIELDS.filter((k) => c[k] != null).map((k) => [k, c[k]])) : undefined);
function renderHistory() {
  const box = $('#history-list');
  box.innerHTML = '';
  const nowPrompt = draft.cardMode ? cardPrompt({ ...(draft.card || {}), description: $('#pc-desc').value, personality: $('#pc-personality').value, scenario: $('#pc-scenario').value, mes_example: $('#pc-examples').value, name: draft.name, alternate_greetings: draft.card?.alternate_greetings || [] }) : $('#pe-prompt').value;
  for (const h of draft.history || []) {
    const ops = lineDiff(h.prompt, nowPrompt);
    const st = diffStats(ops);
    const item = el('div', 'hist-item');
    const head = el('div', 'hist-head');
    head.append(el('span', null, new Date(h.at).toLocaleString()), el('span', 'dim', st.added || st.removed ? `now: +${st.added} −${st.removed} lines` : 'same as now'));
    const row = el('div', 'row gap-sm');
    const cmp = el('button', 'ghost-btn small', 'Compare with now');
    const res = el('button', 'primary-btn small', 'Restore into the editor');
    const out = el('div');
    cmp.onclick = () => {
      if (out.firstChild) return (out.innerHTML = '');
      const pre = el('pre', 'diff');
      for (const o of collapseDiff(ops)) pre.append(el('div', o.t === '+' ? 'd-add' : o.t === '-' ? 'd-del' : o.t === '…' ? 'd-skip' : '', o.t === '…' ? `… ${o.s} …` : `${o.t === ' ' ? '  ' : o.t + ' '}${o.s}`));
      out.append(pre, el('p', 'hint', '− = in that version only, + = in the editor now'));
    };
    res.onclick = () => {
      if (draft.cardMode && h.card) {
        $('#pc-desc').value = h.card.description || '';
        $('#pc-personality').value = h.card.personality || '';
        $('#pc-scenario').value = h.card.scenario || '';
        $('#pc-examples').value = h.card.mes_example || '';
        $('#pc-system').value = h.card.system_prompt || '';
        $('#pc-phi').value = h.card.post_history_instructions || '';
        $('#pc-note').value = h.card.depth_prompt?.prompt || '';
        $('#pe-greeting').value = h.card.first_mes || '';
      } else $('#pe-prompt').value = h.prompt;
      openSheet('#history-sheet', false);
      toast('Restored into the editor – tap Save to keep it');
    };
    row.append(cmp, res);
    item.append(head, row, out);
    box.append(item);
  }
}
$('#pe-history').onclick = () => {
  renderHistory();
  openSheet('#history-sheet', true);
};

$('#pe-save').onclick = () => {
  const name = $('#pe-name').value.trim();
  if (draft.cardMode) {
    // card fields → card; the flat prompt is kept for export / non-card use
    const nd = Number($('#pc-note-depth').value);
    draft.card = {
      ...(draft.card || {}),
      description: $('#pc-desc').value,
      personality: $('#pc-personality').value,
      scenario: $('#pc-scenario').value,
      mes_example: $('#pc-examples').value,
      system_prompt: $('#pc-system').value,
      post_history_instructions: $('#pc-phi').value,
      depth_prompt: $('#pc-note').value.trim() ? { prompt: $('#pc-note').value, depth: Number.isFinite(nd) ? Math.max(0, nd) : 4, role: $('#pc-note-role').value } : null,
    };
    draft.card.name = name;
    $('#pe-prompt').value = cardPrompt({ ...draft.card, alternate_greetings: draft.card.alternate_greetings || [] });
    if (!draft.card.description.trim()) return toast('Write a description for the character');
  }
  const prompt = $('#pe-prompt').value.trim();
  if (!name) return toast('Give the persona a name');
  if (!prompt) return toast('Write a system prompt (or tap ✨ Generate)');
  const temp = $('#pe-temp').value;
  const greeting = $('#pe-greeting').value;
  const card = greeting.trim() || draft.card ? { ...(draft.card || {}), first_mes: greeting } : undefined;
  draft.ctxLimit = $('#pe-ctx').value === '' ? undefined : Number($('#pe-ctx').value);
  draft.rp = $('#pe-rp').checked || undefined;
  const p = { ...draft, name, prompt, description: $('#pe-desc').value.trim(), temperature: temp === '' ? undefined : Number(temp), model: $('#pe-model').value || undefined, card, lorebookId: $('#pe-lorebook').value || undefined, samplers: readSamplerBox('pes'), voice: readVoicePicker(), scenarioCard: (draft.cardMode && $('#pe-scenario-card').checked) || undefined, tools: $('#pe-tools-on').value === 'on' ? true : $('#pe-tools-on').value === 'off' ? false : undefined, toolset: toolsetFrom([...toolsetOn]), toolPicks: toolPicksNow() };
  if (!p.id) {
    p.id = newPersonaId();
    state.settings.personas.push(p);
  } else {
    const i = state.settings.personas.findIndex((x) => x.id === p.id);
    // keep the version being replaced (only when the prompt or the character's definitions really changed)
    const old = state.settings.personas[i];
    if (old && (old.prompt !== p.prompt || JSON.stringify(histCard(old.card)) !== JSON.stringify(histCard(p.card)))) p.history = [{ at: Date.now(), prompt: old.prompt, card: histCard(old.card) }, ...(old.history || [])].slice(0, 20);
    state.settings.personas[i] = p;
  }
  if ($('#pe-default').checked) state.settings[rpPersonaFlag(p) ? 'defaultRpPersonaId' : 'defaultPersonaId'] = p.id;
  if (pendingArt !== undefined) {
    p.hasArt = !!pendingArt || undefined;
    art.put(p.id, pendingArt).then(applyChatArt).catch((e) => toast('Could not save the picture: ' + e.message));
  }
  saveSettings(state.settings);
  openSheet('#persona-editor', false);
  toast('Persona saved');
  updateShortcuts();
  if (!state.current.messages.length && !draft.id) state.current.personaId = p.id;
  updateHeader();
  renderMessages();
  renderConvList();
};

/** Export a character as a card: PNG (picture with the card inside – what Chub and SillyTavern use) or JSON. */
async function exportCharacter(p) {
  if (!p) return;
  const pick = await chooseOne(`Export ${p.name} as…`, [
    { label: 'PNG', sub: 'the picture with the card inside – for Chub, SillyTavern and most apps', value: 'PNG' },
    { label: 'JSON', sub: 'the card as text (character_book included)', value: 'JSON' },
  ]);
  if (!pick) return;
  const book = p.lorebookId ? lorebookById(p.lorebookId) : null;
  const base = p.name.replace(/[^\w-]+/g, '_') || 'character';
  try {
    if (pick.startsWith('JSON')) await shareBytes(`${base}.json`, new TextEncoder().encode(JSON.stringify(personaToCard(p, book), null, 2)));
    else await shareBytes(`${base}.png`, await exportCardPng(p, book, p.hasArt ? await art.get(p.id) : null));
  } catch (e) {
    if (!/cancel/i.test(e.message || '')) toast('Export failed: ' + e.message);
  }
}
hooks.exportCharacter = exportCharacter;
$('#pe-export').onclick = () => exportCharacter(personaById(draft.id));

// ---------- ⟳ re-import a character from where it came from ----------
/** A fingerprint of a card's picture: for a PNG only its pixel data (IDAT), since the card text lives in the same file. */
async function picHash(img) {
  if (!img) return '';
  const b = img instanceof Blob ? new Uint8Array(await img.arrayBuffer()) : new Uint8Array(img);
  let data = b;
  if (b[0] === 0x89 && b[1] === 0x50) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const parts = [];
    for (let at = 8; at + 8 <= b.length; ) {
      const len = dv.getUint32(at);
      if (String.fromCharCode(...b.subarray(at + 4, at + 8)) === 'IDAT') parts.push(b.subarray(at + 8, at + 8 + len));
      at += 12 + len;
    }
    if (parts.length) {
      data = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
      let o = 0;
      for (const x of parts) (data.set(x, o), (o += x.length));
    }
  }
  return shortHash(await sha256Hex(data));
}
const checks = new Map(); // persona id → { at, result }
/**
 * Download the newest version and compare it with what you have (nothing is changed yet).
 * → { card, image, book, changes: [...], picture: 'same' | 'changed' | 'unknown' | 'none', link }
 */
async function checkReimport(p, { fresh = false } = {}) {
  const c = checks.get(p.id);
  if (!fresh && c && Date.now() - c.at < 10 * 60 * 1000) return c.result;
  const link = cardSource(p);
  if (!link) throw new Error('This character has no link to download it from');
  const { bytes, name } = await downloadCardFromLink(link);
  const { card, image } = await readCard(new File([bytes], name, { type: 'image/png' }));
  if (!card?.name) throw new Error('The download was not a character card');
  const book = cardLorebook(card, 'lb_' + p.id);
  const oldBook = p.lorebookId ? lorebookById(p.lorebookId) : null;
  const key = (e) => ({ keys: e.keys, content: e.content, enabled: e.enabled !== false });
  const changes = cardChanges(p.card, card, oldBook ? oldBook.entries.map(key) : null, book ? book.entries.map(key) : null);
  const h = await picHash(image);
  const picture = !image ? 'none' : !p.sourcePicHash ? 'unknown' : p.sourcePicHash === h ? 'same' : 'changed';
  const result = { card, image, book, changes, picture, picHash: h, link };
  checks.set(p.id, { at: Date.now(), result });
  return result;
}
/** Apply a check: the text and lorebook, and the picture when usePicture. → the list of changes. */
async function applyReimportCheck(p, chk, usePicture) {
  let picture = null;
  if (usePicture && chk.image) {
    const file = new File([chk.image], 'card.png', { type: chk.image.type || 'image/png' });
    picture = { avatar: await imageToAvatar(file, 256), art: await imageToArt(file).catch(() => null) };
  }
  const r = await applyReimport(p, chk.card, chk.book, { lorebookById, newLorebook: (b) => (state.settings.lorebooks.push(b), b), cardPrompt, picture, putArt: (id, a) => art.put(id, a) });
  if (!p.sourceUrl) p.sourceUrl = chk.link;
  if (chk.picHash && (usePicture || !p.sourcePicHash)) p.sourcePicHash = chk.picHash; // the source's picture as of now
  checks.delete(p.id);
  saveSettings(state.settings);
  return r.changes;
}
/** The whole re-import, asking about the picture only when it differs from the one you got before. */
async function reimportCharacter(p, { force = false } = {}) {
  const chk = await checkReimport(p, { fresh: force });
  let usePicture = false;
  if (chk.picture === 'changed' || chk.picture === 'unknown' || (force && chk.image)) {
    const v = await chooseOne(
      chk.picture === 'changed' ? `${p.name}'s picture changed on ${sourceSite(chk.link)}` : `Also take ${p.name}'s picture from ${sourceSite(chk.link)}?`,
      [
        { label: 'Keep my picture', value: 'keep' },
        { label: 'Use the picture from ' + sourceSite(chk.link), value: 'new' },
      ],
    );
    if (v == null) return null;
    usePicture = v === 'new';
  }
  return applyReimportCheck(p, chk, usePicture);
}
hooks.checkReimport = checkReimport;
globalThis.__ocmClearReimportChecks = () => checks.clear(); // tests: the source changed
hooks.reimportCharacter = reimportCharacter;
hooks.undoReimport = (p) => {
  const ok = undoReimport(p, lorebookById);
  if (ok) saveSettings(state.settings);
  return ok;
};
hooks.cardSource = cardSource;
// after a re-import: names and pictures may have changed everywhere they are shown
hooks.renderPersonaLists = () => {
  updateHeader();
  if (!state.current.messages.some((m) => !m.greeting)) renderMessages();
  if ($('#personas-sheet')?.classList.contains('open')) renderPersonaManager();
};

// ---------- character card import ----------
$('#persona-import').onclick = () => $('#card-file').click();
/** Import one character card file (PNG / JSON / .charx) as a roleplay character. Returns the persona. */
async function importCardFile(f, { quiet = false } = {}) {
      const { card, image } = await readCard(f);
      const id = newPersonaId();
      let avatar = { emoji: '🎭', bg: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] };
      let hasArt;
      const sourcePicHash = await picHash(image).catch(() => '');
      if (image) {
        const file = new File([image], 'card.png', { type: image.type || 'image/png' });
        avatar = { ...avatar, image: await imageToAvatar(file, 256) };
        try {
          await art.put(id, await imageToArt(file));
          hasArt = true;
        } catch {
          /* keep just the avatar */
        }
      }
      const book = cardLorebook(card, 'lb_' + id);
      if (book) state.settings.lorebooks.push(book);
      state.settings.personas.push({
        id,
        name: card.name,
        avatar,
        description: (card.creator_notes || card.description).replace(/\s+/g, ' ').slice(0, 80),
        prompt: cardPrompt(card),
        card: { ...card, character_book: undefined },
        cardMode: true,
        lorebookId: book?.id,
        hasArt,
        ...(sourcePicHash ? { sourcePicHash } : {}),
      });
      saveSettings(state.settings);
      const notes = [book && `a ${book.entries.length}-entry lorebook`, card.depth_prompt && "a character's note", card.related_lorebooks?.length && `${card.related_lorebooks.length} linked chub lorebook${card.related_lorebooks.length > 1 ? 's' : ''} (import it from 📚 Lorebooks)`].filter(Boolean);
      if (!quiet) toast(`Imported ${card.name}${notes.length ? ' with ' + notes.join(', ') : ''}`, 4500);
      return state.settings.personas.find((p) => p.id === id);
}
/** Use a picture (data URL) as a persona's avatar and, for characters, its full card art. */
async function setPersonaPicture(p, dataUrl) {
  if (!p) return;
  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], 'picture.png', { type: blob.type || 'image/png' });
  p.avatar = { ...(p.avatar || { emoji: '🎭', bg: AVATAR_COLORS[0] }), image: await imageToAvatar(file, 256) };
  try {
    await art.put(p.id, await imageToArt(file));
    p.hasArt = true;
  } catch {
    /* keep just the avatar */
  }
  saveSettings(state.settings);
}
hooks.creator = {
  list: () => personas().map((p) => ({ id: p.id, name: p.name, kind: p.cardMode ? 'character' : 'persona', builtin: !!p.builtin, description: p.description || '', lorebook: p.lorebookId ? lorebookById(p.lorebookId)?.name || '' : '' })),
  // kind: 'character' (roleplay cards) or 'persona' (chat personas) – two things can share a name, e.g. a chat persona and the roleplay character made from it
  find: (q, kind) => {
    const pool = personas().filter((x) => (kind === 'character' ? !!x.cardMode : kind === 'persona' ? !x.cardMode : true));
    const r = findPersona(pool, q);
    return r.persona ? { id: r.persona.id, name: r.persona.name, builtin: !!r.persona.builtin, character: !!r.persona.cardMode } : r.candidates.length ? { ambiguous: r.candidates.map((x) => `${x.name} (${x.id}, ${x.cardMode ? 'roleplay character' : 'chat persona'})`) } : null;
  },
  read: (q) => {
    const p = findPersona(personas(), q).persona;
    if (!p) return null;
    return { id: p.id, name: p.name, builtin: !!p.builtin, character: !!p.cardMode, description: p.description || '', prompt: p.cardMode ? '' : p.prompt, card: p.cardMode ? { ...p.card, character_book: undefined } : null, lorebook: p.lorebookId ? lorebookById(p.lorebookId) : null, tools: p.tools ?? null, toolset: p.toolset ? TOOL_GROUPS.map(([k]) => k).filter((k) => p.toolset[k] !== false) : 'all', add_tools: p.toolPicks?.on || [], remove_tools: p.toolPicks?.off || [] };
  },
  edit: async (id, { persona, card, tools, toolset, toolPicks }) => {
    const t = personas().find((x) => x.id === id);
    if (!t) throw new Error('That persona no longer exists');
    if (card) {
      const c = { ...(t.card || {}), ...card, character_book: undefined };
      Object.assign(t, { name: c.name || t.name, description: (c.creator_notes || c.description || '').replace(/\s+/g, ' ').slice(0, 80), prompt: cardPrompt(c), card: c });
    }
    if (persona) {
      if (!t.builtin && persona.name) t.name = persona.name;
      if (persona.description != null) t.description = persona.description;
      if (persona.prompt != null) t.prompt = persona.prompt;
      if (persona.emoji) t.avatar = { ...(t.avatar || {}), emoji: persona.emoji };
    }
    if (typeof tools === 'boolean') t.tools = tools;
    if (Array.isArray(toolset)) t.toolset = toolsetFrom(toolset);
    if (toolPicks !== undefined) t.toolPicks = mergePicks(t.toolPicks, toolPicks);
    saveSettings(state.settings);
    renderConvList();
    updateShortcuts();
    if (state.current && chatPersona(state.current)?.id === id) hooks.toolsChanged?.();
  },
  remove: async (id) => {
    const t = personas().find((x) => x.id === id);
    if (!t) throw new Error('That persona no longer exists');
    if (t.builtin) throw new Error('Built-in personas cannot be deleted (they can be restored to the original in their editor)');
    state.settings.personas = personas().filter((p) => p.id !== id);
    art.remove(id).catch(() => {});
    state.settings.memories = (state.settings.memories || []).filter((m) => m.scope !== id);
    ensurePersonas(state.settings);
    saveSettings(state.settings);
    updateHeader();
    renderConvList();
  },
  removeLorebook: async (id) => {
    state.settings.lorebooks = (state.settings.lorebooks || []).filter((b) => b.id !== id);
    for (const p of personas()) if (p.lorebookId === id) delete p.lorebookId;
    saveSettings(state.settings);
  },
  findLorebook: (q) => {
    const s = String(q || '').toLowerCase().trim();
    const byName = (state.settings.lorebooks || []).find((b) => String(b.name || '').toLowerCase() === s || b.id === q);
    if (byName) return byName;
    const p = findPersona(personas(), q).persona;
    return p?.lorebookId ? lorebookById(p.lorebookId) : null;
  },
  setLoreEntries: async (id, entries) => {
    const b = lorebookById(id);
    if (!b) throw new Error('That lorebook no longer exists');
    b.entries = entries;
    saveSettings(state.settings);
  },
  character: async (card, image, replaceId, ts = {}) => {
    const applyTs = (t) => {
      if (typeof ts.tools === 'boolean') t.tools = ts.tools;
      if (Array.isArray(ts.toolset)) t.toolset = toolsetFrom(ts.toolset);
      if (ts.toolPicks !== undefined) t.toolPicks = mergePicks(t.toolPicks, ts.toolPicks);
    };
    if (replaceId) {
      const t = personas().find((x) => x.id === replaceId && x.cardMode);
      if (!t) throw new Error('That character no longer exists');
      const { card: c } = await readCard(new File([JSON.stringify(card)], 'card.json', { type: 'application/json' }));
      Object.assign(t, { name: c.name, description: (c.creator_notes || c.description).replace(/\s+/g, ' ').slice(0, 80), prompt: cardPrompt(c), card: { ...c, character_book: undefined } });
      if (c.character_book) {
        const book = cardLorebook(c, t.lorebookId || 'lb_' + t.id);
        if (book) {
          const i = state.settings.lorebooks.findIndex((b) => b.id === book.id);
          if (i >= 0) state.settings.lorebooks[i] = { ...state.settings.lorebooks[i], entries: book.entries };
          else state.settings.lorebooks.push(book);
          t.lorebookId = book.id;
        }
      }
      if (image) await setPersonaPicture(t, image);
      applyTs(t);
      saveSettings(state.settings);
      renderConvList();
      return { name: t.name, updated: true, lorebook: t.lorebookId ? lorebookById(t.lorebookId)?.entries.length : 0 };
    }
    const p = await importCardFile(new File([JSON.stringify(card)], `${card.data.name}.json`, { type: 'application/json' }));
    if (image) await setPersonaPicture(p, image);
    applyTs(p);
    saveSettings(state.settings);
    renderConvList();
    return { name: p.name, lorebook: p.lorebookId ? state.settings.lorebooks.find((b) => b.id === p.lorebookId)?.entries.length : 0 };
  },
  lorebook: async (name, json, attachTo) => {
    const id = 'lb_' + uid().slice(0, 8);
    const book = importLorebook(json, name, id);
    book.id = id;
    book.name = name;
    state.settings.lorebooks.push(book);
    let attached = '';
    if (attachTo) {
      const p = state.settings.personas.find((x) => x.name.toLowerCase() === attachTo.toLowerCase());
      if (p) {
        p.lorebookId = id;
        attached = p.name;
      }
    }
    saveSettings(state.settings);
    return { entries: book.entries.length, attached };
  },
  persona: async ({ name, prompt, description, emoji, tools, toolset, toolPicks, image, id }) => {
    // an existing persona (yours or a built-in one, found by id or name) is updated in place instead of copied
    const mine = state.settings.personas.find((p) => !p.cardMode && (id ? p.id === id : p.name.toLowerCase() === name.toLowerCase()));
    const avatar = { emoji: emoji || mine?.avatar?.emoji || '🧑‍🎨', bg: mine?.avatar?.bg || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] };
    const ts = { ...(typeof tools === 'boolean' ? { tools } : {}), ...(Array.isArray(toolset) ? { toolset: toolsetFrom(toolset) } : {}), ...(toolPicks !== undefined ? { toolPicks: mergePicks(mine?.toolPicks, toolPicks) } : {}) };
    if (mine) Object.assign(mine, { name: mine.builtin ? mine.name : name, prompt, description: description || mine.description, avatar: emoji || image ? avatar : mine.avatar, ...ts });
    else state.settings.personas.push({ id: newPersonaId(), name, avatar, description, prompt, ...ts });
    if (image) await setPersonaPicture(mine || state.settings.personas.find((p) => p.name === name), image);
    saveSettings(state.settings);
    updateShortcuts();
    return { updated: !!mine };
  },
};
function afterCardImport() {
  openPersonaManager('rp');
  if (appMode !== 'rp' && state.settings.personas.some((x) => x.cardMode)) setMode('rp'); // cards live on the Roleplay side
  else if (!state.current.messages.some((m) => !m.greeting)) renderMessages();
}
$('#card-file').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    try {
      await importCardFile(f);
    } catch (err) {
      toast(`${f.name}: ${err.message}`, 4500);
    }
  }
  afterCardImport();
};
// Paste a chub.ai / botbooru.com character link → download its card (with lorebook and full art) and import it
$('#chub-go').onclick = async () => {
  const link = $('#chub-url').value.trim();
  if (!link) return toast('Paste a chub.ai or botbooru.com character link');
  const btn = $('#chub-go');
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  try {
    const { bytes, name } = await downloadCardFromLink(link);
    const made = await importCardFile(new File([bytes], name, { type: 'image/png' }));
    if (made) (made.sourceUrl = link), saveSettings(state.settings); // for ⟳ Re-import later
    $('#chub-url').value = '';
    afterCardImport();
  } catch (err) {
    toast(`Couldn't import that link: ${err.message}`, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import';
  }
};
// 🌐 Browse Chub inside the app: each download is imported as it comes, and the site stays open for more
async function browseAndImport(site, btn) {
  btn.disabled = true;
  const names = [];
  let lastErr = '';
  // one item: imported quietly (the browser's own message bar says how it went – no second pop-up over it)
  const importItem = async (it) => {
    try {
      let made = null;
      if (it.link) {
        const { bytes, name } = await downloadCardFromLink(it.link);
        made = await importCardFile(new File([bytes], name, { type: 'image/png' }), { quiet: true });
        if (made) (made.sourceUrl = it.link), saveSettings(state.settings);
      } else {
        const bytes = bytesFromBase64(it.base64);
        const book = await importLorebookFile(it.name, bytes, { quiet: true });
        if (book) {
          names.push(book.name);
          return `Imported the lorebook “${book.name}” (${book.entries.length} entries)`;
        }
        made = await importCardFile(new File([bytes], it.name || 'card.png'), { quiet: true });
      }
      if (!made) throw new Error('not a character card');
      names.push(made.name);
      return `Imported ${made.name} ✓`;
    } catch (err) {
      lastErr = err.message;
      return `Couldn't import that: ${err.message}`;
    }
  };
  try {
    const { items = [] } = await browseSite(site, importItem); // the screen is open until the user closes it
    for (const it of items) await importItem(it); // older app screens hand everything back at the end
    if (names.length) {
      afterCardImport();
      toast(names.length === 1 ? `Imported ${names[0]}` : `Imported ${names.length}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`, 4500);
    } else if (lastErr) toast(`Couldn't import that download: ${lastErr}`, 5000);
  } catch (e) {
    toast(e.message || `Could not open the ${SITES[site]} browser`, 5000);
  } finally {
    btn.disabled = false;
  }
}
$('#chub-browse').onclick = () => browseAndImport('chub', $('#chub-browse'));
$('#botbooru-browse').onclick = () => browseAndImport('botbooru', $('#botbooru-browse'));
$('#chararc-browse').onclick = () => browseAndImport('chararc', $('#chararc-browse'));

/** A downloaded Chub lorebook (JSON with entries, no character) → lorebooks. Returns the lorebook when it was one. */
async function importLorebookFile(name, bytes, { quiet = false } = {}) {
  if (!/\.json$/i.test(name || '') && bytes[0] !== 0x7b) return false;
  let j;
  try {
    j = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return false;
  }
  const d = j?.data && (j.spec || j.data.name) ? j.data : j;
  if (d?.name && !j.entries && !d.entries) return false; // a character card
  if (!j.entries && !d?.entries) return false;
  const base = String(name || 'Lorebook').replace(/\.json$/i, '');
  const book = importLorebook(j.entries ? j : d, base, 'lb_' + uid().slice(0, 8));
  state.settings.lorebooks.push(book);
  saveSettings(state.settings);
  if (!quiet) toast(`Imported the lorebook “${book.name}” (${book.entries.length} entries) – find it under 📚 Lorebooks`, 5000);
  return book;
}
$('#chub-url').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), $('#chub-go').click()));

// ---------- lorebooks ----------
let loreBook = null;
function openLorebooks() {
  const list = $('#lb-list');
  list.innerHTML = '';
  if (!state.settings.lorebooks.length) list.append(el('p', 'hint pad', 'No lorebooks yet. Import a character card that has one, or create one.'));
  for (const b of state.settings.lorebooks) {
    const users = personas().filter((p) => p.lorebookId === b.id).map((p) => p.name);
    const row = el('button', 'persona-item');
    row.append(el('span', 'slash-cmd big', '📚'));
    const t = el('div', 'persona-text');
    t.append(el('div', 'persona-title', b.name), el('div', 'persona-desc', `${b.entries.length} entries${users.length ? ' · used by ' + users.join(', ') : ''}`));
    row.append(t, el('span', 'chev', '›'));
    row.onclick = () => editLorebook(b);
    list.append(row);
  }
  $('#lb-main').hidden = false;
  $('#lb-edit').hidden = true;
  ['#personas-sheet', '#chat-sheet', '#persona-editor'].forEach((x) => openSheet(x, false));
  openSheet('#lore-sheet', true);
}
function editLorebook(b) {
  loreBook = b;
  $('#lb-name').value = b.name;
  renderLoreEntries();
  $('#lb-main').hidden = true;
  $('#lb-edit').hidden = false;
}
function renderLoreEntries() {
  const wrap = $('#lb-entries');
  wrap.innerHTML = '';
  $('#lb-scan').value = loreBook.scanDepth ?? 4;
  $('#lb-budget').value = loreBook.budgetTokens ?? 2048;
  $('#lb-recursive').checked = loreBook.recursive !== false;
  loreBook.entries.forEach((e, i) => {
    const box = el('div', 'lore-entry' + (e.enabled !== false ? '' : ' off'));
    const field = (tag, cls, attrs, get, set) => {
      const x = el(tag, cls);
      Object.assign(x, attrs);
      if (x.type === 'checkbox') {
        x.checked = !!get();
        x.onchange = () => set(x.checked);
      } else {
        x.value = get() ?? '';
        x.oninput = () => set(x.value);
      }
      return x;
    };
    const keys = field('input', 'field', { placeholder: 'Keywords, comma separated (or /regex/i)' }, () => (e.keys || []).join(', '), (v) => (e.keys = v.split(',').map((k) => k.trim()).filter(Boolean)));
    const content = field('textarea', 'field', { rows: 3, placeholder: 'What the model should know when a keyword comes up' }, () => e.content, (v) => (e.content = v));
    const row = el('div', 'row lore-opts');
    const chk = (label, get, set) => {
      const l = el('label', 'toggle small');
      l.append(field('input', '', { type: 'checkbox' }, get, (v) => (set(v), box.classList.toggle('off', e.enabled === false))), el('span', null, label));
      return l;
    };
    const del = el('button', 'act', 'Delete');
    del.onclick = () => {
      loreBook.entries.splice(i, 1);
      renderLoreEntries();
    };
    row.append(chk('On', () => e.enabled !== false, (v) => (e.enabled = v)), chk('Always', () => e.constant, (v) => (e.constant = v)), del);
    // advanced
    const adv = el('details', 'lore-adv');
    adv.append(el('summary', null, 'More options'));
    const sel = (opts, get, set) => {
      const x = el('select', 'field');
      for (const [v, l] of opts) {
        const o = el('option', null, l);
        o.value = v;
        x.append(o);
      }
      x.value = get();
      x.onchange = () => set(x.value);
      return x;
    };
    const line = (label, ...els) => {
      const d = el('div', 'lore-line');
      d.append(el('span', 'lore-lbl', label), ...els);
      return d;
    };
    const sec = field('input', 'field', { placeholder: 'Optional filter keywords' }, () => (e.secondaryKeys || []).join(', '), (v) => {
      e.secondaryKeys = v.split(',').map((k) => k.trim()).filter(Boolean);
      e.selective = e.secondaryKeys.length > 0;
    });
    const logic = sel([['and_any', 'AND ANY of them'], ['and_all', 'AND ALL of them'], ['not_any', 'NOT ANY of them'], ['not_all', 'NOT ALL of them']], () => e.logic || 'and_any', (v) => (e.logic = v));
    const pos = sel([['before', 'Before the character'], ['after', 'After the character'], ['depth', 'In the chat, at depth…']], () => e.position || 'before', (v) => {
      e.position = v;
      depthBox.hidden = v !== 'depth';
    });
    const depthBox = el('span', 'lore-depth');
    depthBox.append(field('input', 'field num', { type: 'number', min: 0, max: 50 }, () => e.depth ?? 4, (v) => (e.depth = Number(v) || 0)), sel([['system', 'system'], ['user', 'user'], ['assistant', 'character']], () => e.role || 'system', (v) => (e.role = v)));
    depthBox.hidden = (e.position || 'before') !== 'depth';
    adv.append(
      line('Filter', sec, logic),
      line('Position', pos, depthBox),
      line('Order', field('input', 'field num', { type: 'number' }, () => e.order ?? 100, (v) => (e.order = Number(v) || 0)), el('span', 'hint inline', 'lower = earlier')),
      line('Chance %', field('input', 'field num', { type: 'number', min: 0, max: 100 }, () => e.probability ?? 100, (v) => (e.probability = Math.max(0, Math.min(100, Number(v) || 0))))),
      line('Timing', el('span', 'hint inline', 'sticky'), field('input', 'field num', { type: 'number', min: 0, max: 200, title: 'Stays on for this many messages after it fires' }, () => e.sticky || 0, (v) => (e.sticky = Math.max(0, Number(v) || 0))), el('span', 'hint inline', 'cooldown'), field('input', 'field num', { type: 'number', min: 0, max: 200, title: 'Cannot fire again for this many messages after it ends' }, () => e.cooldown || 0, (v) => (e.cooldown = Math.max(0, Number(v) || 0))), el('span', 'hint inline', 'delay'), field('input', 'field num', { type: 'number', min: 0, max: 1000, title: 'Not before the chat has this many messages' }, () => e.delay || 0, (v) => (e.delay = Math.max(0, Number(v) || 0)))),
      line('Match', chk('Case-sensitive', () => e.caseSensitive, (v) => (e.caseSensitive = v)), chk('Whole words', () => e.wholeWords !== false, (v) => (e.wholeWords = v))),
      line('Title', field('input', 'field', { placeholder: 'For you only – not sent' }, () => e.name, (v) => (e.name = v))),
    );
    box.append(keys, content, row, adv);
    wrap.append(box);
  });
}
$('#lb-scan').oninput = (e) => (loreBook.scanDepth = Math.max(1, Number(e.target.value) || 4));
$('#lb-budget').oninput = (e) => (loreBook.budgetTokens = Math.max(100, Number(e.target.value) || 2048));
$('#lb-recursive').onchange = (e) => (loreBook.recursive = e.target.checked);
$('#lb-import').onclick = () => $('#lb-file').click();
$('#lb-file').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    try {
      let book;
      if (/\.png$/i.test(f.name) || f.type === 'image/png' || /\.charx$/i.test(f.name)) {
        const { card } = await readCard(f);
        book = cardLorebook(card, 'lb_' + uid().slice(0, 8));
        if (!book) throw new Error('this card has no lorebook inside');
      } else book = importLorebook(JSON.parse(await f.text()), f.name.replace(/\.json$/i, ''), 'lb_' + uid().slice(0, 8));
      state.settings.lorebooks.push(book);
      saveSettings(state.settings);
      toast(`Imported “${book.name}” (${book.entries.length} entries)`);
    } catch (err) {
      toast(`${f.name}: ${err.message}`, 4500);
    }
  }
  openLorebooks();
};
$('#lb-add-entry').onclick = () => {
  loreBook.entries.push(newEntry());
  renderLoreEntries();
  $('#lb-entries').lastElementChild?.querySelector('input')?.focus();
};
$('#lb-save').onclick = () => {
  loreBook.name = $('#lb-name').value.trim() || 'Lorebook';
  loreBook.entries = loreBook.entries.filter((e) => e.content.trim() || e.keys.length);
  saveSettings(state.settings);
  toast('Lorebook saved');
  openLorebooks();
};
$('#lb-delete').onclick = () => {
  if (!confirm(`Delete lorebook “${loreBook.name}”?`)) return;
  state.settings.lorebooks = state.settings.lorebooks.filter((b) => b !== loreBook);
  personas().forEach((p) => p.lorebookId === loreBook.id && delete p.lorebookId);
  saveSettings(state.settings);
  openLorebooks();
};
$('#lb-new').onclick = () => {
  const b = newLorebook();
  state.settings.lorebooks.push(b);
  editLorebook(b);
};
$('#lb-back').onclick = openLorebooks;
$('#open-lorebooks').onclick = openLorebooks;

function renderChatLore() {
  const box = $('#chat-lore');
  const wasOpen = box.querySelector('details')?.open;
  box.innerHTML = '';
  if (!state.settings.lorebooks.length) return (box.hidden = true);
  box.hidden = false;
  const auto = new Set(autoLoreIds(state.current, chatPersona()));
  const on = (b) => auto.has(b.id) || (state.current.lorebookIds || []).includes(b.id);
  const active = state.settings.lorebooks.filter(on).length;
  // folded, searchable and scrollable: the list grows with every lorebook you add
  const det = el('details', 'pc-adv lore-pick');
  det.open = !!wasOpen;
  det.append(el('summary', null, `📚 World info for this chat `), Object.assign(el('span', 'dim'), { textContent: `(${active} on of ${state.settings.lorebooks.length})` }));
  det.querySelector('summary').append(det.lastChild);
  const search = el('input', 'field');
  search.type = 'search';
  search.placeholder = 'Search lorebooks…';
  search.hidden = state.settings.lorebooks.length < 7;
  const list = el('div', 'lore-list');
  const fill = () => {
    list.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    // the ones that are on come first
    const books = [...state.settings.lorebooks].filter((b) => !q || b.name.toLowerCase().includes(q)).sort((a, b) => Number(on(b)) - Number(on(a)));
    for (const b of books) {
      const l = el('label', 'toggle small');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = on(b);
      c.disabled = auto.has(b.id);
      c.onchange = () => {
        const ids = new Set(state.current.lorebookIds || []);
        c.checked ? ids.add(b.id) : ids.delete(b.id);
        state.current.lorebookIds = [...ids];
        persist();
        updateContextChip();
        det.querySelector('.dim').textContent = `(${state.settings.lorebooks.filter(on).length} on of ${state.settings.lorebooks.length})`;
      };
      l.append(c, el('span', null, `${b.name} (${b.entries.length})${auto.has(b.id) ? (userPersona(state.current)?.lorebookId === b.id ? ' – comes with your persona' : ' – comes with the character') : ''}`));
      list.append(l);
    }
    if (!books.length) list.append(el('p', 'hint', 'No lorebook matches.'));
  };
  search.oninput = fill;
  fill();
  det.append(search, list);
  box.append(det);
}

$('#pe-delete').onclick = () => {
  if (!confirm(`Delete persona “${draft.name}”? Chats that used it will switch to the default persona, and its learned memories are deleted.`)) return;
  state.settings.personas = personas().filter((p) => p.id !== draft.id);
  art.remove(draft.id).catch(() => {});
  state.settings.memories = (state.settings.memories || []).filter((m) => m.scope !== draft.id);
  ensurePersonas(state.settings);
  saveSettings(state.settings);
  openSheet('#persona-editor', false);
  updateHeader();
  renderMessages();
  renderConvList();
  openPersonaManager();
};

hooks.openChatSheet = () => openChatSheet();
hooks.openGroupEditor = () => openGroupEditor();
hooks.openPersonaEditor = (id) => openPersonaEditor(id);

export { draft, fillCtxSelect, fillPersonaSelect, makeChatPersona, openChatSheet, openGroupEditor, openPersonaEditor, renderStoryBox };

// ---------- ✨ lore suggestions ----------
function loreTarget() {
  const p = chatPersona();
  return p && !isGroup(state.current) ? p : null;
}
function updateLoreSuggestBtn() {
  $('#lore-suggest').hidden = !(convIsRp(state.current) && loreTarget() && state.current.messages.some((m) => m.role === 'user'));
}
async function runLoreSuggest() {
  const p = loreTarget();
  if (!p) return;
  const book = p.lorebookId ? lorebookById(p.lorebookId) : null;
  $('#loresug-intro').textContent = 'Reading the chat…';
  $('#loresug-list').innerHTML = '';
  $('#loresug-add').disabled = true;
  openSheet('#loresug-sheet', true);
  let list;
  try {
    list = await suggestLore(state.current, book?.entries || []);
  } catch (e) {
    $('#loresug-intro').textContent = 'Could not get suggestions: ' + e.message;
    return;
  }
  $('#loresug-intro').textContent = list.length ? `Entries the chat established. They go into ${book ? `“${book.name}”` : `a new lorebook for ${p.name}`}, so every chat with ${p.name} can use them. Untick any you don't want.` : 'Nothing new worth saving yet – keep playing and try again later.';
  const box = $('#loresug-list');
  list.forEach((s) => {
    const item = el('div', 'review-item');
    const head = el('label', 'toggle small');
    const c = el('input');
    c.type = 'checkbox';
    c.checked = true;
    s.pick = c;
    head.append(c, el('b', null, ` ${s.name}`), el('span', 'dim', `  🔑 ${s.keys.join(', ')}`));
    item.append(head, el('div', 'hint', s.content));
    box.append(item);
  });
  $('#loresug-add').disabled = !list.length;
  $('#loresug-add').onclick = () => {
    const chosen = list.filter((s) => s.pick.checked);
    if (!chosen.length) return toast('Nothing ticked');
    let target = book;
    if (!target) {
      target = newLorebook(`${p.name} – lore`);
      state.settings.lorebooks.push(target);
      personas().find((x) => x.id === p.id).lorebookId = target.id;
    }
    for (const s of chosen) target.entries.push({ ...newEntry(), name: s.name, keys: s.keys, content: s.content });
    saveSettings(state.settings);
    openSheet('#loresug-sheet', false);
    renderChatLore();
    updateContextChip();
    toast(`Added ${chosen.length} entr${chosen.length === 1 ? 'y' : 'ies'} to “${target.name}”`);
  };
}
$('#lore-suggest').onclick = runLoreSuggest;
$('#loresug-redo').onclick = runLoreSuggest;

// ---------- ✨ edit one card field with AI ----------
const AI_CHIPS = ['More concrete detail', 'Tighten it up', 'Fix grammar and typos', 'Show, don\'t tell', 'Make the tone darker', 'Make it warmer'];
const AI_SYSTEM = `You edit one field of a roleplay character card. You get the character's name, the field's current text, and an instruction.
Rewrite ONLY that field so it follows the instruction. Keep every fact, name and detail that the instruction does not ask you to change, keep the existing format and perspective, and keep {{char}} and {{user}} macros as they are. Do not add commentary, quotes around the text, or a heading – reply with the new field text and nothing else.`;
let aiPrev = null;
for (const c of AI_CHIPS) {
  const b = el('button', 'ghost-btn small', c);
  b.onclick = () => ($('#ai-inst').value = c);
  $('#ai-chips').append(b);
}
$('#ai-run').onclick = () => {
  const id = $('#ai-field').value;
  const ta = $('#' + id);
  const inst = $('#ai-inst').value.trim();
  const status = $('#ai-status');
  if (!inst) return (status.textContent = 'Say what should change first.');
  if (!ta.value.trim()) return (status.textContent = 'That field is empty – write something first, or use Generate.');
  if (!state.settings.apiKey || !currentModel()) return (status.textContent = 'Set your API key and pick a model first.');
  const before = ta.value;
  const model = learnCandidates(state.models, pref('helperModel'), state.settings.model)[0] || state.settings.model;
  $('#ai-run').disabled = true;
  status.textContent = 'Rewriting…';
  let out = '';
  streamChat(state.settings, { model, sessionId: 'card-edit', temperature: 0.6, kind: 'helper', messages: [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: `Character: ${$('#pe-name').value.trim() || 'unnamed'}\nField: ${$('#ai-field').selectedOptions[0].textContent}\n\nCurrent text:\n${before}\n\nInstruction: ${inst}` }] }, {
    onContent: (t) => (out += t),
    onReasoning: () => {},
    onDone: () => {
      $('#ai-run').disabled = false;
      const text = out.trim().replace(/^```\w*\n?|\n?```$/g, '');
      if (!text) return (status.textContent = 'The model sent nothing back.');
      aiPrev = { id, text: before };
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      $('#ai-undo').hidden = false;
      status.textContent = 'Done – check it, then Save. Not right? Undo.';
    },
    onError: (e) => {
      $('#ai-run').disabled = false;
      status.textContent = 'Failed: ' + e.message;
    },
  });
};
$('#ai-undo').onclick = () => {
  if (!aiPrev) return;
  $('#' + aiPrev.id).value = aiPrev.text;
  aiPrev = null;
  $('#ai-undo').hidden = true;
  $('#ai-status').textContent = 'Restored.';
};
