/**
 * Packs: one file that installs a set of things together – snippets, recipes, skills, MCP servers and chat personas –
 * and can be removed together. A JSON file:
 *   { "chronicle_pack": 1, "id": "writing-kit", "name": "Writing kit", "version": "1.0", "description": "…", "author": "…",
 *     "snippets": [{ cmd, title, text, send? }], "recipes": [{ text }], "skills": [{ name, description, instructions, files? }],
 *     "mcpServers": [{ name, url } | { name, command }], "personas": [{ name, description, prompt }] }
 * Everything installed carries pack: <id>. Installing a newer version replaces the old one's items.
 */
import { parseRecipe, revealHidden } from './recipes.js';

const ID_RX = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const arr = (x) => (Array.isArray(x) ? x : []);

/** Validate a pack. → the pack (normalised); throws with what is wrong. */
export function parsePack(input) {
  const p = typeof input === 'string' ? JSON.parse(input) : input;
  if (!p || p.chronicle_pack !== 1) throw new Error('Not a Chronicle pack (it needs "chronicle_pack": 1)');
  if (!ID_RX.test(String(p.id || ''))) throw new Error('A pack needs an id: lowercase letters, digits, - or _');
  const out = { chronicle_pack: 1, id: p.id, name: String(p.name || p.id).slice(0, 60), version: String(p.version || '1').slice(0, 20), description: String(p.description || '').slice(0, 400), author: String(p.author || '').slice(0, 80) };
  out.snippets = arr(p.snippets).map((s) => {
    const cmd = String(s.cmd || '').replace(/^\//, '');
    if (!/^[\w-]{1,24}$/.test(cmd) || !String(s.text || '').trim()) throw new Error(`Snippet "${s.cmd}" needs a command name and text`);
    return { cmd, title: String(s.title || cmd).slice(0, 60), text: String(s.text), send: !!s.send };
  });
  out.recipes = arr(p.recipes).map((r) => {
    const parsed = parseRecipe(String(r.text || ''), r.name);
    return { name: parsed.name, text: String(r.text) };
  });
  out.skills = arr(p.skills).map((k) => {
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(String(k.name || '')) || !k.description || !k.instructions) throw new Error(`Skill "${k.name}" needs a name, description and instructions`);
    return { name: k.name, description: String(k.description).slice(0, 600), instructions: String(k.instructions), files: k.files && typeof k.files === 'object' ? Object.fromEntries(Object.entries(k.files).filter(([, v]) => typeof v === 'string')) : {} };
  });
  out.mcpServers = arr(p.mcpServers).map((m) => {
    if (m.url && !/^https:\/\//.test(m.url)) throw new Error(`MCP server "${m.name}" needs an https:// url`);
    if (!m.url && !String(m.command || '').trim()) throw new Error(`MCP server "${m.name}" needs a url or a command`);
    return m.url ? { name: String(m.name || 'server').slice(0, 30), url: m.url } : { name: String(m.name || 'local').slice(0, 30), command: String(m.command).trim() };
  });
  out.personas = arr(p.personas).map((x) => {
    if (!x.name || !x.prompt) throw new Error('A persona needs a name and a prompt');
    return { name: String(x.name).slice(0, 60), description: String(x.description || '').slice(0, 200), prompt: String(x.prompt) };
  });
  if (!out.snippets.length && !out.recipes.length && !out.skills.length && !out.mcpServers.length && !out.personas.length) throw new Error('This pack has nothing in it');
  return out;
}

/** What installing it would do, for the review screen: { lines, hidden, runs } – runs = commands that will execute code. */
export function reviewPack(p) {
  const lines = [];
  let hidden = 0;
  const scan = (s) => (hidden += revealHidden(s).count);
  for (const s of p.snippets) (lines.push(`⚡ Snippet /${s.cmd} – ${s.title}`), scan(s.text));
  for (const r of p.recipes) (lines.push(`🧪 Recipe /${r.name}`), scan(r.text));
  for (const k of p.skills) (lines.push(`📚 Skill ${k.name} – ${k.description.slice(0, 80)}`), scan(k.instructions), Object.values(k.files).forEach(scan));
  for (const m of p.mcpServers) lines.push(m.url ? `🔌 MCP server ${m.name} – ${m.url}` : `🐧 MCP server ${m.name} – runs: ${m.command}`);
  for (const x of p.personas) (lines.push(`🎭 Persona ${x.name}${x.description ? ' – ' + x.description : ''}`), scan(x.prompt));
  return { lines, hidden, runs: p.mcpServers.filter((m) => m.command).map((m) => m.command) };
}

/** Remove everything a pack installed. → how many items. */
export function uninstallPack(settings, id) {
  let n = 0;
  for (const key of ['snippets', 'recipes', 'agentSkills', 'mcpServers', 'personas']) {
    const before = (settings[key] || []).length;
    settings[key] = (settings[key] || []).filter((x) => x.pack !== id);
    n += before - settings[key].length;
  }
  settings.packs = (settings.packs || []).filter((x) => x.id !== id);
  return n;
}

/**
 * Install (or update) a pack into the settings. Hidden characters are removed. Something of yours with the same name is
 * kept, and the pack's copy is skipped. → { added, skipped: [names] }
 */
export function installPack(settings, p, { uid, newSkill, newPersona }) {
  uninstallPack(settings, p.id); // an update replaces the old version's items
  const clean = (s) => revealHidden(s).clean;
  const tag = { pack: p.id };
  const skipped = [];
  let added = 0;
  for (const s of p.snippets) {
    if ((settings.snippets ||= []).some((x) => x.cmd === s.cmd)) skipped.push('/' + s.cmd);
    else (settings.snippets.push({ id: 's_' + uid().slice(0, 8), ...s, text: clean(s.text), ...tag }), added++);
  }
  for (const r of p.recipes) {
    if ((settings.recipes ||= []).some((x) => x.name === r.name)) skipped.push('/' + r.name);
    else (settings.recipes.push({ id: 'rc_' + uid().slice(0, 8), name: r.name, text: clean(r.text), at: Date.now(), ...tag }), added++);
  }
  for (const k of p.skills) {
    if ((settings.agentSkills ||= []).some((x) => x.name === k.name)) skipped.push(k.name);
    else (settings.agentSkills.push({ ...newSkill({ name: k.name, description: clean(k.description), instructions: clean(k.instructions), files: Object.fromEntries(Object.entries(k.files).map(([f, v]) => [f, clean(v)])), source: 'pack' }), ...tag }), added++);
  }
  for (const m of p.mcpServers) {
    const id = 'mcp_' + uid().slice(0, 8);
    (settings.mcpServers ||= []).push(m.url ? { id, name: m.name, url: m.url, enabled: false, ...tag } : { id, name: m.name, transport: 'stdio', command: m.command, bridgeSecret: uid() + uid(), enabled: false, ...tag });
    added++;
  }
  for (const x of p.personas) (settings.personas ||= []).push({ ...newPersona({ name: x.name, description: x.description, prompt: clean(x.prompt) }), ...tag }), added++;
  (settings.packs ||= []).push({ id: p.id, name: p.name, version: p.version, author: p.author, at: Date.now() });
  return { added, skipped };
}
