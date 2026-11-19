import { describe, it, expect } from 'vitest';
import { parseLoreSuggestions, buildLoreRequest } from '../../src/lorehelp.js';

describe('lore suggestions', () => {
  const reply = '```json\n{"entries":[{"name":"Glade","keys":["glade","clearing"],"content":"A clearing."},{"name":"Oak","keys":"oak, old oak","content":"A tree."},{"name":"","keys":[],"content":"junk"},{"name":"Empty","keys":["x"],"content":""}]}\n```';
  it('parses entries out of a fenced JSON reply and drops incomplete ones', () => {
    const r = parseLoreSuggestions(reply);
    expect(r.map((e) => e.name)).toEqual(['Glade', 'Oak']);
    expect(r[1].keys).toEqual(['oak', 'old oak']);
  });
  it('skips what the lorebook already has (by name or keys)', () => {
    expect(parseLoreSuggestions(reply, [{ name: 'The glade', keys: ['glade'] }]).map((e) => e.name)).toEqual(['Oak']);
    expect(parseLoreSuggestions(reply, [{ name: 'x', keys: ['GLADE', 'clearing'] }]).map((e) => e.name)).toEqual(['Oak']);
  });
  it('returns nothing for garbage', () => {
    expect(parseLoreSuggestions('sorry, no')).toEqual([]);
    expect(parseLoreSuggestions('{"entries":"no"}')).toEqual([]);
  });
  it('lists the existing entries in the request', () => {
    expect(buildLoreRequest({ transcript: 'A: hi', existing: [{ name: 'Glade', keys: ['glade'] }], charName: 'Mira', userName: 'Alex' })).toContain('- Glade: glade');
  });
});
