// Every tool call's arguments are checked against the tool's own schema before it runs (decision 199), as Claude
// Code's calls already were (decision 170): a near-miss parameter name is read as the right one, "5" becomes 5 and
// "true" becomes true where the schema says so, a missing required parameter is refused with what the tool takes.
// Chronicle's own tools leave out (and say) parameters they do not take; MCP and mod tools keep them (their schemas
// may not list everything the server accepts).
import { checkArgs } from './cctools.js';

const typeOf = (p) => (Array.isArray(p?.type) ? p.type.find((t) => t !== 'null') : p?.type);

/** "5" → 5, "true" → true, "a" → ["a"], a JSON-looking string → its value – only where the schema asks for that type. */
function coerce(v, prop) {
  const t = typeOf(prop);
  if (typeof v !== 'string' || !t || t === 'string') return { v, changed: false };
  const s = v.trim();
  if ((t === 'integer' || t === 'number') && /^-?\d+(\.\d+)?$/.test(s)) return { v: t === 'integer' ? Math.round(Number(s)) : Number(s), changed: true };
  if (t === 'boolean' && /^(true|false)$/i.test(s)) return { v: s.toLowerCase() === 'true', changed: true };
  if (t === 'array' || t === 'object') {
    if (/^[[{]/.test(s)) {
      try {
        const j = JSON.parse(s);
        if (t === 'array' ? Array.isArray(j) : j && typeof j === 'object' && !Array.isArray(j)) return { v: j, changed: true };
      } catch {
        /* left as it is: the tool says what is wrong */
      }
    }
    if (t === 'array' && s) return { v: [v], changed: true };
  }
  return { v, changed: false };
}

/**
 * name, schema (the tool's `parameters`), raw (the arguments as the model sent them, JSON text).
 * → null (nothing to check, or JSON the tool reports itself), { error }, or { arguments, note, changed }.
 */
export function repairArgs(name, schema, raw) {
  if (!schema?.properties || !Object.keys(schema.properties).length) return null;
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch {
    return null; // broken JSON: the tool's own message says where it broke (badArgsMessage)
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const foreign = /^(mcp_|mod_)/.test(name);
  const r = checkArgs(name, schema, args, { lenient: true });
  if (r.error) return { error: `${r.error} Call it again with those.` };
  let out = r.args;
  const notes = r.note ? [r.note.replace(/^\(|\.\)$/g, '')] : [];
  if (foreign) {
    // an MCP or mod tool keeps what its schema does not list (only near-miss names are moved)
    const moved = new Set([...notes.join(' ').matchAll(/"([^"]+)" was read as/g)].map((m) => m[1]));
    for (const k of Object.keys(args)) if (!(k in out) && !moved.has(k)) out = { ...out, [k]: args[k] };
    const keep = notes.map((n) => n.split('; ').filter((x) => !x.startsWith('ignored ')).join('; ')).filter(Boolean);
    notes.length = 0;
    notes.push(...keep);
  }
  const coerced = [];
  for (const [k, prop] of Object.entries(schema.properties)) {
    if (!(k in out)) continue;
    const c = coerce(out[k], prop);
    if (c.changed) {
      out = { ...out, [k]: c.v };
      coerced.push(k);
    }
  }
  if (coerced.length) notes.push(`read ${coerced.map((k) => `"${k}"`).join(', ')} as the type ${name} takes`);
  const text = JSON.stringify(out);
  const changed = text !== JSON.stringify(args);
  return { arguments: changed ? text : raw, note: notes.length ? `(${notes.join('; ')}.)` : '', changed };
}
