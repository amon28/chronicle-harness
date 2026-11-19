import { describe, it, expect } from 'vitest';
import { runManageTool, manageDefs, nearDuplicate } from '../../src/managetools.js';

const mk = () => {
  const calls = [];
  const settings = {
    memories: [{ id: 'm1', text: 'Has a cat called Mochi', scope: 'global' }, { id: 'm2', text: 'Likes short answers', scope: 'p1' }],
    skills: [{ name: 'csv_sum', description: 'Sums a CSV column', code: 'def run(): pass', parameters: { type: 'object' } }],
    mods: [{ id: 'hello', name: 'Hello', enabled: true }],
    lorebooks: [{ id: 'lb1', name: 'World', entries: [{ name: 'Sea', keys: ['sea'], content: 'Salty.' }] }],
    personas: [{ id: 'p1', name: 'Lia', lorebookId: 'lb1' }],
  };
  return { calls, ctx: { settings, save: () => calls.push('save'), personaId: 'p1', personaName: (id) => (id === 'p1' ? 'Lia' : ''), ask: async () => 'Remove it', mods: { remove: async (id) => calls.push(['remove', id]), enable: async () => {}, disable: async (id) => calls.push(['disable', id]) } } };
};

describe('managing what the user saved', () => {
  it('memory: list, add (no duplicates), edit, forget', async () => {
    const { ctx, calls } = mk();
    expect((await runManageTool('memory', { action: 'list' }, ctx)).result).toContain('m2 [Lia] Likes short answers');
    await runManageTool('memory', { action: 'add', text: 'Lives in Manila', scope: 'this_persona' }, ctx);
    expect(ctx.settings.memories.at(-1)).toMatchObject({ text: 'Lives in Manila', scope: 'p1', source: 'assistant' });
    expect((await runManageTool('memory', { action: 'add', text: 'has a cat called mochi' }, ctx)).result).toMatch(/already/);
    await runManageTool('memory', { action: 'edit', id: 'm1', text: 'Has two cats' }, ctx);
    await runManageTool('memory', { action: 'forget', id: 'm2' }, ctx);
    expect(ctx.settings.memories.map((m) => m.text)).toEqual(['Has two cats', 'Lives in Manila']);
    expect(calls.filter((c) => c === 'save')).toHaveLength(3);
  });
  it('memory list: this persona and the shared ones by default, others only with scope all; pages', async () => {
    const { ctx } = mk();
    ctx.settings.memories.push({ id: 'm3', text: 'Private note of another persona', scope: 'p2' });
    const r = (await runManageTool('memory', { action: 'list' }, ctx)).result;
    expect(r).toContain('m1 [everyone]');
    expect(r).toContain('m2 [Lia]');
    expect(r).not.toContain('Private note');
    expect(r).toMatch(/1 memories of other personas are not shown – scope all/);
    expect((await runManageTool('memory', { action: 'list', scope: 'all' }, ctx)).result).toContain('m3');
    expect((await runManageTool('memory', { action: 'list', scope: 'this_persona' }, ctx)).result).not.toContain('m1');
    for (let i = 0; i < 60; i++) ctx.settings.memories.push({ id: 'g' + i, text: 'Fact number ' + i, scope: 'global' });
    const p1 = (await runManageTool('memory', { action: 'list' }, ctx)).result;
    expect(p1).toMatch(/^Memories 1–50 of 62:/);
    expect(p1).toMatch(/12 more – list again with offset 50/);
    const p2 = (await runManageTool('memory', { action: 'list', offset: 50 }, ctx)).result;
    expect(p2).toMatch(/^Memories 51–62 of 62:/);
    expect(p2).toContain('g59');
  });
  it('memory add refuses a near-duplicate and names it', async () => {
    const { ctx } = mk();
    ctx.settings.memories.push({ id: 'm4', text: 'Fixed the black screen by updating the router firmware', scope: 'global' });
    const r = await runManageTool('memory', { action: 'add', text: 'Fixed the black screen by updating router firmware' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/nearly the same as m4.*edit it/);
    expect(nearDuplicate('Has a cat called Mochi', 'Lives in Manila with family')).toBe(false);
    // reworded: still caught; force adds it anyway
    expect(nearDuplicate('Amon fixed the black screen with a router firmware update', 'Amon fixed the black screen by updating the router firmware')).toBe(true);
    expect(nearDuplicate('Prefers short answers in the morning', 'Prefers long detailed answers about history')).toBe(false);
    const f = await runManageTool('memory', { action: 'add', text: 'Fixed the black screen by updating router firmware', force: true }, ctx);
    expect(f.result).toMatch(/^Remembered/);
  });
  it('saved tools: read, disable, delete', async () => {
    const { ctx } = mk();
    expect((await runManageTool('saved_tools', { action: 'read', name: 'tool_csv_sum' }, ctx)).result).toContain('def run()');
    await runManageTool('saved_tools', { action: 'disable', name: 'csv_sum' }, ctx);
    expect(ctx.settings.skills[0].enabled).toBe(false);
    await runManageTool('saved_tools', { action: 'delete', name: 'csv_sum' }, ctx);
    expect(ctx.settings.skills).toEqual([]);
    expect(manageDefs({ python: false }).map((d) => d.function.name)).not.toContain('saved_tools');
  });
  it('mods ask before removing; lorebooks can be listed and read', async () => {
    const { ctx, calls } = mk();
    await runManageTool('manage_mod', { id: 'hello', action: 'remove' }, ctx);
    expect(calls).toContainEqual(['remove', 'hello']);
    ctx.ask = async () => 'Keep it';
    expect((await runManageTool('manage_mod', { id: 'hello', action: 'remove' }, ctx)).ok).toBe(false);
    expect((await runManageTool('read_lorebook', {}, ctx)).result).toContain('World – 1 entries · used by Lia');
    expect((await runManageTool('read_lorebook', { name: 'Lia' }, ctx)).result).toContain('Salty.');
  });
});

import { runManageTool as rmt } from '../../src/managetools.js';
describe('read_lorebook with copies of the same name', () => {
  it('tells them apart by id, says which are unattached twins, and reads one by id', async () => {
    const e = [{ keys: ['nest'], content: 'The nest.' }];
    const settings = { personas: [{ id: 'p1', name: 'Lia', lorebookId: 'lb3' }], lorebooks: [{ id: 'lb1', name: 'The Nest', entries: e }, { id: 'lb2', name: 'The Nest', entries: e }, { id: 'lb3', name: 'The Nest', entries: [...e, { keys: ['quest'], content: 'q' }] }] };
    const ctx = { settings, personaName: () => '' };
    const r = await rmt('read_lorebook', {}, ctx);
    expect(r.result).toContain('id lb1 · same content as another copy');
    expect(r.result).toContain('used by Lia · id lb3');
    expect(r.result).toContain('1 name is used by more than one lorebook');
    expect((await rmt('read_lorebook', { name: 'lb3' }, ctx)).result).toContain('2 entries');
  });
});
