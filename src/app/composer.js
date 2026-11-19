// The message box: slash commands, snippets, attachments, and the model picker.
import { listModels } from '../api.js';
import { saveSettings, cache } from '../store.js';
import { readAttachment, fmtBytes, approxTokens } from '../files.js';
import { canReadClipboardImages, clipboardHasImage, filesFromBase64, readClipboardImages } from '../clip.js';
import { isFree, isContributor, replacementFor, trackNewModels } from '../models.js';
import { DEFAULT_SNIPPETS, applySnippet } from '../snippets.js';
import { projectCommands } from '../projectfiles.js';
import { looksText, bytesToText } from '../sandbox.js';
import { newChat, openDrawer, openSheet, persist } from './chatlist.js';
import { $, appMode, chatPersona, convIsRp, currentModel, effortOptions, el, fmtTokens, groupMembers, hooks, isGroup, personas, pref, rpPersonaFlag, state, supportsImages, toast, toolsOn, uid, userName } from './core.js';
import { avatarEl } from '../personas.js';
import { autoGrow, impersonate, input, send } from './engine.js';
import { modHost } from './modhost.js';
import { setupFence } from './fence.js';
import { loadWs, openFiles, openWsFile, setPreviewButton, setViewing, wsMem } from './extras.js';
import { renderMessages, updateContextChip } from './render.js';
import './ccmodels-ui.js';

// ---------- slash menu ----------
let slashSel = 0;
function slashMatches() {
  const v = input.value;
  const m = v.match(/^\/([\w-]*)$/) || v.match(/^\/([\w-]*)\s/);
  if (!m || (v.includes(' ') && !v.match(/^\/[\w-]*$/))) return null;
  const q = m[1].toLowerCase();
  const builtins = [{ id: 'b_imp', cmd: 'impersonate', title: `Write my next message (as ${userName()})`, text: '', builtin: 'impersonate' }, { id: 'b_compact', cmd: 'compact', title: 'Summarize older messages now (add what the summary must keep)', text: '', modCmd: true }, { id: 'b_voice', cmd: 'voice', title: 'Voice mode: talk and listen, hands-free (or hold the mic)', text: '', modCmd: true }, { id: 'b_polish', cmd: 'polish', title: 'Tidy my message (spelling, grammar, flow) before I send it', text: '', modCmd: true }, { id: 'b_guide', cmd: 'guide', title: 'Steer the next reply without saying anything (e.g. /guide she finally tells the truth)', text: '', modCmd: true }, { id: 'b_btw', cmd: 'btw', title: 'Ask a side question – answered beside the chat, not added to it (works while a reply runs)', text: '', modCmd: true }];
  if (toolsOn(state.current)) builtins.push({ id: 'b_plan', cmd: 'plan', title: state.current?.planMode ? 'Turn plan mode off' : 'Plan first: nothing changes until you approve', text: '', builtin: 'plan' });
  if (toolsOn(state.current)) builtins.push({ id: 'b_goal', cmd: 'goal', title: 'Keep working until this is done (/goal off to drop)', text: '', modCmd: true });
  const modCmds = modHost.commands().map((c) => ({ id: 'mod_' + c.mod + '_' + c.cmd, cmd: c.cmd, title: c.title, text: '', modCmd: true }));
  // project commands from the chat's workspace (.chronicle/commands/*.md, .claude/commands/*.md)
  const ws = state.current && wsMem.get(state.current.id);
  if (state.current && !ws) loadWs(state.current.id).catch(() => {});
  const proj = projectCommands(ws?.files, (b) => (looksText(b) ? bytesToText(b) : null)).map((c) => ({ id: 'p_' + c.cmd, cmd: c.cmd, title: '📁 ' + c.title, text: '', modCmd: true }));
  const recs = (hooks.recipeNames?.() || []).filter((r) => !proj.some((p) => p.cmd === r.name)).map((r) => ({ id: 'r_' + r.name, cmd: r.name, title: '🧪 ' + (r.description || 'Recipe'), text: '', modCmd: true }));
  const ours = [...builtins, ...proj, ...recs, ...state.settings.snippets.filter((x) => !proj.some((p) => p.cmd === x.cmd)), ...modCmds];
  // a Claude Code chat: Claude Code's own commands too, each marked; where Chronicle has one of the same name, both are
  // listed and Chronicle's is marked as well (decision 173)
  const cc = hooks.ccShown?.() ? hooks.ccCommands?.() || [] : [];
  const ccItems = cc.map((c) => ({ id: 'cc_' + c.name, cmd: c.name, title: c.description + (c.hint ? ` (${c.hint})` : ''), text: '', cc: true }));
  const names = new Set(cc.map((c) => c.name.toLowerCase()));
  for (const o of ours) if (names.has(o.cmd.toLowerCase())) o.chronicle = true;
  const all = [];
  for (const o of ours) {
    all.push(o);
    const twin = ccItems.find((c) => c.cmd.toLowerCase() === o.cmd.toLowerCase());
    if (twin) all.push(twin); // right under Chronicle's, so the two are seen together
  }
  all.push(...ccItems.filter((c) => !all.includes(c)));
  return all.filter((s) => s.cmd.toLowerCase().startsWith(q) || s.title.toLowerCase().includes(q));
}
function hideSlash() {
  $('#slash-menu').hidden = true;
}
function updateSlash() {
  const menu = $('#slash-menu');
  const list = slashMatches();
  if (!list) return updateMentions();
  menu.innerHTML = '';
  slashSel = Math.min(slashSel, Math.max(0, list.length - 1));
  list.slice(0, hooks.ccShown?.() ? 12 : 8).forEach((s, i) => {
    const b = el('button', 'slash-item' + (i === slashSel ? ' sel' : ''));
    // whose command it is, at the start of its description – the columns stay where every other row has them
    const title = el('span', 'slash-title');
    if (s.cc) title.append(el('span', 'slash-tag cc', 'Claude Code'), ' ');
    else if (s.chronicle) title.append(el('span', 'slash-tag', 'Chronicle'), ' ');
    title.append(s.title + (s.send ? ' ⏎' : ''));
    b.append(el('span', 'slash-cmd', '/' + s.cmd), title);
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => pickSnippet(s);
    menu.append(b);
  });
  const manage = el('button', 'slash-item manage', '⚡ Manage snippets…');
  manage.onmousedown = (e) => e.preventDefault();
  manage.onclick = () => {
    hideSlash();
    openSnippets();
  };
  menu.append(manage);
  menu.hidden = false;
}
function pickSnippet(s) {
  hideSlash();
  if (s.cc) {
    // Claude Code's command: it goes to Claude Code as it is, past a Chronicle command of the same name
    input.value = `/${s.cmd} `;
    input.dataset.ccCmd = s.cmd;
    autoGrow();
    return input.focus();
  }
  if (s.modCmd) {
    input.value = `/${s.cmd} `;
    autoGrow();
    return input.focus();
  }
  if (s.builtin === 'plan') {
    input.value = '';
    autoGrow();
    return hooks.togglePlanMode?.();
  }
  if (s.builtin === 'impersonate') {
    input.value = '';
    return impersonate();
  }
  const rest = input.value.replace(/^\/[\w-]*\s?/, '');
  if (s.send) {
    input.value = applySnippet(s, rest);
    return send();
  }
  // insert the template; put the cursor where {{text}} was
  const filled = s.text.includes('{{text}}') ? s.text.replace('{{text}}', rest) : s.text + (rest ? '\n\n' + rest : '\n\n');
  input.value = filled;
  const pos = s.text.includes('{{text}}') ? s.text.indexOf('{{text}}') + rest.length : filled.length;
  input.focus();
  input.setSelectionRange(pos, pos);
  autoGrow();
}
input.addEventListener('keydown', (e) => {
  if ($('#slash-menu').hidden) return;
  const items = [...$('#slash-menu').querySelectorAll('.slash-item:not(.manage)')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    slashSel = (slashSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    updateSlash();
  } else if ((e.key === 'Enter' || e.key === 'Tab') && items[slashSel]) {
    e.preventDefault();
    e.stopImmediatePropagation();
    items[slashSel].click();
  } else if (e.key === 'Escape') hideSlash();
}, true);
input.addEventListener('blur', () => setTimeout(() => document.activeElement !== input && hideSlash(), 150)); // a redraw elsewhere can blur it for a moment

// ---------- @mention suggestions: call a persona into this chat ----------
function mentionQuery() {
  const pos = input.selectionStart ?? input.value.length;
  const m = input.value.slice(0, pos).match(/(?:^|\s)@([\p{L}\p{N}_./-]*)$/u);
  return m ? { q: m[1].toLowerCase(), start: pos - m[1].length - 1, end: pos } : null;
}
function updateMentions() {
  const menu = $('#slash-menu');
  const mq = state.current && mentionQuery();
  if (!mq) return hideSlash();
  const rp = convIsRp(state.current);
  const inChat = isGroup() ? groupMembers() : [chatPersona()];
  const others = personas().filter((p) => rpPersonaFlag(p) === rp && !inChat.some((x) => x.id === p.id));
  const list = mq.q.includes('/') || mq.q.includes('.') ? [] : [...inChat.map((p) => [p, true]), ...others.map((p) => [p, false])].filter(([p]) => !mq.q || p.name.toLowerCase().includes(mq.q));
  // workspace files: @path attaches the file's text to the message (like Claude Code)
  const ws = wsMem.get(state.current.id);
  if (!ws) loadWs(state.current.id).then(() => mentionQuery() && updateMentions()).catch(() => {});
  const files = Object.keys(ws?.files || {})
    .filter((f) => !f.startsWith('.out/') && (!mq.q || f.toLowerCase().includes(mq.q)))
    .sort((a, b) => (a.toLowerCase().startsWith(mq.q) ? 0 : 1) - (b.toLowerCase().startsWith(mq.q) ? 0 : 1) || a.length - b.length)
    .slice(0, mq.q ? 6 : 4);
  if (!list.length && !files.length) return hideSlash();
  menu.innerHTML = '';
  slashSel = Math.min(slashSel, list.length + files.length - 1);
  const fileBtns = files.map((f, j) => {
    const i = list.slice(0, 8).length + j;
    const b = el('button', 'slash-item mention-item' + (i === slashSel ? ' sel' : ''));
    b.append(el('span', 'slash-cmd', '📄 @' + f), el('span', 'slash-title', 'attach this file'));
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      const tag = '@' + f + ' ';
      input.value = input.value.slice(0, mq.start) + tag + input.value.slice(mq.end);
      const pos = mq.start + tag.length;
      hideSlash();
      input.focus();
      input.setSelectionRange(pos, pos);
      autoGrow();
    };
    return b;
  });
  list.slice(0, 8).forEach(([p, member], i) => {
    const b = el('button', 'slash-item mention-item' + (i === slashSel ? ' sel' : ''));
    b.append(avatarEl(p.avatar, 22), el('span', 'slash-cmd', '@' + p.name), el('span', 'slash-title', member ? (isGroup() ? 'in this group' : 'this chat') : 'replies once, as a guest'));
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      const tag = '@' + p.name.split(/\s+/)[0] + ' ';
      input.value = input.value.slice(0, mq.start) + tag + input.value.slice(mq.end);
      const pos = mq.start + tag.length;
      hideSlash();
      input.focus();
      input.setSelectionRange(pos, pos);
      autoGrow();
    };
    menu.append(b);
  });
  menu.append(...fileBtns);
  menu.hidden = false;
}

// ---------- quick-reply bar: snippets shown as buttons above the message box ----------
function renderQuickBar() {
  const bar = $('#quick-bar');
  if (!bar) return;
  const items = (state.settings.snippets || []).filter((s) => s.bar === 'all' || s.bar === appMode);
  bar.innerHTML = '';
  for (const s of items) {
    const b = el('button', 'chip quick-reply', s.title || '/' + s.cmd);
    b.title = s.send ? 'Sends right away' : 'Puts it in the box';
    b.onclick = () => {
      input.value = applySnippet(s, input.value);
      input.dispatchEvent(new Event('input'));
      if (s.send) $('#send-btn').click();
      else input.focus();
    };
    bar.append(b);
  }
  bar.hidden = !items.length;
}
hooks.renderQuickBar = renderQuickBar;
// ---------- snippets manager ----------
let snipDraft = null;
function openSnippets() {
  renderQuickBar();
  const list = $('#snip-list');
  list.innerHTML = '';
  for (const s of state.settings.snippets) {
    const b = el('button', 'persona-item');
    b.append(el('span', 'slash-cmd big', '/' + s.cmd));
    const t = el('div', 'persona-text');
    t.append(el('div', 'persona-title', s.title + (s.send ? ' · sends right away' : '') + (s.bar ? ' · on the bar' : '')), el('div', 'persona-desc', s.text.replace(/\s+/g, ' ').slice(0, 90)));
    b.append(t, el('span', 'chev', '›'));
    b.onclick = () => editSnippet(s);
    list.append(b);
  }
  $('#snip-editor').hidden = true;
  $('#snip-main').hidden = false;
  openDrawer(false);
  openSheet('#settings-sheet', false);
  openSheet('#snippets-sheet', true);
}
function editSnippet(s) {
  snipDraft = s ? { ...s } : { id: 's_' + uid().slice(0, 8), cmd: '', title: '', text: '{{text}}', send: false };
  $('#snip-cmd').value = snipDraft.cmd;
  $('#snip-title').value = snipDraft.title;
  $('#snip-text').value = snipDraft.text;
  $('#snip-send').checked = !!snipDraft.send;
  $('#snip-bar').value = snipDraft.bar || '';
  $('#snip-delete').hidden = !s;
  $('#snip-main').hidden = true;
  $('#snip-editor').hidden = false;
}
$('#snip-new').onclick = () => editSnippet(null);
$('#snip-back').onclick = openSnippets;
$('#snip-save').onclick = () => {
  const cmd = $('#snip-cmd').value.trim().replace(/^\//, '').replace(/[^\w-]/g, '');
  if (!cmd) return toast('Give it a command name, e.g. "fix"');
  if (state.settings.snippets.some((x) => x.cmd.toLowerCase() === cmd.toLowerCase() && x.id !== snipDraft.id)) return toast(`/${cmd} already exists`);
  const text = $('#snip-text').value;
  if (!text.trim()) return toast('Write the snippet text');
  const s = { ...snipDraft, cmd, title: $('#snip-title').value.trim() || cmd, text, send: $('#snip-send').checked, bar: $('#snip-bar').value || undefined };
  const i = state.settings.snippets.findIndex((x) => x.id === s.id);
  if (i >= 0) state.settings.snippets[i] = s;
  else state.settings.snippets.push(s);
  saveSettings(state.settings);
  openSnippets();
};
$('#snip-delete').onclick = () => {
  state.settings.snippets = state.settings.snippets.filter((x) => x.id !== snipDraft.id);
  saveSettings(state.settings);
  openSnippets();
};
$('#snip-restore').onclick = () => {
  let n = 0;
  for (const d of DEFAULT_SNIPPETS) if (!state.settings.snippets.some((x) => x.id === d.id || x.cmd === d.cmd)) (state.settings.snippets.push({ ...d }), n++);
  saveSettings(state.settings);
  toast(n ? `Restored ${n} snippet${n > 1 ? 's' : ''}` : 'All default snippets are there');
  openSnippets();
};
$('#settings-snippets').onclick = openSnippets;
input.addEventListener('keydown', (e) => {
  // Enter sends on hardware keyboards; on touch devices Enter inserts a newline.
  if (e.key === 'Enter' && !e.shiftKey && (pref('enterSends') || !matchMedia('(pointer: coarse)').matches)) {
    e.preventDefault();
    send();
  }
});
$('#drawer-new').onclick = () => {
  newChat({ focus: true });
  openDrawer(false);
};

// ---------- attachments ----------
let attaching = 0;
// the paperclip opens a small menu of quick actions (like Chub's ⋮ by the message box)
$('#attach-btn').onclick = () => {
  const r = $('#attach-btn').getBoundingClientRect();
  $('#cmp-impersonate').hidden = !state.current?.messages?.some((m) => !m.greeting);
  openSheet('#compose-menu', true);
  const card = $('#compose-menu .sheet-card');
  card.style.width = Math.min(264, window.innerWidth - 16) + 'px';
  card.style.left = Math.max(8, r.left) + 'px';
  requestAnimationFrame(() => (card.style.top = Math.max(8, r.top - card.getBoundingClientRect().height - 8) + 'px'));
};
const closeCompose = () => openSheet('#compose-menu', false);
$('#cmp-attach').onclick = () => (closeCompose(), $('#file-input').click());
$('#cmp-persona').onclick = () => (closeCompose(), hooks.openChatSheet?.());
$('#cmp-impersonate').onclick = () => (closeCompose(), impersonate());
$('#cmp-ptest').onclick = () => (closeCompose(), $('#cm-ptest').click());
$('#cmp-inspect').onclick = () => (closeCompose(), $('#cm-inspect').click());
$('#file-input').onchange = async (e) => {
  const picked = [...e.target.files];
  e.target.value = '';
  attachFiles(picked);
};
export async function attachFiles(picked) {
  const errors = [];
  attaching++;
  renderAttachments();
  for (const f of picked) {
    try {
      state.pending.push(await readAttachment(f, { allowImages: supportsImages(currentModel()) }));
    } catch (err) {
      errors.push(err.message || `Could not read ${f.name}`);
    }
    renderAttachments();
  }
  if (errors.length) toast(errors.join('\n'), 3500 + 1500 * errors.length);
  attaching--;
  renderAttachments();
}

// ---------- pasting pictures ----------
// 1. the paste event (long-press › Paste, keyboards that hand over pictures, Ctrl+V on a computer)
$('#input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  attachFiles(files);
});
// 1b. a picture the keyboard sends straight into the box (Gboard's clipboard history, stickers, GIFs) – see OcmWebView
globalThis.__ocmCommit = (mime, base64) => attachFiles(filesFromBase64([{ mime, base64 }]));
// 2. the phone's clipboard: when it holds a picture (just copied), offer to paste it
let clipStamp = 0;
let clipDismissed = 0;
async function offerClipboardImage() {
  const bar = $('#clip-offer');
  const { has, stamp } = await clipboardHasImage();
  const fresh = has && stamp !== clipDismissed;
  bar.hidden = !fresh;
  clipStamp = stamp;
}
$('#clip-paste').onclick = async () => {
  $('#clip-offer').hidden = true;
  clipDismissed = clipStamp;
  try {
    const files = await readClipboardImages();
    if (!files.length) return toast('No picture on the clipboard');
    attachFiles(files);
  } catch (e) {
    toast(e.message || 'Could not paste the picture');
  }
};
$('#clip-x').onclick = () => {
  clipDismissed = clipStamp;
  $('#clip-offer').hidden = true;
};
if (canReadClipboardImages()) {
  $('#input').addEventListener('focus', offerClipboardImage);
  document.addEventListener('visibilitychange', () => !document.hidden && offerClipboardImage());
  setTimeout(offerClipboardImage, 1500);
}

function fileChip(f, onRemove) {
  const chip = el('div', 'file-chip');
  const ext = f.name.includes('.') ? f.name.split('.').pop() : 'txt';
  chip.append(el('span', 'file-icon', (f.zip ? 'zip' : f.note?.startsWith('PDF') ? 'pdf' : ext).slice(0, 4).toUpperCase()));
  const info = el('div', 'file-info');
  info.append(el('div', 'file-name', f.name));
  const meta = [f.note || (f.size != null ? fmtBytes(f.size) : ''), f.zip ? 'extracted to workspace' : `~${approxTokens(f.text).toLocaleString()} tokens`, f.truncated && !f.zip ? 'truncated' : '']
    .filter(Boolean)
    .join(' · ');
  info.append(el('div', 'file-meta', meta));
  chip.append(info);
  if (onRemove) {
    const x = el('button', 'file-x', '×');
    x.setAttribute('aria-label', `Remove ${f.name}`);
    x.onclick = onRemove;
    chip.append(x);
  } else {
    chip.onclick = () => (f.zip ? openFiles() : openFilePreview(f));
  }
  return chip;
}

async function openFilePreview(f) {
  if (f.inWorkspace && state.current) {
    const w = await loadWs(state.current.id);
    if (w.files[f.inWorkspace]) return openWsFile(f.inWorkspace);
  }
  // older messages: only the extracted text was kept
  setViewing({ name: f.note?.startsWith('PDF') ? f.name.replace(/\.pdf$/i, '') + '.txt' : f.name, bytes: new TextEncoder().encode(f.text || '') });
  $('#preview-actions').hidden = false;
  $('#preview-delete').hidden = true;
  setPreviewButton(f.name);
  $('#preview-img').hidden = true;
  $('#preview-body').hidden = false;
  $('#preview-title').textContent = f.name;
  $('#preview-body').textContent = f.text.length > 60000 ? f.text.slice(0, 60000) + '\n\n… (preview cut off)' : f.text;
  openSheet('#preview-sheet', true);
}

function renderAttachments() {
  setTimeout(() => hooks.updateSend?.(), 0);
  const a = $('#attachments');
  a.innerHTML = '';
  state.pending.forEach((att, i) => {
    const remove = () => {
      state.pending.splice(i, 1);
      renderAttachments();
    };
    if (att.kind === 'image') {
      const t = el('div', 'thumb');
      const img = el('img');
      img.src = att.src;
      const x = el('button', 'thumb-x', '×');
      x.onclick = remove;
      t.append(img, x);
      a.append(t);
    } else a.append(fileChip(att, remove));
  });
  if (attaching) a.append(el('div', 'file-chip loading', 'Reading…'));
  const tokens = state.pending.reduce((n, x) => n + (x.text && !(x.zip && toolsOn()) ? approxTokens(x.text) : 0), 0);
  const ctx = currentModel()?.limit?.context;
  if (ctx && tokens > ctx * 0.8) a.append(el('div', 'attach-warn', `Attachments (~${tokens.toLocaleString()} tokens) may not fit ${currentModel().name}'s context window.`));
}

// ---------- models ----------
/** The model this chat uses: the selected one, the one its roleplay preset picks, or a Claude Code one (decision 165). */
const shownModel = () => {
  const cc = hooks.ccShown?.();
  if (cc) return cc;
  const here = hooks.presetHere?.();
  return here?.decides ? state.models.find((x) => x.id === here.model) || currentModel() : currentModel();
};
function updateModelUI() {
  const here = hooks.presetHere?.();
  const m = shownModel();
  const label = m?.source === 'claudecode' && !m.name.startsWith('Claude Code') ? `Claude Code · ${m.name}` : m?.name;
  $('#model-name').textContent = (m ? label : state.settings.model || 'Select model') + (here?.decides && !here.pinned ? ` · ${here.preset?.name || 'preset'}` : '');
  $('#model-btn').title = here?.decides && !here.pinned ? `Picked by the roleplay preset “${here.preset?.name}”` : '';
  renderAttachments();
  updateContextChip();
  const opts = effortOptions(m);
  const eb = $('#effort-btn');
  eb.hidden = !opts.length;
  const cur = here?.decides ? here.effort : state.settings.effort?.[m?.id];
  eb.textContent = `🧠 ${opts.includes(cur) ? cur : 'default'}`;
  hooks.updatePresetChip?.();
}
hooks.updateModelUI = () => updateModelUI();
// the chat's start screen names the same model as the header (not the app-wide default a Claude Code or preset chat does not use)
hooks.shownModelName = () => { const m = shownModel(); return m ? (m.source === 'claudecode' && !m.name.startsWith('Claude Code') ? `Claude Code · ${m.name}` : m.name) : ''; };

$('#effort-btn').onclick = () => {
  const here = hooks.presetHere?.();
  if (here?.decides && !here.pinned && here.preset?.effort) return toast(`The effort is set in the preset “${here.preset.name}” (Settings › Roleplay prompts & preset)`);
  const m = shownModel();
  const opts = ['default', ...effortOptions(m)];
  const cur = state.settings.effort?.[m.id] || 'default';
  const next = opts[(opts.indexOf(cur) + 1) % opts.length];
  state.settings.effort = { ...state.settings.effort, [m.id]: next === 'default' ? undefined : next };
  saveSettings(state.settings);
  updateModelUI();
};

const modelNameOf = (id) => state.models.find((x) => x.id === id)?.name || id || 'another model';
const DEFAULT_MODELS = ['glm-5.3', 'kimi-k3', 'deepseek-v4-pro'];
let modelNews = cache('modelNews');
const isNew = (m) => !!modelNews?.fresh?.[m.id];

let goRetries = 0; // OpenCode's model list asked again after it did not come
async function refreshModels(silent) {
  let fresh = false;
  try {
    let models = await listModels(state.settings);
    // OpenCode did not answer this time (decision 193): its models from the last good list stay, and nobody is switched
    // away from one – they were never "no longer available", only not fetched
    const failed = new Set(models.failedProviders || []);
    const partial = !!models.goFailed || failed.size > 0;
    if (partial) {
      const ids = new Set(models.map((m) => m.id));
      const kept = state.models.filter((m) => !ids.has(m.id) && ((models.goFailed && !m.source) || (m.source === 'custom' && failed.has(m.providerId))));
      models = [...kept, ...models];
    }
    // …and it is asked again a little later (no restart needed): after 10 s, 30 s, 90 s
    if (partial && goRetries < 3) setTimeout(() => refreshModels(true), [10000, 30000, 90000][goRetries++]);
    else if (!partial) goRetries = 0;
    if (models.length) {
      const before = state.models;
      state.models = models;
      cache('models', models);
      modelNews = trackNewModels(models, modelNews);
      cache('modelNews', modelNews);
      fresh = true;
      // The selected model was removed or renamed by OpenCode → switch to the closest one.
      const sel = state.settings.model;
      if (sel && !partial && !models.some((m) => m.id === sel)) {
        const old = before.find((m) => m.id === sel);
        const rep = replacementFor(sel, old, models, DEFAULT_MODELS);
        state.settings.model = rep.id;
        saveSettings(state.settings);
        toast(`${old?.name || sel} is no longer available – switched to ${rep.name}`, 4500);
      }
    }
  } catch (e) {
    if (!silent) toast('Could not load models: ' + e.message);
  }
  if (!state.settings.model && state.models.length) {
    state.settings.model = (DEFAULT_MODELS.map((id) => state.models.find((m) => m.id === id)).find(Boolean) || state.models[0]).id;
    saveSettings(state.settings);
  }
  const newCount = state.models.filter(isNew).length;
  $('#model-btn').classList.toggle('has-new', fresh && newCount > 0);
  updateModelUI();
  renderModelList();
  if (!state.current?.messages.length) renderMessages();
}

let modelFilter = 'all';
const CC_TOO = new Set(['all', 'reasoning', 'vision']);

// ---------- favourite models (decision 176) ----------
// ids of normal models; a Claude Code model is "claude-code:<its value>" (the same id background jobs use)
const favs = () => new Set(state.settings.favModels || []);
const isFav = (key) => favs().has(key);
function toggleFav(key) {
  const f = favs();
  if (f.has(key)) f.delete(key);
  else f.add(key);
  state.settings.favModels = [...f];
  saveSettings(state.settings);
  renderModelList();
}
/** The ☆ on a model row: toggles the favourite without picking the model. */
function favStar(key, name) {
  const on = isFav(key);
  const star = el('span', 'fav-star' + (on ? ' on' : ''), on ? '★' : '☆');
  star.setAttribute('role', 'button');
  star.setAttribute('aria-label', (on ? 'Remove from favorites: ' : 'Add to favorites: ') + name);
  star.onclick = (e) => {
    e.stopPropagation();
    toggleFav(key);
  };
  return star;
}
hooks.isFav = isFav;
hooks.favStar = favStar;

const MODEL_FILTERS = {
  all: ['All', () => true],
  fav: ['★ Favorites', (m) => isFav(m.id)],
  // the user's own Claude Code in Linux (ccmodels-ui.js): its models are not in state.models
  claude: ['Claude', () => false],
  free: ['Free', isFree],
  new: ['New', isNew],
  vision: ['Vision', (m) => supportsImages(m)],
  reasoning: ['Reasoning', (m) => !!m.capabilities?.reasoning?.supported],
};

function renderModelFilters() {
  const bar = $('#model-filters');
  bar.innerHTML = '';
  for (const [key, [label, fn]] of Object.entries(MODEL_FILTERS)) {
    // Claude Code's models count under Claude, and under Reasoning and Vision (they all think and see pictures)
    const n = key === 'claude' ? hooks.ccModelCount?.() || 0 : key === 'fav' ? state.models.filter(fn).length + (hooks.ccFavCount?.() || 0) : state.models.filter(fn).length + (CC_TOO.has(key) ? hooks.ccModelCount?.() || 0 : 0);
    if (key !== 'all' && key !== 'fav' && !n) continue; // Favorites is always there: it says how to add one
    const b = el('button', 'filter-chip' + (modelFilter === key ? ' active' : '') + (key === 'fav' ? ' fav' : ''), key === 'all' || (key === 'fav' && !n) ? label : `${label} ${n}`);
    b.onclick = () => {
      modelFilter = key;
      renderModelList();
    };
    bar.append(b);
  }
}

function renderModelList() {
  const q = $('#model-search').value.trim().toLowerCase();
  const list = $('#model-list');
  list.innerHTML = '';
  if (!MODEL_FILTERS[modelFilter] || (modelFilter === 'claude' ? !hooks.ccModelCount?.() : modelFilter !== 'all' && modelFilter !== 'fav' && !state.models.some(MODEL_FILTERS[modelFilter][1]) && !(CC_TOO.has(modelFilter) && hooks.ccModelCount?.()))) modelFilter = 'all';
  renderModelFilters();
  // the Claude chip: the user's own Claude Code in Linux alone, under its heading (ccmodels-ui.js)
  if (modelFilter === 'claude') {
    hooks.renderCcModels?.(list, q, shownModel());
    if (!list.childElementCount) list.append(el('p', 'hint pad', 'No matches.'));
    return;
  }
  // elsewhere its models are in the same A–Z as the others (their "claude" badge tells them apart); under Favorites
  // only the starred ones
  const cc = CC_TOO.has(modelFilter) || modelFilter === 'fav' ? hooks.ccModelRows?.(q, shownModel(), { onlyFav: modelFilter === 'fav' }) || { notes: [], rows: [] } : { notes: [], rows: [] };
  if (modelFilter === 'fav' && !cc.rows.length && !state.models.some((m) => isFav(m.id))) {
    list.append(el('p', 'hint pad', 'No favorites yet – tap ☆ on a model to keep it here.'));
    return;
  }
  list.append(...cc.notes);
  // A–Z by name (the owner's choice), whatever the provider's own order
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  const models = state.models.filter((m) => MODEL_FILTERS[modelFilter][1](m) && (!q || m.name.toLowerCase().includes(q) || m.id.includes(q)));
  if (!models.length && !cc.rows.length) {
    list.append(el('p', 'hint pad', state.models.length ? 'No matches.' : 'Loading models…'));
    return;
  }
  if (modelFilter === 'free')
    list.append(el('p', 'hint', 'These models are listed at $0, so they shouldn’t use up your Go allowance. Some are free only for a limited time, “Contributor” models may use your chats for training, and ZEN ones come from OpenCode Zen’s free tier.'));
  const rows = [...models.map((m) => ({ name: m.name, m })), ...cc.rows].sort((a, b) => byName(a.name, b.name));
  for (const { m, node } of rows) {
    if (node) {
      list.append(node);
      continue;
    }
    const b = el('button', 'model-item' + (m.id === (shownModel()?.id || state.settings.model) ? ' active' : ''));
    const top = el('div', 'model-top');
    top.append(el('span', 'model-title', m.name));
    if (m.id === (shownModel()?.id || state.settings.model)) top.append(el('span', 'check', '✓'));
    top.append(favStar(m.id, m.name));
    b.append(top);
    const badges = el('div', 'badges');
    if (isNew(m)) badges.append(el('span', 'badge new', 'NEW'));
    if (isFree(m)) badges.append(el('span', 'badge free', 'FREE'));
    if (m.source === 'zen') badges.append(el('span', 'badge zen', 'ZEN'));
    if (m.source === 'custom') badges.append(el('span', 'badge custom', m.providerName || 'custom'));
    if (m.source === 'local') badges.append(el('span', 'badge zen', 'OFFLINE'));
    if (isContributor(m)) badges.append(el('span', 'badge warn', 'trains on data'));
    if (m.limit?.context) badges.append(el('span', 'badge', fmtTokens(m.limit.context) + ' ctx'));
    if (m.capabilities?.reasoning?.supported) badges.append(el('span', 'badge', 'reasoning'));
    if (supportsImages(m)) badges.append(el('span', 'badge', 'vision'));
    if (m.open_weights) badges.append(el('span', 'badge', 'open'));
    const c = m.cost?.text;
    if (c?.input?.price != null && !isFree(m))
      badges.append(el('span', 'badge dim', `$${c.input.price}/$${c.output?.price ?? '?'} /M`));
    b.append(badges);
    if (m.description) b.append(el('div', 'model-desc', m.description));
    if (isContributor(m)) b.append(el('div', 'model-desc warn', 'Needs “Allow paid endpoints that train on request data” in the OpenCode Console → Settings → Privacy.'));
    if (m.source === 'zen') b.append(el('div', 'model-desc', 'Free model from OpenCode Zen (not in the Go list). Often a limited-time or “stealth” preview; may log prompts for training.'));
    b.onclick = () => {
      // a roleplay whose preset picks the model: this chat keeps the one picked here (the preset is not changed)
      const here = hooks.presetHere?.();
      if (here?.decides && state.current) {
        if (m.id === here.presetModel) delete state.current.modelPin;
        else state.current.modelPin = m.id;
        if (state.current.messages.some((x) => !x.greeting)) persist();
        if (m.id !== here.presetModel) toast(`${m.name} for this chat – its preset “${here.preset?.name}” picks ${modelNameOf(here.presetModel)} elsewhere`);
        updateModelUI();
        openSheet('#model-sheet', false);
        return;
      }
      hooks.ccLeave?.(); // a chat that had picked Claude Code is a normal chat again
      state.settings.model = m.id;
      saveSettings(state.settings);
      updateModelUI();
      openSheet('#model-sheet', false);
      if (!state.current.messages.length) renderMessages();
    };
    list.append(b);
  }
}

function openModels() {
  $('#model-search').value = '';
  renderModelList();
  openSheet('#model-sheet', true);
  refreshModels(true);
  hooks.ccPickerOpened?.();
}
hooks.renderModelList = () => renderModelList();
$('#model-btn').onclick = openModels;
$('#model-search').addEventListener('input', renderModelList);

export { attaching, fileChip, hideSlash, openModels, refreshModels, renderAttachments, updateModelUI, updateSlash };

// ``` + language in the message box: code box with a preview
const fence = setupFence($('#input'), { onChange: () => (autoGrow(), hooks.updateSend?.())});
hooks.refreshFence = fence.refresh;
