// Decision 261: the assistant lists, reads, makes, changes and deletes roleplay presets – each change asked first.
import { describe, it, expect } from 'vitest';
import { planPresetChange, findPreset } from '../../src/rppresets.js';
import { runCreatorTool, creatorDefs } from '../../src/creatortools.js';

const STANDARD = { model: '', effort: '', samplers: { temperature: 0.8 }, rpMain: 'Main prompt.', rpPhi: 'Write 2 paragraphs. Never write {{user}}.', rpNote: '', rpNoteDepth: 4, rpNoteRole: 'system', rpPrefill: '', rpImpersonate: '', rpNames: true };
const settings = () => ({ rpPresets: [{ id: 'rpp_a', name: 'Vivid', rpPhi: 'Lush prose, 3 paragraphs.', samplers: { temperature: 1 } }, { id: 'rpp_b', name: 'Short', samplers: { max_tokens: 300 } }], rpPresetId: 'rpp_b' });
const host = (s, asked = []) => ({
  presets: {
    settings: () => s,
    standard: () => STANDARD,
    models: () => [{ id: 'glm-5.3' }],
    save: (list, def) => {
      s.rpPresets = list;
      s.rpPresetId = def;
    },
  },
  ask: async (summary, [yes]) => (asked.push(summary), yes),
});

describe('the roleplay_presets tool', () => {
  it('is offered with the creator tools', () => {
    expect(creatorDefs().some((d) => d.function.name === 'roleplay_presets')).toBe(true);
  });
  it('lists the presets with Standard and the default, and reads one with what it follows from Standard', async () => {
    const s = settings();
    const l = await runCreatorTool('roleplay_presets', { action: 'list' }, host(s));
    expect(l.result).toContain('standard · Standard');
    expect(l.result).toMatch(/rpp_b · Short · default/);
    const r = JSON.parse((await runCreatorTool('roleplay_presets', { action: 'read', preset: 'vivid' }, host(s))).result);
    expect(r).toMatchObject({ id: 'rpp_a', name: 'Vivid', rpPhi: 'Lush prose, 3 paragraphs.' });
    expect(r.follows_standard_for).toContain('rpMain');
    const st = JSON.parse((await runCreatorTool('roleplay_presets', { action: 'read', preset: 'Standard' }, host(s))).result);
    expect(st.rpMain).toBe('Main prompt.');
  });
  it('makes a preset from a starter or another one, asks first, and can make it the default', async () => {
    const s = settings();
    const asked = [];
    const r = await runCreatorTool('roleplay_presets', { action: 'create', name: 'Noir', from: 'Vivid', set: { rpNote: 'Rain, always rain.', samplers: { temperature: 0.7 } }, make_default: true }, host(s, asked));
    expect(r.ok).toBe(true);
    // what the user reads names the fields in words (decision 270); the model is told where it reaches a chat
    expect(asked[0]).toMatch(/Make a roleplay preset “Noir”, a copy of “Vivid” with author's note, samplers \(temperature, length…\) changed, and make it the default/);
    expect(r.result).toMatch(/picked in that chat's settings \(🎛 Roleplay preset\), or when it is the default for roleplays; the change applies from the next reply\.$/);
    const noir = s.rpPresets.find((p) => p.name === 'Noir');
    expect(noir).toMatchObject({ rpPhi: 'Lush prose, 3 paragraphs.', rpNote: 'Rain, always rain.', samplers: { temperature: 0.7 } });
    expect(s.rpPresetId).toBe(noir.id);
    await expect(runCreatorTool('roleplay_presets', { action: 'create', name: 'noir' }, host(s))).rejects.toThrow(/already a preset/);
  });
  it('changes a preset by exact text edits and whole fields; a wrong field or value says what is right', async () => {
    const s = settings();
    await runCreatorTool('roleplay_presets', { action: 'edit', preset: 'rpp_a', edits: [{ field: 'rpPhi', old_text: '3 paragraphs', new_text: '4 paragraphs' }], set: { name: 'Vivid+', rpNoteDepth: 2 } }, host(s));
    expect(s.rpPresets[0]).toMatchObject({ name: 'Vivid+', rpPhi: 'Lush prose, 4 paragraphs.', rpNoteDepth: 2 });
    // a field the preset does not set is edited from Standard's text
    await runCreatorTool('roleplay_presets', { action: 'edit', preset: 'Short', edits: [{ field: 'rpPhi', old_text: '2 paragraphs', new_text: '1 paragraph' }] }, host(s));
    expect(s.rpPresets[1].rpPhi).toBe('Write 1 paragraph. Never write {{user}}.');
    await expect(runCreatorTool('roleplay_presets', { action: 'edit', preset: 'Short', set: { colour: 'red' } }, host(s))).rejects.toThrow(/not a preset field/);
    await expect(runCreatorTool('roleplay_presets', { action: 'edit', preset: 'Short', set: { samplers: { temperature: 7 } } }, host(s))).rejects.toThrow(/from 0 to 2/);
    await expect(runCreatorTool('roleplay_presets', { action: 'edit', preset: 'Short', edits: [{ field: 'rpPhi', old_text: 'nowhere' , new_text: 'x' }] }, host(s))).rejects.toThrow(/not found/);
    // "" clears a field: it follows Standard again
    await runCreatorTool('roleplay_presets', { action: 'edit', preset: 'Short', set: { rpPhi: '' } }, host(s));
    expect('rpPhi' in s.rpPresets[1]).toBe(false);
  });
  it('deletes one (the default goes back to Standard); a "no" changes nothing', async () => {
    const s = settings();
    const no = { ...host(s), ask: async () => 'Not now' };
    const r = await runCreatorTool('roleplay_presets', { action: 'delete', preset: 'Short' }, no);
    expect(r.ok).toBe(false);
    expect(s.rpPresets).toHaveLength(2);
    await runCreatorTool('roleplay_presets', { action: 'delete', preset: 'Short' }, host(s));
    expect(s.rpPresets.map((p) => p.name)).toEqual(['Vivid']);
    expect(s.rpPresetId).toBe('');
  });
  it('Standard is not changed here, and an unclear name asks for the id', () => {
    expect(() => planPresetChange(settings(), 'edit', { preset: 'Standard', set: { rpPhi: 'x' } }, { standard: STANDARD })).toThrow(/Standard.*changed there/);
    const s = { rpPresets: [{ id: 'a', name: 'Dark one' }, { id: 'b', name: 'Dark two' }] };
    expect(findPreset(s.rpPresets, 'dark').ambiguous).toHaveLength(2);
  });
});
