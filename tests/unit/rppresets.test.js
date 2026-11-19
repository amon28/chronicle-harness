import { describe, it, expect } from 'vitest';
import { PRESET_FIELDS, STARTERS, activePreset, exportPreset, importPreset, makePreset, presetModel, presetPref, presetSamplers } from '../../src/rppresets.js';

const prefs = { rpPhi: 'standard phi', rpNames: false };
const pref = (k) => prefs[k];
const vivid = { id: 'v', name: 'Vivid', model: 'kimi-k3', effort: 'high', rpPhi: 'vivid phi', rpNames: true, samplers: { temperature: 1 } };
const short = { id: 's', name: 'Short', model: '', rpPhi: 'short phi', samplers: { max_tokens: 300 } };
const settings = (o = {}) => ({ rpSamplers: { temperature: 0.7 }, rpPresets: [vivid, short], ...o });
const models = [{ id: 'kimi-k3' }, { id: 'glm-5.3' }];

describe('roleplay presets', () => {
  it('a chat follows the default preset unless it picked one ("" = Standard)', () => {
    expect(activePreset(settings(), {})).toBe(null);
    expect(activePreset(settings({ rpPresetId: 'v' }), {})).toBe(vivid);
    expect(activePreset(settings({ rpPresetId: 'v' }), { rpPreset: 's' })).toBe(short);
    expect(activePreset(settings({ rpPresetId: 'v' }), { rpPreset: '' })).toBe(null);
    // a deleted preset: Standard, not an error
    expect(activePreset(settings({ rpPresetId: 'gone' }), {})).toBe(null);
    expect(activePreset(settings(), { rpPreset: 'gone' })).toBe(null);
  });

  it('prompts, samplers, model and effort come from the preset, else Standard', () => {
    const s = settings({ rpPresetId: 'v' });
    expect(presetPref(s, {}, 'rpPhi', pref)).toBe('vivid phi');
    expect(presetPref(s, {}, 'rpNames', pref)).toBe(true);
    expect(presetPref(s, {}, 'rpNote', (k) => (k === 'rpNote' ? 'from standard' : ''))).toBe('from standard'); // not in the preset
    expect(presetPref(s, { rpPreset: '' }, 'rpPhi', pref)).toBe('standard phi');
    expect(presetSamplers(s, {})).toEqual({ temperature: 1 });
    expect(presetSamplers(s, { rpPreset: '' })).toEqual({ temperature: 0.7 });
    expect(presetModel(s, {}, models)).toBe('kimi-k3');
    expect(presetModel(s, { rpPreset: 's' }, models)).toBe(''); // no model: the chat's own
    expect(presetModel(s, {}, [{ id: 'glm-5.3' }])).toBe(''); // a model that is not in the list is not used
  });

  it('a new preset is a copy, not a reference', () => {
    const p = makePreset('Copy', vivid);
    expect(p.id).not.toBe('v');
    expect(p).toMatchObject({ name: 'Copy', model: 'kimi-k3', effort: 'high', rpPhi: 'vivid phi' });
    p.samplers.temperature = 0.1;
    expect(vivid.samplers.temperature).toBe(1);
    expect(STARTERS.length).toBeGreaterThanOrEqual(3);
    for (const st of STARTERS) expect(st.rpPhi).toMatch(/\{\{user\}\}/);
  });

  it('exports and imports its own files', () => {
    const back = importPreset(exportPreset(vivid));
    expect(back.id).not.toBe('v');
    expect(back).toMatchObject({ name: 'Vivid', model: 'kimi-k3', effort: 'high', rpPhi: 'vivid phi', samplers: { temperature: 1 } });
    for (const k of PRESET_FIELDS) expect(back[k]).toBe(vivid[k]);
  });

  it('imports a SillyTavern chat-completion preset and a text-completion one', () => {
    const st = importPreset(
      JSON.stringify({ temperature: 1.1, top_p: 0.9, top_k: 40, min_p: 0.05, frequency_penalty: 0.2, openai_max_tokens: 800, assistant_prefill: '*', prompts: [{ identifier: 'main', content: 'ST main' }, { identifier: 'jailbreak', content: 'ST phi' }, { identifier: 'nsfw', content: '' }] }),
      'MyST',
    );
    expect(st).toMatchObject({ name: 'MyST', rpMain: 'ST main', rpPhi: 'ST phi', rpPrefill: '*', samplers: { temperature: 1.1, top_p: 0.9, top_k: 40, min_p: 0.05, frequency_penalty: 0.2, max_tokens: 800 } });
    const tc = importPreset(JSON.stringify({ temp: 0.8, rep_pen: 1.1, genamt: 300, stopping_strings: ['\nUser:'] }), 'TC');
    expect(tc.samplers).toEqual({ temperature: 0.8, repetition_penalty: 1.1, max_tokens: 300, stop: ['\nUser:'] });
    expect(() => importPreset('not json')).toThrow(/not JSON/);
    expect(() => importPreset('{"hello":1}')).toThrow(/No prompts or sampler/);
  });
});
