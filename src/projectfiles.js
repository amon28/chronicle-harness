// Project files that change how the agent works, like Claude Code's .claude/ folder (both folder names are read):
//   .chronicle/commands/<name>.md  →  /name   (the file is the prompt; $ARGUMENTS = what you type after the command)
//   .chronicle/agents/<name>.md    →  a named helper for delegate (front matter: name, description, tools, model)
//   .chronicle/styles/<name>.md    →  an output style you can pick for the chat
//   .chronicle/recipes/<name>.md   →  a recipe (steps with parameters; see recipes.js)

const DIRS = ['.chronicle/', '.claude/'];

/** "---\nkey: value\n---\nbody" → { meta, body } */
export function frontMatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(String(text || ''));
  if (!m) return { meta: {}, body: String(text || '') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: String(text).slice(m[0].length) };
}

function filesIn(files, sub, decode) {
  const out = [];
  for (const dir of DIRS) {
    for (const p of Object.keys(files || {})) {
      if (!p.startsWith(dir + sub + '/') || !p.endsWith('.md')) continue;
      const name = p.slice((dir + sub + '/').length, -3);
      if (!/^[\w-]{1,40}$/.test(name) || out.some((x) => x.name === name)) continue;
      const text = decode(files[p].data);
      if (text != null) out.push({ name, path: p, ...frontMatter(text) });
    }
  }
  return out;
}

/** → [{ cmd, title, text, path }] */
export const projectCommands = (files, decode) =>
  filesIn(files, 'commands', decode).map((f) => ({ cmd: f.name, title: (f.meta.description || f.body.trim().split('\n')[0] || f.name).slice(0, 80), text: f.body.trim(), path: f.path, project: true }));

/** The command's prompt with what you typed: $ARGUMENTS (or $1 $2 …) filled in, or appended when it has none. */
export function expandCommand(text, args) {
  const a = String(args || '').trim();
  const words = a.split(/\s+/).filter(Boolean);
  if (/\$ARGUMENTS|\$\d/.test(text)) return text.replace(/\$ARGUMENTS/g, a).replace(/\$(\d)/g, (_, n) => words[Number(n) - 1] || '');
  return a ? `${text}\n\n${a}` : text;
}

/** → [{ name, description, tools: 'none'|'read'|'full', allow: [names]|null, model, prompt, path }] */
export const projectAgents = (files, decode) =>
  filesIn(files, 'agents', decode).map((f) => {
    const t = String(f.meta.tools || '').trim();
    const mode = /^(none|read|full)$/i.test(t) ? t.toLowerCase() : t ? 'full' : 'read';
    const allow = t && !/^(none|read|full)$/i.test(t) ? t.split(/[,\s]+/).filter(Boolean) : null;
    return { name: f.meta.name || f.name, description: (f.meta.description || '').slice(0, 200), tools: mode, allow, model: f.meta.model || '', prompt: f.body.trim(), path: f.path };
  });

/** → [{ name, description, prompt, path }] */
export const projectStyles = (files, decode) => filesIn(files, 'styles', decode).map((f) => ({ name: f.meta.name || f.name, description: f.meta.description || '', prompt: f.body.trim(), path: f.path }));

/** .chronicle/recipes/<name>.md → [{ name, text, path, project: true }] (parsed by recipes.js) */
export const projectRecipeFiles = (files, decode) =>
  filesIn(files, 'recipes', decode).map((f) => ({ name: (f.meta.name || f.name).toLowerCase(), text: `---\n${Object.entries(f.meta).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${f.body}`, path: f.path, project: true }));
