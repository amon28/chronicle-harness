// Roleplay presets: named sets of the roleplay settings – the model (and its reasoning effort), the prompts and
// the samplers – like SillyTavern / Chub presets. "Standard" is the Roleplay page's own values (the settings every
// roleplay used before presets existed). One preset is the default for every roleplay; a chat can pick another.
//
// settings.rpPresets  = [{ id, name, model, effort, samplers, rpMain, rpPhi, rpNote, rpNoteDepth, rpNoteRole, rpPrefill, rpImpersonate, rpNames }]
// settings.rpPresetId = the default preset's id ('' or missing = Standard)
// conv.rpPreset       = undefined: follow the default; '': Standard; an id: that preset
// conv.modelPin       = a model picked by hand in a chat whose preset names a model (beats the preset's model)

/** The roleplay settings a preset carries besides the model, effort and samplers (the keys of settings.prefs). */
export const PRESET_FIELDS = ['rpMain', 'rpPhi', 'rpNote', 'rpNoteDepth', 'rpNoteRole', 'rpPrefill', 'rpImpersonate', 'rpNames'];

export const presets = (s) => (Array.isArray(s?.rpPresets) ? s.rpPresets : []);
export const presetById = (s, id) => (id ? presets(s).find((p) => p.id === id) || null : null);
/** The preset a roleplay chat uses (its own choice, else the default), or null for Standard. */
export const activePreset = (s, conv) => presetById(s, conv?.rpPreset !== undefined ? conv.rpPreset : s?.rpPresetId || '');
/** A roleplay setting for this chat: from its preset, else from Standard (fallback(key) – the app's pref()). */
export function presetPref(s, conv, key, fallback) {
  const p = activePreset(s, conv);
  return p && p[key] !== undefined ? p[key] : fallback(key);
}
/** The default samplers of this chat's roleplays (a character's and the chat's own still win over them). */
export const presetSamplers = (s, conv) => {
  const p = activePreset(s, conv);
  return (p ? p.samplers : s?.rpSamplers) || {};
};
/** The model this chat's preset names, if that model is in the list ('' otherwise). */
export function presetModel(s, conv, models = []) {
  const id = activePreset(s, conv)?.model || '';
  return id && models.some((m) => m.id === id) ? id : '';
}
export const presetEffort = (s, conv) => activePreset(s, conv)?.effort || '';
/** One line for a chat: which preset, and the model it picks. */
export const presetLabel = (s, conv) => activePreset(s, conv)?.name || 'Standard';

const uidp = () => 'rpp_' + Math.random().toString(36).slice(2, 10);
/** A new preset: a copy of `from` (another preset, or Standard's values) with a name. */
export function makePreset(name, from = {}) {
  const p = { id: uidp(), name: String(name || 'Preset').trim().slice(0, 60) || 'Preset', model: from.model || '', effort: from.effort || '', samplers: from.samplers ? JSON.parse(JSON.stringify(from.samplers)) : undefined };
  for (const k of PRESET_FIELDS) if (from[k] !== undefined) p[k] = from[k];
  return p;
}

/** Ready-made starting points (the model stays the chat's own until you pick one). Each overrides Standard. */
export const STARTERS = [
  {
    name: 'Vivid prose',
    samplers: { temperature: 1.0, min_p: 0.05, frequency_penalty: 0.3, max_tokens: 1200 },
    rpPhi: 'Write rich, sensory prose: what {{char}} sees, hears, smells and feels. Show emotion through action and body language rather than stating it. 3–5 paragraphs. Never write {{user}}’s actions, words or thoughts.',
  },
  {
    name: 'Short & snappy',
    samplers: { temperature: 0.8, max_tokens: 350 },
    rpPhi: 'Reply in 1–2 short paragraphs: one action and a line or two of dialogue, then leave room for {{user}} to respond. Never write {{user}}’s actions, words or thoughts.',
  },
  {
    name: 'Slow burn',
    samplers: { temperature: 0.9, presence_penalty: 0.2 },
    rpPhi: 'Let the story breathe. Do not rush the plot, the relationship or any confession: build tension slowly through small details, hesitation and subtext. {{char}} has their own goals and does not simply agree with {{user}}. 2–4 paragraphs. Never write {{user}}’s actions, words or thoughts.',
  },
  {
    name: 'Story narrator',
    samplers: { temperature: 0.95, max_tokens: 1500 },
    rpPhi: 'Act as the narrator of an interactive story: describe the scene, voice every character except {{user}}, and move the plot with events, complications and choices. End at a moment where {{user}} must decide. Never decide for {{user}}.',
  },
];

// ---------- sharing ----------

/** A preset as a file (JSON). */
export function exportPreset(p) {
  const { id: _id, ...rest } = p;
  return JSON.stringify({ chronicleRpPreset: 1, ...rest }, null, 2);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const SAMPLER_FROM_ST = { temperature: 'temperature', temp: 'temperature', top_p: 'top_p', top_k: 'top_k', min_p: 'min_p', frequency_penalty: 'frequency_penalty', freq_pen: 'frequency_penalty', presence_penalty: 'presence_penalty', presence_pen: 'presence_penalty', repetition_penalty: 'repetition_penalty', rep_pen: 'repetition_penalty', openai_max_tokens: 'max_tokens', genamt: 'max_tokens', max_tokens: 'max_tokens' };

/**
 * A preset from a file: one exported here, or a SillyTavern preset (chat completion: prompts + samplers;
 * text completion: samplers). → a preset without an id (makePreset gives it one), or throws.
 */
export function importPreset(text, fallbackName = 'Imported preset') {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('That file is not a preset (not JSON)');
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('That file is not a preset');
  if (j.chronicleRpPreset) {
    const p = makePreset(j.name || fallbackName, j);
    return p;
  }
  // SillyTavern
  const out = { name: String(j.name || j.preset_name || fallbackName) };
  const samplers = {};
  for (const [from, to] of Object.entries(SAMPLER_FROM_ST)) if (num(j[from]) !== undefined && samplers[to] === undefined) samplers[to] = j[from];
  const stop = Array.isArray(j.stop_sequence) ? j.stop_sequence : Array.isArray(j.stopping_strings) ? j.stopping_strings : null;
  if (stop?.length) samplers.stop = stop.filter((x) => typeof x === 'string' && x).slice(0, 16);
  if (Object.keys(samplers).length) out.samplers = samplers;
  if (Array.isArray(j.prompts)) {
    const by = Object.fromEntries(j.prompts.filter((x) => x && typeof x.content === 'string').map((x) => [x.identifier, x.content]));
    if (by.main?.trim()) out.rpMain = by.main;
    if (by.jailbreak?.trim()) out.rpPhi = by.jailbreak;
  }
  if (typeof j.assistant_prefill === 'string' && j.assistant_prefill.trim()) out.rpPrefill = j.assistant_prefill;
  if (typeof j.impersonation_prompt === 'string' && j.impersonation_prompt.trim()) out.rpImpersonate = j.impersonation_prompt;
  if (!out.samplers && !out.rpMain && !out.rpPhi) throw new Error('No prompts or sampler settings found in that file');
  return makePreset(out.name, out);
}
