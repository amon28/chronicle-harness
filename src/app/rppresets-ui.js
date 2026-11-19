// 🎛 Roleplay presets: the preset bar on Settings › Roleplay prompts & preset, and the picker in a chat's sheet.
// The page's fields always show the preset being edited; Standard is the page's own values (settings.prefs).
import { saveSettings } from '../store.js';
import { PRESET_FIELDS, STARTERS, activePreset, exportPreset, importPreset, makePreset, presetById, presets } from '../rppresets.js';
import { persist } from './chatlist.js';
import { $, effortOptions, hooks, pref, state, toast } from './core.js';
import { fillSamplerBox, isRpConv } from './engine.js';
import { shareBytes } from './extras.js';
import { askText, chooseOne, confirmSheet } from './choose.js';
import { openSettings } from './settings.js';

const S = () => state.settings;
let editing = ''; // the preset on the page ('' = Standard)

/** The values of the preset being edited (Standard: the page's own settings). */
function valuesOf(id) {
  const p = presetById(S(), id);
  if (p) return p;
  const v = { model: '', effort: '', samplers: S().rpSamplers };
  for (const k of PRESET_FIELDS) v[k] = pref(k);
  return v;
}

function fillModelSelects(v) {
  const sel = $('#rp-preset-model');
  sel.innerHTML = '';
  sel.append(new Option(editing ? 'The chat’s model (as selected)' : 'The chat’s model (as selected) – Standard always uses it', ''));
  for (const m of state.models) sel.append(new Option(m.name, m.id));
  // a model that is not in the list now (another provider, offline): kept, and said
  if (v.model && !state.models.some((m) => m.id === v.model)) sel.append(new Option(`${v.model} (not available now)`, v.model));
  sel.value = v.model || '';
  sel.disabled = !editing;
  fillEffort(v);
}
function fillEffort(v = valuesOf(editing)) {
  const m = state.models.find((x) => x.id === $('#rp-preset-model').value);
  const opts = effortOptions(m);
  $('#rp-preset-effort-row').hidden = !editing || !opts.length;
  const sel = $('#rp-preset-effort');
  sel.innerHTML = '';
  sel.append(new Option('Model default', ''));
  for (const o of opts) sel.append(new Option(o, o));
  sel.value = opts.includes(v.effort) ? v.effort : '';
}

/** Fill the whole page from the preset being edited. Called when Settings opens and when the preset changes. */
export function fillPresetPage(id = editing) {
  editing = presetById(S(), id) ? id : '';
  const sel = $('#rp-preset-sel');
  sel.innerHTML = '';
  const def = S().rpPresetId || '';
  sel.append(new Option(`Standard${def === '' ? ' – default' : ''}`, ''));
  for (const p of presets(S())) sel.append(new Option(`${p.name}${p.id === def ? ' – default' : ''}`, p.id));
  sel.value = editing;
  const ns = $('#rp-preset-new');
  if (ns.options.length < 2) {
    ns.append(new Option('A copy of this one', '__copy'));
    ns.append(new Option('Empty (Standard’s prompts)', '__std'));
    for (const st of STARTERS) ns.append(new Option(`Starter: ${st.name}`, 'starter:' + st.name));
  }
  ns.value = '';
  $('#rp-preset-default').checked = def === editing;
  for (const b of ['#rp-preset-dup', '#rp-preset-rename', '#rp-preset-del']) $(b).disabled = !editing && b !== '#rp-preset-dup';
  $('#rp-preset-standard-hint').hidden = !!editing;
  const v = valuesOf(editing);
  $('#pref-rp-main').value = v.rpMain || '';
  $('#pref-phi').value = v.rpPhi || '';
  $('#pref-rp-note').value = v.rpNote || '';
  $('#pref-rp-note-depth').value = v.rpNoteDepth ?? 4;
  $('#pref-rp-note-role').value = v.rpNoteRole || 'system';
  $('#pref-rp-prefill').value = v.rpPrefill || '';
  $('#pref-rp-imp').value = v.rpImpersonate || '';
  $('#pref-rp-names').checked = !!v.rpNames;
  fillSamplerBox('rps', v.samplers || {});
  fillModelSelects(v);
}

/**
 * After Settings read its form (the RP fields went into settings.prefs and the samplers into rpSamplers):
 * when a preset is being edited, they belong to it – Standard keeps what it had.
 */
export function capturePreset(prefsBefore, samplersBefore) {
  const p = presetById(S(), editing);
  if (!p) return;
  for (const k of PRESET_FIELDS) {
    p[k] = S().prefs[k];
    if (prefsBefore[k] === undefined) delete S().prefs[k];
    else S().prefs[k] = prefsBefore[k];
  }
  p.samplers = S().rpSamplers;
  S().rpSamplers = samplersBefore;
  const model = $('#rp-preset-model').value || '';
  // a model that is not in the list right now offers no efforts on the page: its own is kept, not read as "default"
  const away = model && model === p.model && !state.models.some((m) => m.id === model);
  p.effort = away ? p.effort || '' : $('#rp-preset-effort').value || '';
  p.model = model;
}

function addPreset(p) {
  hooks.flushSettings?.();
  S().rpPresets = [...presets(S()), p];
  saveSettings(S());
  fillPresetPage(p.id);
  hooks.updateModelUI?.();
}
// in the app's own text sheet (not the system's prompt box); cut to 60 characters before trimming, so a cut never
// ends in a space
const askName = async (q, def) => {
  const n = await askText(q, def, { ok: 'Save', max: 60 });
  return n == null ? null : n.slice(0, 60).trim() || def;
};

$('#rp-preset-sel').onchange = (e) => {
  const next = e.target.value;
  e.target.value = editing;
  hooks.flushSettings?.(); // what was typed for the preset on the page goes into it, not into the next one
  fillPresetPage(next);
};
$('#rp-preset-model').onchange = () => fillEffort();
$('#rp-preset-default').onchange = (e) => {
  hooks.flushSettings?.();
  S().rpPresetId = e.target.checked ? editing : '';
  saveSettings(S());
  fillPresetPage(editing);
  hooks.updateModelUI?.();
};
$('#rp-preset-new').onchange = async (e) => {
  const how = e.target.value;
  e.target.value = '';
  if (!how) return;
  const std = valuesOf('');
  let base = std;
  let name = 'New preset';
  if (how === '__copy') {
    base = valuesOf(editing);
    name = `${base.name || 'Standard'} copy`;
  } else if (how.startsWith('starter:')) {
    const st = STARTERS.find((x) => 'starter:' + x.name === how);
    if (!st) return;
    base = { ...std, ...st, samplers: { ...(std.samplers || {}), ...st.samplers } };
    name = st.name;
  }
  const n = await askName('Name of the new preset', name);
  if (n == null) return;
  addPreset(makePreset(n, base));
  toast(`Preset “${n}” – set its model and prompts below`);
};
$('#rp-preset-dup').onclick = async () => {
  const base = valuesOf(editing);
  const n = await askName('Name of the copy', `${presetById(S(), editing)?.name || 'Standard'} copy`);
  if (n != null) addPreset(makePreset(n, base));
};
$('#rp-preset-rename').onclick = async () => {
  const p = presetById(S(), editing);
  if (!p) return;
  const n = await askName('New name', p.name);
  if (n == null) return;
  p.name = n;
  saveSettings(S());
  fillPresetPage(editing);
  hooks.updateModelUI?.();
};
$('#rp-preset-del').onclick = async () => {
  const p = presetById(S(), editing);
  if (!p || !(await confirmSheet(`Delete the preset “${p.name}”?`, 'Chats that use it go back to the default.'))) return;
  if (!presetById(S(), p.id)) return;
  S().rpPresets = presets(S()).filter((x) => x.id !== p.id);
  if (S().rpPresetId === p.id) S().rpPresetId = '';
  saveSettings(S());
  fillPresetPage('');
  hooks.updateModelUI?.();
};
$('#rp-preset-export').onclick = async () => {
  const p = presetById(S(), editing) || { ...valuesOf(''), name: 'Standard' };
  try {
    await shareBytes(`${(p.name || 'preset').replace(/[^\w-]+/g, '_').slice(0, 40)}.rp-preset.json`, new TextEncoder().encode(exportPreset(p)));
  } catch (e) {
    toast(String(e?.message || e));
  }
};
$('#rp-preset-import').onclick = () => $('#rp-preset-file').click();
$('#rp-preset-file').onchange = async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const p = importPreset(await f.text(), f.name.replace(/\.(rp-preset\.)?json$/i, ''));
    addPreset(p);
    toast(`Imported “${p.name}”${p.model ? '' : ' – pick its model below'}`);
  } catch (err) {
    toast(String(err?.message || err));
  }
};

// ---------- a chat's own preset (chat sheet) ----------

/** Fill the chat sheet's preset picker (roleplays only). */
export function fillChatPreset(conv = state.current) {
  const row = $('#chat-preset-row');
  const rp = conv && isRpConv(conv);
  row.hidden = !rp;
  if (!rp) return;
  const sel = $('#chat-preset');
  sel.innerHTML = '';
  const def = presetById(S(), S().rpPresetId || '');
  sel.append(new Option(`Default (${def?.name || 'Standard'})`, '__default'));
  sel.append(new Option('Standard', ''));
  for (const p of presets(S())) sel.append(new Option(p.name + (p.model ? ` – ${state.models.find((m) => m.id === p.model)?.name || p.model}` : ''), p.id));
  sel.value = conv.rpPreset === undefined || (conv.rpPreset && !presetById(S(), conv.rpPreset)) ? '__default' : conv.rpPreset;
}
/** This chat uses preset `value` ('__default' = the default one, '' = Standard, else a preset id). */
function setChatPreset(value, conv = state.current) {
  if (!conv) return;
  if (value === '__default') delete conv.rpPreset;
  else conv.rpPreset = value;
  delete conv.modelPin; // a new preset: its model, not one picked by hand for the old one
  if (conv.messages.some((m) => !m.greeting)) persist();
  hooks.updateModelUI?.();
  const p = activePreset(S(), conv);
  toast(`This chat uses ${p ? `“${p.name}”` : 'Standard'}${p?.model ? ` with ${state.models.find((m) => m.id === p.model)?.name || p.model}` : ''}`);
}
$('#chat-preset').onchange = (e) => setChatPreset(e.target.value);
hooks.fillChatPreset = fillChatPreset;

// ---------- one tap from a roleplay chat: the preset chip by the message box ----------
const modelName = (id) => state.models.find((m) => m.id === id)?.name || id;
/** Show the chip in roleplays only, with the preset this chat uses. */
export function updatePresetChip(conv = state.current) {
  const b = $('#preset-btn');
  const rp = !!conv && isRpConv(conv);
  b.hidden = !rp;
  if (!rp) return;
  const p = activePreset(S(), conv);
  b.textContent = `🎛 ${p ? p.name : 'Standard'}`;
  b.setAttribute('aria-label', `Roleplay preset: ${p ? p.name : 'Standard'} – change`);
}
hooks.updatePresetChip = updatePresetChip;
$('#preset-btn').onclick = async () => {
  const conv = state.current;
  if (!conv) return;
  const def = presetById(S(), S().rpPresetId || '');
  const cur = conv.rpPreset === undefined || (conv.rpPreset && !presetById(S(), conv.rpPreset)) ? '__default' : conv.rpPreset;
  const options = [
    { label: `Default (${def?.name || 'Standard'})`, sub: 'Follows Settings › Roleplay presets', value: '__default', current: cur === '__default' },
    { label: 'Standard', sub: 'The model you pick in the chat', value: '', current: cur === '' },
    ...presets(S()).map((p) => ({ label: p.name, sub: p.model ? modelName(p.model) : '', value: p.id, current: cur === p.id })),
    { label: 'Edit presets…', value: '__edit' },
  ];
  const v = await chooseOne('🎛 Roleplay preset', options, 'For this chat: its model, prompts and samplers.');
  if (v == null) return;
  if (v === '__edit') return openSettings('rppreset');
  if (v !== cur) setChatPreset(v, conv);
};
