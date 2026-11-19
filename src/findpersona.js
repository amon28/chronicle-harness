// Find a persona/character by what the user or the model calls it: id, exact name, then a unique partial match
// (“Vega” finds “Vega Okonkwo”, “maker” finds “Persona Maker”).
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** → { persona } on a clear match, { candidates } when several fit, {} when none do. */
export function findPersona(list, query) {
  const q = norm(query);
  if (!q) return { candidates: [] };
  const byId = list.find((p) => p.id === query);
  if (byId) return { persona: byId, candidates: [] };
  const exact = list.filter((p) => norm(p.name) === q);
  if (exact.length === 1) return { persona: exact[0], candidates: [] };
  if (exact.length > 1) return { candidates: exact };
  const word = new RegExp(`(^| )${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
  const tiers = [list.filter((p) => word.test(norm(p.name))), list.filter((p) => norm(p.name).startsWith(q)), list.filter((p) => norm(p.name).includes(q))];
  for (const t of tiers) {
    if (t.length === 1) return { persona: t[0], candidates: [] };
    if (t.length > 1) return { candidates: t };
  }
  return { candidates: [] };
}
