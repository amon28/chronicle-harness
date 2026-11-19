import { describe, it, expect } from 'vitest';
import { runCreatorTool } from '../../src/creatortools.js';
import { toolDefs } from '../../src/tools.js';

const mkCtx = (answer = 'Add it') => {
  const calls = [];
  return {
    calls,
    ask: async (q) => (calls.push(['ask', q]), answer),
    creator: {
      character: async (c, img, rep, ts) => (calls.push(['character', c, rep, ts]), { name: c.data.name, updated: !!rep, lorebook: c.data.character_book ? c.data.character_book.entries.length : 0 }),
      lorebook: async (n, j, a) => (calls.push(['lorebook', n, a]), { entries: j.entries.length, attached: a }),
      persona: async (p) => (calls.push(['persona', p]), { updated: !!p.id }),
      find: (q, kind) => {
        const all = [{ id: 'persona-maker', name: 'Persona Maker', builtin: true, character: false }, { id: 'p_chat', name: 'Vega', builtin: false, character: false }, { id: 'p_mira', name: 'Vega', builtin: false, character: true }, { id: 'p_mira2', name: 'Mira', builtin: false, character: true }];
        if (q === 'Both') return { ambiguous: ['Mira A', 'Mira B'] };
        const pool = all.filter((x) => (kind === 'character' ? x.character : kind === 'persona' ? !x.character : true));
        const hit = pool.filter((x) => x.id === q || x.name === q);
        return hit.length === 1 ? hit[0] : null;
      },
      list: () => [{ id: 'persona-maker', name: 'Persona Maker', kind: 'persona', builtin: true, description: 'helps', lorebook: '' }, { id: 'p_mira', name: 'Vega', kind: 'character', builtin: false, description: '', lorebook: '' }],
      read: (q) => (q === 'Persona Maker' ? { id: 'persona-maker', name: 'Persona Maker', prompt: 'You are the Persona Maker.' } : null),
    },
  };
};
const card = { name: 'Mira', description: 'A tall archivist with ink-stained fingers.', first_mes: 'Hello.', character_book: { entries: [{ keys: ['library'], content: 'The library is old.' }] } };

describe('creator tools', () => {
  it('are offered only when enabled', () => {
    expect(toolDefs({ creator: true }).map((t) => t.function.name)).toEqual(expect.arrayContaining(['save_character', 'save_lorebook', 'save_persona']));
    expect(toolDefs({ creator: false }).map((t) => t.function.name)).not.toContain('save_character');
  });
  it('asks first and wraps a flat card into chara_card_v2', async () => {
    const ctx = mkCtx();
    const r = await runCreatorTool('save_character', { card: JSON.stringify(card) }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.calls[0][1]).toContain('Mira');
    expect(ctx.calls[0][1]).toContain('lorebook with 1 entries');
    expect(ctx.calls[1][1].spec).toBe('chara_card_v2');
    expect(r.result).toContain('1-entry lorebook');
  });
  it('adds nothing when the user declines, and passes their feedback on', async () => {
    const ctx = mkCtx('make her older');
    const r = await runCreatorTool('save_character', { card }, ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('make her older');
    expect(ctx.calls.some((c) => c[0] === 'character')).toBe(false);
  });
  it('uses a picture the user sent when asked, and says so when there is none', async () => {
    const ctx = mkCtx();
    ctx.userImage = (n) => (n === 1 ? 'data:image/png;base64,AAAA' : null);
    const r = await runCreatorTool('save_character', { card, image: 1 }, ctx);
    expect(ctx.calls.find((c) => c[0] === 'ask')[1]).toContain('the picture you sent');
    expect(r.result).toContain('the picture they sent');
    await expect(runCreatorTool('save_persona', { name: 'X', prompt: 'You are x.', image: 3 }, ctx)).rejects.toThrow('3 images');
  });
  it('lists and reads what exists, so the assistant can change it', async () => {
    const ctx = mkCtx();
    expect((await runCreatorTool('list_personas', {}, ctx)).result).toContain('persona-maker · Persona Maker · persona · built-in');
    expect((await runCreatorTool('read_persona', { persona: 'Persona Maker' }, ctx)).result).toContain('You are the Persona Maker');
    await expect(runCreatorTool('read_persona', { persona: 'Nobody' }, ctx)).rejects.toThrow('list_personas');
  });
  it('updates an existing (even built-in) persona in place instead of copying it', async () => {
    const ctx = mkCtx();
    const r = await runCreatorTool('save_persona', { name: 'Persona Maker', prompt: 'You are better.' }, ctx);
    expect(ctx.calls.find((c) => c[0] === 'ask')[1]).toContain('Update the persona');
    expect(ctx.calls.find((c) => c[0] === 'ask')[1]).toContain('built-in');
    expect(ctx.calls.find((c) => c[0] === 'persona')[1].id).toBe('persona-maker');
    expect(r.result).toContain('Updated');
  });
  it('replaces an existing character when asked, and refuses to mistake a character for a persona', async () => {
    const ctx = mkCtx();
    const r = await runCreatorTool('save_character', { card, replace: 'Vega' }, ctx);
    expect(ctx.calls.find((c) => c[0] === 'character')[2]).toBe('p_mira'); // the roleplay one, though a chat persona has the same name
    expect(ctx.calls.find((c) => c[0] === 'ask')[1]).toContain('Replace the character');
    expect(r.result).toContain('Updated Mira');
    // and the chat persona with the same name is updated by save_persona, without tripping over the character
    const sp = await runCreatorTool('save_persona', { name: 'Vega', prompt: 'x' }, ctx);
    expect(ctx.calls.filter((c) => c[0] === 'persona').at(-1)[1].id).toBe('p_chat');
    expect(sp.result).toContain('Updated');
    await expect(runCreatorTool('save_persona', { id: 'p_mira', name: 'Vega', prompt: 'x' }, ctx)).rejects.toThrow('save_character');
    await expect(runCreatorTool('save_character', { card, replace: 'Nobody' }, ctx)).rejects.toThrow('Existing characters: Vega (p_mira)');
    await expect(runCreatorTool('save_character', { card, replace: 'Both' }, ctx)).rejects.toThrow('matches several: Mira A, Mira B');
  });
  it('rejects cards without a name or description, and bad JSON', async () => {
    await expect(runCreatorTool('save_character', { card: { description: 'x' } }, mkCtx())).rejects.toThrow('name');
    await expect(runCreatorTool('save_character', { card: { name: 'A' } }, mkCtx())).rejects.toThrow('description');
    await expect(runCreatorTool('save_character', { card: '{nope' }, mkCtx())).rejects.toThrow('JSON');
  });
  it('saves a lorebook and a persona after approval', async () => {
    const ctx = mkCtx();
    const lb = await runCreatorTool('save_lorebook', { name: 'World', lorebook: { entries: [{ keys: ['a'], content: 'b' }] }, attach_to: 'Mira' }, ctx);
    expect(lb.result).toContain('attached it to Mira');
    const p = await runCreatorTool('save_persona', { name: 'Coach', prompt: 'You are a coach.' }, ctx);
    expect(p.result).toContain('Added the persona');
    await expect(runCreatorTool('save_lorebook', { name: 'x', lorebook: { entries: [] } }, ctx)).rejects.toThrow('no entries');
  });
  it('assign tools: on/off and only the groups it needs, shown in the approval', async () => {
    const ctx = mkCtx();
    await runCreatorTool('save_persona', { name: 'Writer', prompt: 'You write.', tools: true, toolset: ['web', 'files', 'bogus'] }, ctx);
    expect(ctx.calls.find((c) => c[0] === 'ask')[1]).toContain('tools on, tools: web, files, bogus');
    expect(ctx.calls.find((c) => c[0] === 'persona')[1]).toMatchObject({ tools: true, toolset: ['web', 'files'] });
    const c2 = mkCtx();
    await runCreatorTool('save_character', { card, tools: false, toolset: [] }, c2);
    expect(c2.calls.find((c) => c[0] === 'character')[3]).toEqual({ tools: false, toolset: [] });
    const c3 = mkCtx();
    await runCreatorTool('save_persona', { name: 'Plain', prompt: 'x' }, c3);
    expect(c3.calls.find((c) => c[0] === 'persona')[1]).toMatchObject({ tools: undefined, toolset: undefined });
  });
  it('edit_persona changes one field and leaves the rest; edit_lorebook adds/updates/removes entries', async () => {
    const ctx = mkCtx('Change it');
    ctx.creator.read = () => ({ id: 'p_mira2', name: 'Mira', character: true, card: { name: 'Mira', description: 'She is 25.', first_mes: 'Hi.' } });
    ctx.creator.edit = async (id, ch) => ctx.calls.push(['edit', id, ch]);
    const r = await runCreatorTool('edit_persona', { persona: 'Mira', edits: [{ old_text: '25', new_text: '40' }], toolset: [] }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.calls.find((c) => c[0] === 'ask')[1]).toContain('description (1 edit)');
    const ed = ctx.calls.find((c) => c[0] === 'edit');
    expect(ed[1]).toBe('p_mira2');
    expect(ed[2].card).toEqual({ name: 'Mira', description: 'She is 40.', first_mes: 'Hi.' });
    expect(ed[2].toolset).toEqual([]);
    const c2 = mkCtx('Change it');
    c2.creator.findLorebook = () => ({ id: 'lb1', name: 'World', entries: [{ name: 'Sea', keys: ['sea'], content: 'Salty.' }] });
    c2.creator.setLoreEntries = async (id, e) => c2.calls.push(['lore', id, e]);
    const r2 = await runCreatorTool('edit_lorebook', { lorebook: 'World', add: [{ keys: ['moon'], content: 'Two moons.' }], update: [{ entry: 'sea', content: 'Very salty.' }] }, c2);
    expect(r2.result).toContain('now has 2 entries');
    expect(c2.calls.find((c) => c[0] === 'lore')[2].map((e) => e.content)).toEqual(['Very salty.', 'Two moons.']);
  });
  it('edit_persona delete asks and refuses built-ins; edit_lorebook delete asks', async () => {
    const ctx = mkCtx('Delete it');
    ctx.creator.read = (q) => (q === 'Persona Maker' ? { id: 'persona-maker', name: 'Persona Maker', builtin: true } : { id: 'p9', name: 'Old', character: true, card: {} });
    ctx.creator.remove = async (id) => ctx.calls.push(['remove', id]);
    await expect(runCreatorTool('edit_persona', { persona: 'Persona Maker', delete: true }, ctx)).rejects.toThrow(/built in/);
    const r = await runCreatorTool('edit_persona', { persona: 'Old', delete: true }, ctx);
    expect(r.result).toBe('Deleted “Old”.');
    expect(ctx.calls).toContainEqual(['remove', 'p9']);
    ctx.creator.findLorebook = () => ({ id: 'lb1', name: 'World', entries: [] });
    ctx.creator.removeLorebook = async (id) => ctx.calls.push(['rmlb', id]);
    await runCreatorTool('edit_lorebook', { lorebook: 'World', delete: true }, ctx);
    expect(ctx.calls).toContainEqual(['rmlb', 'lb1']);
  });
});
