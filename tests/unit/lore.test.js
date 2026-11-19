import { describe, it, expect } from 'vitest';
import { activeLore, importLorebook } from '../../src/lore.js';

const book = (entries, extra = {}) => ({ id: 'b', name: 'B', recursive: false, entries, ...extra });
const entry = (o) => ({ enabled: true, keys: [], content: 'x', position: 'before', order: 100, ...o });

describe('activeLore', () => {
  it('activates entries whose keys appear (whole words, case-insensitive)', () => {
    const r = activeLore([book([entry({ keys: ['dragon'], content: 'Dragons breathe fire.' }), entry({ keys: ['elf'], content: 'Elves.' })])], 'A DRAGON appears! Shelf.');
    expect(r.before).toContain('Dragons breathe fire.');
    expect(r.before).not.toContain('Elves.'); // "Shelf" doesn't match whole word "elf"
  });
  it('supports /regex/ keys and constant entries', () => {
    const r = activeLore([book([entry({ keys: ['/drag(on|oons)/i'], content: 'R' }), entry({ constant: true, content: 'C' })])], 'dragoons');
    expect(r.before).toContain('R');
    expect(r.before).toContain('C');
  });
  it('applies secondary-key logic', () => {
    const e = (logic) => entry({ keys: ['castle'], secondaryKeys: ['night'], selective: true, logic, content: logic });
    const r = activeLore([book([e('and_any'), e('not_any')])], 'the castle at night');
    expect(r.before).toContain('and_any');
    expect(r.before).not.toContain('not_any');
  });
  it('puts entries at their position (after / at a depth)', () => {
    const r = activeLore([book([entry({ keys: ['inn'], position: 'after', content: 'AFTER' }), entry({ keys: ['inn'], position: 'depth', depth: 2, role: 'user', content: 'DEPTH' })])], 'the inn');
    expect(r.after).toContain('AFTER');
    expect(r.depth).toEqual([expect.objectContaining({ depth: 2, role: 'user', content: 'DEPTH' })]);
  });
  it('recursive scanning lets one entry trigger another', () => {
    const entries = [entry({ keys: ['king'], content: 'The king rules from Eldoria.' }), entry({ keys: ['eldoria'], content: 'Eldoria is a city.' })];
    expect(activeLore([book(entries)], 'the king').before).not.toContain('Eldoria is a city.');
    expect(activeLore([book(entries, { recursive: true })], 'the king').before).toContain('Eldoria is a city.');
  });
  it('respects the token budget', () => {
    const big = 'w'.repeat(4000);
    const r = activeLore([book([entry({ constant: true, content: big, order: 1 }), entry({ constant: true, content: big, order: 2 })], { budgetTokens: 1500 })], '');
    expect(r.before.length).toBeLessThan(8000);
  });
});

describe('importLorebook', () => {
  it('imports SillyTavern world info', () => {
    const st = { entries: { 0: { uid: 0, key: ['tavern'], keysecondary: ['night'], selective: true, selectiveLogic: 0, content: 'The tavern.', position: 4, depth: 3, role: 1, order: 50, disable: false } } };
    const b = importLorebook(st, 'World', 'lb_1');
    expect(b.name).toBe('World');
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]).toMatchObject({ keys: ['tavern'], secondaryKeys: ['night'], content: 'The tavern.' });
  });
});

describe('lorebook timed effects', () => {
  const book = (e) => [{ entries: [{ id: 'x', keys: ['dragon'], content: 'Dragons breathe fire.', enabled: true, ...e }] }];
  it('delay: not before the chat has N messages', async () => {
    const { activeLore } = await import('../../src/lore.js');
    expect(activeLore(book({ delay: 5 }), 'a dragon', { turn: 3 }).hits).toHaveLength(0);
    expect(activeLore(book({ delay: 5 }), 'a dragon', { turn: 5 }).hits).toHaveLength(1);
  });
  it('sticky keeps it on without the keyword, then cooldown blocks it', async () => {
    const { activeLore } = await import('../../src/lore.js');
    const b = book({ sticky: 2, cooldown: 3 });
    let r = activeLore(b, 'a dragon', { turn: 10, timers: {} });
    expect(r.hits).toHaveLength(1);
    expect(r.timers.x).toEqual({ sticky: 12, cooldown: 15 });
    r = activeLore(b, 'nothing here', { turn: 11, timers: r.timers });
    expect(r.hits).toHaveLength(1); // sticky
    r = activeLore(b, 'a dragon again', { turn: 13, timers: r.timers });
    expect(r.hits).toHaveLength(0); // cooling down
    r = activeLore(b, 'a dragon again', { turn: 15, timers: r.timers });
    expect(r.hits).toHaveLength(1); // free again
  });
  it('without a turn number nothing is timed (old behaviour)', async () => {
    const { activeLore } = await import('../../src/lore.js');
    expect(activeLore(book({ delay: 50 }), 'a dragon').hits).toHaveLength(1);
  });
});
