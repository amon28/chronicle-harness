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

// ---------- the roleplay_presets tool (decision 261): the assistant lists, reads, makes, changes and deletes presets ----------
// Pure: it works on a copy of the list and gives back what to store; the app asks you first and then saves it.

/** The fields a preset has, with what each one is, for the tool's description and its answers. */
export const PRESET_FIELD_HELP = {
  name: 'its name',
  model: 'the model id it picks for the chat ("" = the chat’s own model)',
  effort: 'reasoning effort for that model ("" = the model’s default)',
  samplers: 'temperature, max_tokens, top_p, min_p, top_k, frequency_penalty, presence_penalty, repetition_penalty (numbers; leave one out for the model default)',
  rpMain: 'the main roleplay prompt',
  rpPhi: 'the post-history instructions (sent after the chat, just before the reply)',
  rpNote: 'the author’s note',
  rpNoteDepth: 'how many messages from the end the author’s note goes in (a number)',
  rpNoteRole: 'the author’s note’s role: system, user or assistant',
  rpPrefill: 'text the reply starts with (prefill)',
  rpImpersonate: 'the prompt for writing your own next message (impersonate)',
  rpNames: 'names in front of messages: true or false',
};
const SAMPLER_RANGE = { temperature: [0, 2], max_tokens: [1, 200000], top_p: [0, 1], min_p: [0, 1], top_k: [0, 1000], frequency_penalty: [-2, 2], presence_penalty: [-2, 2], repetition_penalty: [0, 3] };
const TEXT_FIELDS = ['rpMain', 'rpPhi', 'rpNote', 'rpPrefill', 'rpImpersonate'];

/** A preset by name or id (exact id, then exact name, then a single name that starts with it) – or a list of candidates. */
export function findPreset(list, q) {
  const s = String(q || '').trim();
  if (!s) return null;
  const low = s.toLowerCase();
  const hit = list.find((p) => p.id === s) || list.find((p) => p.name.toLowerCase() === low);
  if (hit) return hit;
  const some = list.filter((p) => p.name.toLowerCase().includes(low));
  return some.length === 1 ? some[0] : some.length ? { ambiguous: some.map((p) => `${p.name} (${p.id})`) } : null;
}

/** A field's value checked and tidied; throws with what is wrong. */
function cleanField(k, v) {
  if (!(k in PRESET_FIELD_HELP)) throw new Error(`“${k}” is not a preset field. Fields: ${Object.keys(PRESET_FIELD_HELP).join(', ')}`);
  if (k === 'name') {
    const n = String(v ?? '').trim().slice(0, 60);
    if (!n) throw new Error('A preset needs a name');
    return n;
  }
  if (k === 'samplers') {
    if (v == null) return undefined;
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error('samplers is an object of numbers, e.g. {"temperature": 0.9, "max_tokens": 600}');
    const out = {};
    for (const [sk, sv] of Object.entries(v)) {
      if (!SAMPLER_RANGE[sk]) throw new Error(`“${sk}” is not a sampler. Samplers: ${Object.keys(SAMPLER_RANGE).join(', ')}`);
      if (sv === null || sv === '') continue; // left to the model
      const n = Number(sv);
      const [lo, hi] = SAMPLER_RANGE[sk];
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${sk} must be a number from ${lo} to ${hi}`);
      out[sk] = sk === 'max_tokens' || sk === 'top_k' ? Math.round(n) : n;
    }
    return out;
  }
  if (k === 'rpNoteDepth') {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('rpNoteDepth is a number from 0 to 100');
    return n;
  }
  if (k === 'rpNoteRole') {
    if (!['system', 'user', 'assistant'].includes(v)) throw new Error('rpNoteRole is system, user or assistant');
    return v;
  }
  if (k === 'rpNames') return v === true || v === 'true';
  return String(v ?? '').slice(0, 20000);
}

/** What a preset holds, for reading: only the fields it sets (the rest follow Standard). */
export function presetView(p, standard = null) {
  const out = { id: p.id || 'standard', name: p.name || 'Standard' };
  for (const k of Object.keys(PRESET_FIELD_HELP)) if (k !== 'name' && p[k] !== undefined && p[k] !== '') out[k] = p[k];
  if (standard) out.follows_standard_for = Object.keys(PRESET_FIELD_HELP).filter((k) => k !== 'name' && k !== 'model' && k !== 'effort' && (p[k] === undefined || p[k] === ''));
  return out;
}

/**
 * Plan a change to the presets. → { summary (what the user is asked), list (the presets after it), defaultId, result }
 * action: create | edit | delete. args: { preset, name, from, set, edits, make_default }.
 * s: the settings ({ rpPresets, rpPresetId }); standard: Standard's values; starters: [{ name, … }].
 */
export function planPresetChange(s, action, args = {}, { standard = {}, starters = STARTERS } = {}) {
  const list = presets(s).map((p) => ({ ...p }));
  let defaultId = s?.rpPresetId || '';
  const applySet = (p, set) => {
    if (set == null) return [];
    if (typeof set !== 'object' || Array.isArray(set)) throw new Error('set is an object of fields, e.g. {"rpPhi": "…", "samplers": {"temperature": 0.9}}');
    const changed = [];
    for (const [k, v] of Object.entries(set)) {
      const c = cleanField(k, v);
      if (c === undefined || c === '') delete p[k];
      else p[k] = c;
      changed.push(k);
    }
    return changed;
  };
  const applyEdits = (p, edits) => {
    if (edits == null) return [];
    if (!Array.isArray(edits)) throw new Error('edits is a list: [{field, old_text, new_text}]');
    const changed = [];
    for (const e of edits) {
      const f = e.field || 'rpPhi';
      if (!TEXT_FIELDS.includes(f)) throw new Error(`Text edits work on ${TEXT_FIELDS.join(', ')} – use set for ${f}`);
      const cur = String(p[f] ?? (standard[f] || ''));
      const old = String(e.old_text ?? '');
      if (!old) throw new Error('old_text is empty – use set to replace the whole field');
      const n = cur.split(old).length - 1;
      if (!n) throw new Error(`old_text was not found in ${f} – read the preset first and copy the text exactly`);
      if (n > 1 && !e.replace_all) throw new Error(`old_text is in ${f} ${n} times – give more of the text around it, or replace_all`);
      p[f] = e.replace_all ? cur.split(old).join(String(e.new_text ?? '')) : cur.replace(old, () => String(e.new_text ?? ''));
      changed.push(f);
    }
    return changed;
  };
  const lookup = (q) => {
    const p = findPreset(list, q);
    if (!p) throw new Error(`No preset “${q}” – list them first. (Standard, the Roleplay page's own settings, is changed there, not here.)`);
    if (p.ambiguous) throw new Error(`More than one preset matches “${q}”: ${p.ambiguous.join(', ')} – give its id`);
    return p;
  };
  if (action === 'create') {
    const name = cleanField('name', args.name);
    if (list.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a preset called “${name}” – edit it, or pick another name`);
    let from = standard;
    let fromName = 'Standard';
    if (args.from && !/^standard$/i.test(String(args.from).trim())) {
      const starter = starters.find((x) => x.name.toLowerCase() === String(args.from).trim().toLowerCase());
      if (starter) {
        from = { ...standard, ...starter };
        fromName = `the “${starter.name}” starter`;
      } else {
        from = lookup(args.from);
        fromName = `“${from.name}”`;
      }
    }
    const p = makePreset(name, from);
    const changed = [...applySet(p, args.set), ...applyEdits(p, args.edits)];
    list.push(p);
    if (args.make_default) defaultId = p.id;
    return {
      list,
      defaultId,
      summary: `Make a roleplay preset “${p.name}”, a copy of ${fromName}${changed.length ? ` with ${[...new Set(changed)].join(', ')} changed` : ''}${args.make_default ? ', and make it the default for roleplays' : ''}?`,
      result: `Made the preset “${p.name}” (${p.id})${args.make_default ? ' – the default for roleplays now' : ''}.`,
    };
  }
  if (action === 'edit') {
    const found = lookup(args.preset);
    const p = list[list.indexOf(found)];
    const changed = [...applySet(p, args.set), ...applyEdits(p, args.edits)];
    if (args.make_default === true) defaultId = p.id;
    if (args.make_default === false && defaultId === p.id) defaultId = '';
    if (!changed.length && args.make_default === undefined) throw new Error('Nothing to change: give set, edits or make_default');
    const what = [...new Set(changed)];
    const def = args.make_default === true ? 'make it the default for roleplays' : args.make_default === false && s?.rpPresetId === p.id ? 'stop it being the default (roleplays use Standard)' : '';
    return {
      list,
      defaultId,
      summary: `Change the roleplay preset “${found.name}”: ${[what.length ? what.join(', ') : '', def].filter(Boolean).join('; ')}?${what.some((k) => TEXT_FIELDS.includes(k)) ? `\n\n${what.filter((k) => TEXT_FIELDS.includes(k)).map((k) => `${k}: ${String(p[k] || '').slice(0, 300)}${String(p[k] || '').length > 300 ? '…' : ''}`).join('\n\n')}` : ''}`,
      result: `Changed the preset “${p.name}”${what.length ? ` (${what.join(', ')})` : ''}${def ? ` and ${def.replace(/^make it/, 'made it').replace(/^stop it/, 'stopped it')}` : ''}.`,
    };
  }
  if (action === 'delete') {
    const p = lookup(args.preset);
    const left = list.filter((x) => x !== p);
    const wasDefault = defaultId === p.id;
    return {
      list: left,
      defaultId: wasDefault ? '' : defaultId,
      summary: `Delete the roleplay preset “${p.name}”? Chats that use it go back to the default${wasDefault ? ' (Standard, since this one is the default)' : ''}.`,
      result: `Deleted the preset “${p.name}”.`,
    };
  }
  throw new Error('action is list, read, create, edit or delete');
}
