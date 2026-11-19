// Phone-folder access modes (review / auto / read-only) and the review screen where you accept or reject what the
// assistant changed.
import { collapseDiff, diffStats, lineDiff } from '../diff.js';
import { readPhoneFile, removePhoneFile, writePhoneFile, canUsePhoneFolder } from '../phonefolder.js';
import { looksText, bytesToText } from '../sandbox.js';
import { saveSettings } from '../store.js';
import { openSheet, persist } from './chatlist.js';
import { $, convIsRp, el, hooks, pref, state, toast, toolsOn } from './core.js';
import { IMG_EXT } from './render.js';
import { chooseOne, confirmSheet } from './choose.js';
import { BYPASS_KEEPS, BYPASS_SKIPS } from '../permissions.js';

const MODES = { ask: '🛡 Review', auto: '⚡ Auto', readonly: '👁 Read-only' };
const fmtKB = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const modeOf = () => hooks.agentMode?.(state.current) || 'ask';

// ---------- the mode chip ----------
const PERMS = { auto: '⚡ Auto', ask: '🛡 Ask first', plan: '📋 Plan', bypass: '⚡ Bypass' };
const permOf = () => (state.current?.planMode ? 'plan' : state.current?.permMode === 'ask' ? 'ask' : state.current?.permMode === 'bypass' ? 'bypass' : 'auto');
const phoneLinked = () => !!state.current && canUsePhoneFolder() && pref('toolPhone') && !!state.current.phoneFolder;
// one chip for how the agent works in this chat: Auto / Ask first / Bypass / Plan (+ the phone-folder mode when one is linked)
function updateModeChip() {
  const btn = $('#mode-btn');
  const on = !!state.current && toolsOn();
  btn.hidden = !on;
  // ⚡ Bypass is amber and says so, so it is never on by accident (and in an agent chat shows even with tools off: it
  // is still set). A roleplay shows the chip only while its tools are on.
  const bypass = !!state.current && permOf() === 'bypass';
  btn.classList.toggle('bypass-chip', bypass);
  if (bypass && !convIsRp(state.current)) btn.hidden = false;
  if (on || bypass) btn.textContent = PERMS[permOf()] + (phoneLinked() && modeOf() !== 'auto' ? ' · ' + MODES[modeOf()] : '');
}
hooks.updateModeChip = updateModeChip;

/**
 * ⚡ Bypass permissions: asked once, on the app's own sheet, with what will no longer ask and what still does.
 * `where`: 'chat' (this chat) or 'new' (Settings: the default for new chats). → true when the user turned it on.
 */
export function confirmBypass(where = 'chat') {
  const list = (xs) => xs.map((x) => '• ' + x).join('\n');
  const scope = where === 'new' ? 'In every new chat you start, the' : 'In this chat the';
  return confirmSheet(
    where === 'new' ? '⚡ Bypass permissions in new chats?' : '⚡ Bypass permissions in this chat?',
    `${scope} assistant runs its tools without asking you first – also in tasks scheduled in that chat, when you are not there. It can delete or overwrite files without a question.\n\nNo longer asked:\n${list(BYPASS_SKIPS)}\n\nStill asked, or still refused:\n${list(BYPASS_KEEPS)}\n\nThe ⚡ Bypass chip stays on while it is on; tap it to turn it off.`,
    'Turn on Bypass',
    'Cancel',
  );
}
hooks.confirmBypass = confirmBypass;
function setPerm(c, want) {
  if ((want === 'plan') !== !!c.planMode) hooks.togglePlanMode?.(c);
  if (want === 'ask' || want === 'bypass') c.permMode = want;
  else delete c.permMode;
  persist();
  updateModeChip();
  if (want !== 'plan') toast(`${PERMS[want]} for this chat`);
}
const prev = hooks.toolsChanged;
hooks.toolsChanged = () => {
  prev?.();
  updateModeChip();
};
hooks.filesChanged = ((old) => () => {
  old?.();
  updateModeChip();
})(hooks.filesChanged);
function openModeSheet() {
  $('#mode-default').checked = false;
  document.querySelectorAll('#perm-options .menu-item').forEach((b) => b.classList.toggle('current', b.dataset.perm === permOf()));
  const linked = phoneLinked();
  $('#mode-phone-head').hidden = !linked;
  $('#mode-options').hidden = !linked;
  $('#mode-default').closest('label').hidden = !linked;
  $('#mode-bypass-note').hidden = !(linked && permOf() === 'bypass');
  document.querySelectorAll('#mode-options .menu-item').forEach((b) => b.classList.toggle('current', b.dataset.mode === modeOf()));
  openSheet('#mode-sheet', true);
}
$('#mode-btn').onclick = async () => {
  // in Bypass the chip first offers to turn it off
  if (permOf() !== 'bypass') return openModeSheet();
  const c = state.current;
  const pick = await chooseOne('⚡ Bypass permissions is on', [
    { label: 'Turn Bypass off', sub: 'Back to ⚡ Auto: your permissions, the shell check and the phone-folder review ask again', value: 'off' },
    { label: 'Other modes…', value: 'modes' },
  ], 'Tools in this chat run without asking you first.');
  if (pick === 'off' && state.current === c) setPerm(c, 'auto');
  else if (pick === 'modes') openModeSheet();
};
document.querySelectorAll('#mode-options .menu-item').forEach((b) => {
  b.onclick = () => {
    state.current.agentMode = b.dataset.mode;
    if ($('#mode-default').checked) {
      (state.settings.prefs ||= {}).agentMode = b.dataset.mode;
      saveSettings(state.settings);
    }
    persist();
    updateModeChip();
    openSheet('#mode-sheet', false);
    toast(`${MODES[b.dataset.mode]} for this chat`);
  };
});

document.querySelectorAll('#perm-options .menu-item').forEach((b) => {
  b.onclick = async () => {
    const c = state.current;
    const want = b.dataset.perm;
    openSheet('#mode-sheet', false);
    // turning Bypass on asks once, with what will no longer ask
    if (want === 'bypass' && c.permMode !== 'bypass' && !(await confirmBypass('chat'))) return;
    if (state.current !== c) return;
    setPerm(c, want);
  };
});
hooks.planChanged = ((old) => () => {
  old?.();
  updateModeChip();
})(hooks.planChanged);

// ---------- the review screen ----------
let current = null;
async function beforeOf(folder, path, kind) {
  if (kind === 'new') return null;
  try {
    return await readPhoneFile(folder, path, 5 * 1024 * 1024);
  } catch {
    return null;
  }
}
/** Resolves { applied: [{path, kind, before}], rejected: [paths], failed: [paths] } once you decide. */
hooks.reviewChanges = (folder, stage) =>
  new Promise(async (resolve) => {
    const items = [];
    for (const [path, st] of stage) items.push({ path, ...st, before: await beforeOf(folder, path, st.kind) });
    items.sort((a, b) => a.path.localeCompare(b.path));
    current?.resolve(null);
    current = { resolve, folder, items, picked: new Set(items.map((i) => i.path)) };
    $('#review-intro').textContent = `The assistant changed ${items.length} file${items.length === 1 ? '' : 's'} in “${folder.name}”. Nothing is saved to your phone until you apply.`;
    $('#review-auto').checked = false;
    const box = $('#review-list');
    box.innerHTML = '';
    for (const it of items) box.append(reviewItem(it));
    updateApplyLabel();
    openSheet('#review-sheet', true);
  });
function reviewItem(it) {
  const card = el('div', 'review-item');
  const head = el('div', 'review-head');
  const c = el('input');
  c.type = 'checkbox';
  c.checked = true;
  c.onchange = () => {
    c.checked ? current.picked.add(it.path) : current.picked.delete(it.path);
    updateApplyLabel();
  };
  const size = it.dir ? 'empty folder' : it.kind === 'delete' ? fmtKB(it.before?.byteLength || 0) : fmtKB(it.after.byteLength);
  head.append(c, el('span', 'review-badge ' + it.kind, it.kind === 'new' ? 'NEW' : it.kind === 'replace' ? 'REPLACE' : 'DELETE'), el('span', 'review-path', it.dir ? it.path + '/' : it.path), el('span', 'dim', size));
  card.append(head);
  const bytes = it.kind === 'delete' ? it.before : it.after;
  if (IMG_EXT.test(it.path) && bytes) {
    const img = el('img');
    img.src = URL.createObjectURL(new Blob([bytes]));
    card.append(img);
  } else if (bytes && looksText(bytes) && bytes.byteLength < 400000 && (!it.before || looksText(it.before))) {
    const after = it.kind === 'delete' ? '' : bytesToText(it.after);
    const before = it.before ? bytesToText(it.before) : '';
    const ops = it.kind === 'new' ? after.split('\n').map((s) => ({ t: '+', s })) : it.kind === 'delete' ? before.split('\n').map((s) => ({ t: '-', s })) : lineDiff(before, after);
    const st = diffStats(ops);
    const d = el('details', 'pc-adv');
    d.append(el('summary', null, `${it.kind === 'new' ? 'Show the file' : `Changes: +${st.added} −${st.removed} lines`}`));
    const pre = el('pre', 'diff');
    for (const o of collapseDiff(ops, 2).slice(0, 400)) pre.append(el('div', o.t === '+' ? 'd-add' : o.t === '-' ? 'd-del' : o.t === '…' ? 'd-skip' : '', o.t === '…' ? `… ${o.s} …` : `${o.t === ' ' ? '  ' : o.t + ' '}${o.s}`));
    d.append(pre);
    card.append(d);
  } else card.append(el('div', 'hint', 'Not a text file – no preview.'));
  return card;
}
function updateApplyLabel() {
  const n = current?.picked.size || 0;
  $('#review-apply').textContent = n ? `Apply ${n === current.items.length ? 'all ' : ''}${n} change${n === 1 ? '' : 's'}` : 'Apply nothing';
}
async function finish(apply) {
  const cur = current;
  if (!cur) return;
  current = null;
  openSheet('#review-sheet', false);
  if ($('#review-auto').checked && apply) {
    state.current.agentMode = 'auto';
    persist();
    updateModeChip();
  }
  const applied = [];
  const rejected = [];
  const failed = [];
  for (const it of cur.items) {
    if (!apply || !cur.picked.has(it.path)) {
      rejected.push(it.path);
      continue;
    }
    try {
      if (it.kind === 'delete') await removePhoneFile(cur.folder, it.path);
      else await writePhoneFile(cur.folder, it.path, it.after);
      applied.push({ path: it.path, kind: it.kind, before: it.before });
    } catch (e) {
      failed.push(it.path);
      toast(`Could not save ${it.path}: ${e.message}`, 5000);
    }
  }
  if (applied.length) toast(`Saved ${applied.length} change${applied.length === 1 ? '' : 's'} to “${cur.folder.name}”${rejected.length ? `, rejected ${rejected.length}` : ''}`);
  else if (rejected.length) toast('Rejected – nothing was changed');
  cur.resolve({ applied, rejected, failed });
}
$('#review-apply').onclick = () => finish(true);
$('#review-reject').onclick = () => finish(false);
// closing the sheet any other way = reject (nothing is ever applied by accident)
new MutationObserver(() => {
  if (current && !$('#review-sheet').classList.contains('open')) finish(false);
}).observe($('#review-sheet'), { attributes: true, attributeFilter: ['class'] });
