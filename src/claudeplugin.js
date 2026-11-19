/**
 * Claude plugins → a Chronicle pack. A Claude Code / claude.ai plugin is a folder:
 *   .claude-plugin/plugin.json   name, version, description, author, and optional component paths
 *   skills/<name>/SKILL.md       a skill (front matter name + description, Markdown body) plus its own files
 *   commands/*.md                slash commands ($ARGUMENTS = what you type after the command)
 *   agents/*.md                  subagents (front matter name, description, tools, model; body = its prompt)
 *   .mcp.json                    MCP servers: { url, type: http|sse } or { command, args, env } (stdio)
 *   hooks/hooks.json             shell commands run on events – never installed here
 * A marketplace is a repo with .claude-plugin/marketplace.json listing plugins and where each one is.
 *
 * Everything here is pure (no app state): it reads files the caller fetched (a GitHub tree, or a .zip the user
 * picked) and turns them into a pack (see packs.js) plus a list of what is left out and why. All plugin text is
 * untrusted: it becomes model instructions only once the user has seen it in the review and installed it.
 */

export const LIMITS = { files: 300, file: 200000, total: 2000000, zip: 20e6 };
const TEXT_EXT = /\.(md|markdown|mdx|txt|rst|json|jsonc|ya?ml|toml|ini|cfg|conf|py|sh|bash|zsh|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|xml|xsd|svg|csv|tsv|sql|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|lua|pl|php|r|tex|env|example|template|tmpl|j2)$/i;
const TEXT_NAMES = /(^|\/)(LICENSE|LICENCE|NOTICE|README|Makefile|Dockerfile|CHANGELOG)[^/]*$/i;
/** Whether a file is worth reading as text (by name – bytes are checked again where there are bytes). */
export const isTextPath = (p) => TEXT_EXT.test(p) || TEXT_NAMES.test(p);

const arr = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);
const rel = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
const slug = (s, max = 49) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
const json = (text, what) => {
  try {
    return JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`${what} is not valid JSON (${e.message})`);
  }
};

/**
 * YAML-ish front matter: "key: value", quoted values, folded/literal blocks (> |) and "- item" lists (joined with
 * ", "). Enough for SKILL.md, commands and agents; anything fancier is kept as its raw text.
 */
export function frontMatter(text) {
  const t = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) return { meta: {}, body: t.trim() };
  const meta = {};
  let key = null;
  let block = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (kv) {
      key = kv[1].toLowerCase();
      const v = kv[2].trim();
      block = /^[>|][+-]?$/.test(v) ? v[0] : null;
      meta[key] = block ? '' : v.replace(/^(["'])(.*)\1$/, '$2');
      continue;
    }
    if (!key || !line.trim()) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && !block) meta[key] = (meta[key] ? meta[key] + ', ' : '') + item[1].trim().replace(/^(["'])(.*)\1$/, '$2');
    else if (/^\s/.test(line)) meta[key] = meta[key] ? meta[key] + (block === '|' ? '\n' : ' ') + line.trim() : line.trim();
  }
  return { meta, body: t.slice(m[0].length).trim() };
}

/**
 * A GitHub link → { owner, repo, ref, path, file }. Takes github.com/OWNER/REPO, …/tree/REF/PATH, …/blob/REF/FILE,
 * raw.githubusercontent.com/OWNER/REPO/REF/FILE and the owner/repo shorthand. ref "HEAD" = the default branch.
 * A branch name with a "/" in it cannot be told from a folder: the first part is taken as the branch.
 */
export function parseGithubUrl(input) {
  const s = String(input || '').trim().replace(/[?#].*$/, '');
  let m = /^([A-Za-z0-9-]+)\/([\w.-]+)$/.exec(s);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, ''), ref: 'HEAD', path: '', file: false };
  m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(s);
  if (m) return { owner: m[1], repo: m[2], ref: m[3], path: rel(m[4]), file: true };
  m = /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/.exec(s);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[4] || 'HEAD', path: rel(m[5] ? decodeURIComponent(m[5]) : ''), file: m[3] === 'blob' };
}

/** A marketplace.json → { name, description, owner, plugins: [{ name, description, version, where, entry }] }. */
export function parseMarketplace(text, { owner, repo, ref = 'HEAD', root = '' } = {}) {
  const j = typeof text === 'string' ? json(text, 'marketplace.json') : text;
  if (!j || !Array.isArray(j.plugins)) throw new Error('Not a plugin marketplace (marketplace.json needs a "plugins" list)');
  const pluginRoot = rel(j.metadata?.pluginRoot || '');
  const plugins = j.plugins
    .filter((e) => e && typeof e === 'object' && e.name)
    .map((e) => ({ name: String(e.name).slice(0, 60), description: String(e.description || '').slice(0, 300), version: String(e.version || ''), where: pluginSource(e.source, { owner, repo, ref, root, pluginRoot }), entry: e }));
  return { name: String(j.name || ''), description: String(j.description || j.metadata?.description || ''), owner: String(j.owner?.name || ''), plugins };
}

/**
 * Where a marketplace entry's plugin is: { kind: 'here', path } (in the same repo / zip), { kind: 'github', owner,
 * repo, ref, path }, or { kind: 'none', why } for sources the phone cannot fetch (npm, archive, command, other hosts).
 */
export function pluginSource(src, { owner, repo, ref = 'HEAD', root = '', pluginRoot = '' } = {}) {
  const join = (...p) => p.map(rel).filter(Boolean).join('/');
  if (typeof src === 'string') {
    if (/(^|\/)\.\.(\/|$)/.test(src)) return { kind: 'none', why: 'its path leaves the marketplace' };
    const path = src.startsWith('./') || src === '.' ? join(root, src === '.' ? '' : src) : join(root, pluginRoot, src);
    return { kind: 'here', path, ...(owner ? { owner, repo, ref } : {}) };
  }
  const type = src?.source;
  const gh = (url) => {
    const short = /^([A-Za-z0-9-]+)\/([\w.-]+)$/.exec(String(url || ''));
    if (short) return { owner: short[1], repo: short[2].replace(/\.git$/, '') };
    const m = /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url || ''));
    return m ? { owner: m[1], repo: m[2] } : null;
  };
  if (type === 'github' && gh(src.repo)) return { kind: 'github', ...gh(src.repo), ref: src.sha || src.ref || 'HEAD', path: '' };
  if ((type === 'url' || type === 'git') && gh(src.url)) return { kind: 'github', ...gh(src.url), ref: src.sha || src.ref || 'HEAD', path: '' };
  if (type === 'git-subdir' && gh(src.url)) {
    if (/(^|\/)\.\.(\/|$)/.test(String(src.path || ''))) return { kind: 'none', why: 'its path leaves the repository' };
    return { kind: 'github', ...gh(src.url), ref: src.sha || src.ref || 'HEAD', path: rel(src.path) };
  }
  const why = { npm: 'it comes from npm', archive: 'it is a download the phone does not fetch for plugins', command: 'it is made by running a program on a computer', url: 'it is not on GitHub', git: 'it is not on GitHub', 'git-subdir': 'it is not on GitHub' }[type];
  return { kind: 'none', why: why || 'its source type is unknown' };
}

/** What a folder of files is: 'plugin', 'marketplace' or '' – files = list of paths relative to that folder. */
export function detectKind(paths) {
  const has = (p) => paths.includes(p);
  if (has('.claude-plugin/plugin.json')) return 'plugin';
  if (has('.claude-plugin/marketplace.json')) return 'marketplace';
  if (paths.some((p) => /^(skills\/[^/]+\/SKILL\.md|commands\/.+\.md|agents\/.+\.md)$/i.test(p)) || has('SKILL.md') || has('.mcp.json')) return 'plugin';
  return '';
}

/** Unpacked zip { path: Uint8Array } → { root, files: { path: text|null } } with the folder that holds the plugin. */
export function zipFiles(entries) {
  const dec = new TextDecoder('utf-8', { fatal: false });
  const all = Object.keys(entries).filter((p) => !p.endsWith('/') && !/(^|\/)__MACOSX\//.test(p) && !/(^|\/)\.DS_Store$/.test(p));
  // the plugin may be zipped as its folder or as its contents
  const marks = all.filter((p) => /(^|\/)\.claude-plugin\/(plugin|marketplace)\.json$/.test(p)).sort((a, b) => a.split('/').length - b.split('/').length || (/plugin\.json$/.test(a) ? -1 : 1));
  let root = marks.length ? marks[0].replace(/\.claude-plugin\/[^/]+$/, '') : '';
  if (!marks.length && !detectKind(all)) {
    const tops = new Set(all.map((p) => (p.includes('/') ? p.split('/')[0] + '/' : '')));
    if (tops.size === 1 && [...tops][0]) root = [...tops][0];
  }
  const files = {};
  for (const p of all) {
    if (!p.startsWith(root)) continue;
    const b = entries[p];
    const text = isTextPath(p) || /(^|\/)SKILL\.md$/i.test(p) ? (b.subarray(0, 8192).includes(0) ? null : dec.decode(b)) : null;
    files[p.slice(root.length)] = text;
  }
  return { root: root.replace(/\/$/, ''), files };
}

/** Files under one folder → paths relative to it. */
export function subtree(files, dir) {
  const d = rel(dir);
  if (!d) return files;
  const out = {};
  for (const [p, v] of Object.entries(files)) if (p.startsWith(d + '/')) out[p.slice(d.length + 1)] = v;
  return out;
}

// ---------- reading a plugin ----------

const listMd = (paths, dir) => paths.filter((p) => p.startsWith(dir + '/') && /\.md$/i.test(p) && !/(^|\/)README\.md$/i.test(p));

/**
 * The plugin in a folder → { manifest, skills, commands, agents, mcp, hooks, other, left, problems }.
 * files: { path: text | null } relative to the plugin root (null = binary or not fetched). entry: its marketplace
 * entry, when it came from one (it is the manifest when there is no plugin.json, and may list the skills).
 */
export function readPlugin(files, { entry = null, fallbackName = '' } = {}) {
  const paths = Object.keys(files);
  const text = (p) => (typeof files[rel(p)] === 'string' ? files[rel(p)] : null);
  const problems = [];
  const left = [];
  let manifest = {};
  if (text('.claude-plugin/plugin.json') != null) manifest = json(text('.claude-plugin/plugin.json'), 'plugin.json');
  else if (paths.includes('.claude-plugin/plugin.json')) throw new Error('plugin.json could not be read');
  const m = { ...(entry || {}), ...manifest };
  if (entry && manifest.name == null) m.name = entry.name;
  const name = slug(m.name || fallbackName, 40) || 'plugin';
  const author = typeof m.author === 'string' ? m.author : m.author?.name || '';
  const info = { name, displayName: String(m.displayName || ''), version: String(m.version || ''), description: String(m.description || ''), author: String(author || ''), license: String(m.license || ''), homepage: String(m.homepage || m.repository || '') };

  // skills: skills/ plus the manifest's dirs (each a folder of <name>/SKILL.md, or one SKILL.md); a marketplace entry with
  // strict: false and no plugin.json may name exactly which ones (anthropics/skills does this)
  const onlyEntry = entry && !Object.keys(manifest).length && Array.isArray(entry.skills);
  const dirs = onlyEntry ? entry.skills.map(rel) : ['skills', ...arr(m.skills).map(rel)];
  const skillDirs = new Set();
  for (const d of dirs) {
    if (text((d ? d + '/' : '') + 'SKILL.md') != null) skillDirs.add(d);
    else for (const p of paths) if (new RegExp(`^${d ? d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' : ''}[^/]+/SKILL\\.md$`).test(p)) skillDirs.add(p.slice(0, -'/SKILL.md'.length));
  }
  if (!skillDirs.size && text('SKILL.md') != null) skillDirs.add('');
  const skills = [];
  for (const d of [...skillDirs].sort()) {
    const base = d ? d + '/' : '';
    const fm = frontMatter(text(base + 'SKILL.md'));
    const n = slug(fm.meta.name || d.split('/').pop() || name);
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(n)) {
      problems.push(`skill in ${d || 'the root'}: no usable name`);
      continue;
    }
    if (skills.some((s) => s.name === n)) continue;
    const own = {};
    const skLeft = [];
    for (const p of paths) {
      if (!p.startsWith(base) || p === base + 'SKILL.md') continue;
      if (!base && /^(\.claude-plugin|skills|commands|agents|hooks)\//.test(p)) continue;
      const r = p.slice(base.length);
      if (typeof files[p] === 'string' && files[p].length <= LIMITS.file) own[r] = files[p];
      else skLeft.push(r);
    }
    left.push(...skLeft.map((r) => base + r));
    skills.push({ name: n, description: (fm.meta.description || fm.body.split('\n').find((l) => l.trim()) || n).trim(), instructions: fm.body, files: own, left: skLeft, dir: d, license: fm.meta.license || '' });
  }

  // commands: commands/ unless the manifest names its own (paths to .md files or folders, or a name → {source|content} map)
  const commands = [];
  const addCmd = (cmdName, md, extra = {}) => {
    if (md == null) return;
    const fm = frontMatter(md);
    commands.push({ name: cmdName, description: String(extra.description || fm.meta.description || '').trim(), argHint: String(extra.argumentHint || fm.meta['argument-hint'] || ''), text: fm.body });
  };
  const cmdFiles = (dir) => listMd(paths, dir).map((p) => [p.slice(dir.length + 1, -3).replace(/\//g, '-'), p]);
  if (m.commands && typeof m.commands === 'object' && !Array.isArray(m.commands)) {
    for (const [k, v] of Object.entries(m.commands)) addCmd(k, v?.content != null ? String(v.content) : text(v?.source), v || {});
  } else {
    for (const c of m.commands ? arr(m.commands).map(rel) : ['commands']) {
      if (/\.md$/i.test(c)) addCmd(c.split('/').pop().slice(0, -3), text(c));
      else for (const [n, p] of cmdFiles(c)) addCmd(n, text(p));
    }
  }

  // agents: agents/ (subfolders are part of the name) unless the manifest lists the files
  const agents = [];
  const agentFiles = m.agents ? arr(m.agents).map(rel).filter((p) => /\.md$/i.test(p)) : listMd(paths, 'agents');
  for (const p of agentFiles) {
    const md = text(p);
    if (md == null) continue;
    const fm = frontMatter(md);
    agents.push({ name: String(fm.meta.name || (p.startsWith('agents/') ? p.slice(7, -3).replace(/\//g, ':') : p.split('/').pop().slice(0, -3))).slice(0, 60), description: String(fm.meta.description || '').trim(), prompt: fm.body, tools: fm.meta.tools || '', model: fm.meta.model || '' });
  }

  // MCP servers: .mcp.json, then the manifest's (a .json path, an inline map, or a list of either)
  const servers = {};
  const addServers = (o, where) => {
    if (!o || typeof o !== 'object') return;
    const map = o.mcpServers && typeof o.mcpServers === 'object' ? o.mcpServers : o;
    for (const [k, v] of Object.entries(map)) if (v && typeof v === 'object') servers[k] = v;
    if (!Object.keys(map).length) problems.push(`${where}: no servers`);
  };
  if (text('.mcp.json') != null) addServers(json(text('.mcp.json'), '.mcp.json'), '.mcp.json');
  for (const x of arr(m.mcpServers)) {
    if (typeof x === 'string' && /\.json$/i.test(x) && text(x) != null) addServers(json(text(x), x), x);
    else if (typeof x === 'string') problems.push(`MCP bundle ${x}: bundles (.mcpb/.dxt) are for desktop apps`);
    else addServers(x, 'plugin.json');
  }
  const mcp = Object.entries(servers).map(([k, v]) => ({ name: k, type: v.type || (v.url ? 'http' : v.command ? 'stdio' : ''), url: String(v.url || ''), command: String(v.command || ''), args: arr(v.args).map(String), env: v.env && typeof v.env === 'object' ? v.env : {}, headers: v.headers && typeof v.headers === 'object' ? v.headers : {}, oauth: !!v.oauth }));

  // hooks: hooks/hooks.json and the manifest's – only listed, never run
  const hooks = [];
  const addHooks = (o) => {
    const map = o?.hooks && typeof o.hooks === 'object' && !Array.isArray(o.hooks) ? o.hooks : o;
    for (const [event, list] of Object.entries(map || {})) for (const g of arr(list)) for (const h of arr(g?.hooks)) hooks.push({ event, matcher: String(g.matcher || ''), type: String(h.type || 'command'), command: String(h.command || h.url || h.prompt || '') });
  };
  if (text('hooks/hooks.json') != null) {
    try {
      addHooks(json(text('hooks/hooks.json'), 'hooks/hooks.json'));
    } catch (e) {
      problems.push(e.message);
    }
  }
  for (const x of arr(m.hooks)) {
    if (typeof x === 'string' && text(x) != null) {
      try {
        addHooks(json(text(x), x));
      } catch (e) {
        problems.push(e.message);
      }
    } else if (x && typeof x === 'object') addHooks(x);
  }

  // the rest Claude Code knows and Chronicle has no use for
  const other = [];
  const any = (re) => paths.some((p) => re.test(p));
  if (text('.lsp.json') != null || m.lspServers) other.push('language servers (.lsp.json)');
  if (any(/^output-styles\//) || m.outputStyles) other.push('output styles');
  if (any(/^monitors\//) || m.experimental?.monitors) other.push('monitors');
  if (any(/^themes\//) || m.experimental?.themes) other.push('themes');
  if (any(/^workflows\//) || m.workflows) other.push('workflows');
  if (any(/^bin\//)) other.push('bin/ programs');
  if (m.userConfig && Object.keys(m.userConfig).length) other.push(`settings it asks for (${Object.keys(m.userConfig).join(', ')})`);

  return { manifest: info, skills, commands, agents, mcp, hooks, other, left, problems };
}

// ---------- a plugin → a pack ----------

const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
const PLUGIN_VAR = /\$\{CLAUDE_PLUGIN_(ROOT|DATA)\}/;
const title = (s) => String(s).replace(/(^|[-_ ])(\w)/g, (_, a, b) => (a ? ' ' : '') + b.toUpperCase());

/**
 * readPlugin's result → { pack (for parsePack/installPack), skipped: [{ what, why }], notes: [text] }.
 * shell: whether the built-in Linux can run stdio servers here.
 */
export function pluginToPack(pl, { shell = false } = {}) {
  const skipped = [];
  const notes = [];
  const info = pl.manifest;
  const skills = pl.skills.map((k) => {
    // ${CLAUDE_SKILL_DIR} and the plugin's own skills folder are where Chronicle copies a skill's files
    let ins = k.instructions.replace(/\$\{CLAUDE_SKILL_DIR\}/g, `/workspace/skills/${k.name}`).replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/([\w.-]+)/g, (_, d) => `/workspace/skills/${pl.skills.find((s) => s.dir.split('/').pop() === d)?.name || d}`);
    if (/\]\(\.\.\//.test(ins)) notes.push(`Skill ${k.name} links to files outside its folder (../…); only the skill's own folder is copied.`);
    if (PLUGIN_VAR.test(ins)) notes.push(`Skill ${k.name} points at other files of the plugin (\${CLAUDE_PLUGIN_ROOT}); only the skill's own folder is copied.`);
    if (/^!`|^```!/m.test(ins)) notes.push(`Skill ${k.name} has !\`command\` lines that Claude Code runs before reading it; here they stay plain text.`);
    if (k.left.length) skipped.push({ what: `${k.name}: ${k.left.length} file${k.left.length === 1 ? '' : 's'} (${k.left.slice(0, 4).join(', ')}${k.left.length > 4 ? ', …' : ''})`, why: 'not text, or too big – skills keep text files only' });
    return { name: k.name, description: k.description.slice(0, 600), instructions: ins || k.description, files: k.files };
  });
  const snippets = [];
  for (const c of pl.commands) {
    const cmd = slug(c.name, 24).replace(/-+$/, '');
    if (!cmd || !c.text.trim()) {
      skipped.push({ what: `command /${c.name}`, why: 'no name or no text' });
      continue;
    }
    if (snippets.some((s) => s.cmd === cmd)) continue;
    // Claude's $ARGUMENTS is what snippets call {{text}}; numbered $1 … are left as written
    const text = c.text.replace(/\$ARGUMENTS(?!\[)/g, '{{text}}');
    if (/\$ARGUMENTS\[|\$\d/.test(text)) notes.push(`/${cmd} uses numbered arguments ($1, $2 …); a snippet passes everything you type as one text.`);
    if (/^!`|^```!/m.test(text)) notes.push(`/${cmd} runs shell commands on a computer before it is sent; here those lines are sent as text.`);
    snippets.push({ cmd, title: (c.description || c.text.split('\n').find((l) => l.trim()) || cmd).replace(/^#+\s*/, '').slice(0, 60), text });
  }
  const personas = pl.agents.filter((a) => a.prompt.trim()).map((a) => ({ name: a.name, description: a.description.slice(0, 200), prompt: a.prompt }));
  const mcpServers = [];
  for (const s of pl.mcp) {
    const label = `MCP server ${s.name}`;
    if (s.type === 'http' || s.type === 'sse' || (s.url && s.type !== 'stdio')) {
      if (!s.url) skipped.push({ what: label, why: 'it has no address yet (the plugin leaves it for you to fill in)' });
      else if (PLUGIN_VAR.test(s.url) || /\$\{/.test(s.url)) skipped.push({ what: label, why: `its address needs a setting (${s.url})` });
      else if (!/^https:\/\//.test(s.url)) skipped.push({ what: label, why: 'it is not https' });
      else {
        mcpServers.push({ name: s.name, url: s.url });
        if (s.type === 'sse') notes.push(`${s.name} uses the older SSE transport; Chronicle speaks Streamable HTTP, so it may not connect.`);
        const need = Object.keys(s.headers);
        if (need.length) notes.push(`${s.name} wants header${need.length === 1 ? '' : 's'} ${need.join(', ')}: add ${need.length === 1 ? 'it' : 'them'} in Settings › MCP servers before switching it on.`);
      }
    } else if (s.type === 'stdio' || s.command) {
      const all = [s.command, ...s.args, ...Object.values(s.env).map(String)].join(' ');
      if (!shell) skipped.push({ what: `${label} (${s.command})`, why: 'it runs a program; that needs the built-in Linux (Settings › Linux terminal), which is not set up' });
      else if (PLUGIN_VAR.test(all)) skipped.push({ what: `${label} (${s.command})`, why: 'it runs a program from the plugin folder, which only exists on a computer' });
      else {
        const env = Object.entries(s.env).filter(([, v]) => !/\$\{/.test(String(v)));
        const need = Object.entries(s.env).filter(([, v]) => /\$\{/.test(String(v))).map(([k]) => k);
        mcpServers.push({ name: s.name, command: [...env.map(([k, v]) => `${k}=${q(String(v))}`), s.command, ...s.args.map(q)].join(' ') });
        if (need.length) notes.push(`${s.name} needs ${need.join(', ')}: put ${need.map((k) => k + '=…').join(' ')} in front of its command in Settings › MCP servers.`);
      }
    } else skipped.push({ what: label, why: 'it has neither an address nor a command' });
  }
  if (pl.hooks.length) skipped.push({ what: `${pl.hooks.length} hook${pl.hooks.length === 1 ? '' : 's'} (${[...new Set(pl.hooks.map((h) => h.event))].join(', ')})`, why: 'hooks run commands on a computer whenever Claude Code does something; Chronicle never installs them' });
  for (const o of pl.other) skipped.push({ what: o, why: 'a Claude Code feature Chronicle does not have' });
  for (const p of pl.problems) skipped.push({ what: p, why: 'could not be read' });
  const id = (slug(info.name, 40) || 'plugin').padEnd(2, '0');
  const pack = {
    chronicle_pack: 1,
    id,
    name: (info.displayName || title(info.name)).slice(0, 60),
    version: info.version || '1',
    description: info.description.slice(0, 400),
    author: info.author.slice(0, 80),
    snippets,
    recipes: [],
    skills,
    mcpServers,
    personas,
  };
  if (pl.agents.length) notes.push(`Its agent${pl.agents.length === 1 ? ' becomes a chat persona' : 's become chat personas'}: pick one on a new chat's start screen. Claude's tool lists in them (Read, Bash …) do not apply here.`);
  return { pack, skipped, notes: [...new Set(notes)], license: info.license };
}

// ---------- fetching from GitHub ----------

const GH_HOSTS = ['api.github.com', 'raw.githubusercontent.com'];
/** The GitHub token goes only to GitHub itself. */
export function githubHeaders(url, token, apiBase = 'https://api.github.com') {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();
  const ok = token && (GH_HOSTS.includes(host) || host === new URL(apiBase).host);
  return { Accept: 'application/vnd.github+json', ...(ok ? { Authorization: `Bearer ${token}` } : {}) };
}

/**
 * A repo's file list (one API call) → { paths: [{ path, size }], truncated }.
 * http(url, headers) → { status, body } (the app's httpGet).
 */
export async function githubTree({ owner, repo, ref = 'HEAD' }, { http, token = '', api = 'https://api.github.com' }) {
  const url = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const r = await http(url, githubHeaders(url, token, api));
  if (r.status === 404) throw new Error(`GitHub has no ${owner}/${repo}${ref !== 'HEAD' ? ` at ${ref}` : ''} (or it is private: sign in to GitHub in Settings)`);
  if (r.status === 403 || r.status === 429) throw new Error('GitHub refused (rate limit?) – try again later, or sign in to GitHub in Settings');
  if (r.status >= 400) throw new Error(`GitHub answered ${r.status}`);
  const j = json(r.body, 'GitHub’s answer');
  return { paths: (j.tree || []).filter((t) => t.type === 'blob').map((t) => ({ path: t.path, size: Number(t.size) || 0 })), truncated: !!j.truncated };
}

/**
 * The text files under one folder of a tree, within the limits → { files: { relPath: text|null } } (null = left out:
 * not text, too big, or past the limits). raw(owner, repo, ref, path) → its URL.
 */
export async function githubFiles({ owner, repo, ref = 'HEAD', path = '' }, tree, { http, token = '', api, raw = 'https://raw.githubusercontent.com', only = null }) {
  const dir = rel(path);
  const files = {};
  const want = [];
  let total = 0;
  for (const t of tree.paths) {
    if (dir && !t.path.startsWith(dir + '/')) continue;
    const r = dir ? t.path.slice(dir.length + 1) : t.path;
    files[r] = null;
    if (only && !only(r)) continue;
    if (!(isTextPath(r) || /(^|\/)SKILL\.md$/i.test(r)) || t.size > LIMITS.file || total + t.size > LIMITS.total || want.length >= LIMITS.files) continue;
    total += t.size;
    want.push(r);
  }
  for (let i = 0; i < want.length; i += 6) {
    await Promise.all(
      want.slice(i, i + 6).map(async (r) => {
        const url = `${raw}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${(dir ? dir + '/' + r : r).split('/').map(encodeURIComponent).join('/')}`;
        const res = await http(url, githubHeaders(url, token, api));
        if (res.status < 400 && typeof res.body === 'string' && !res.body.slice(0, 8192).includes('\u0000')) files[r] = res.body;
      }),
    );
  }
  return { files };
}

/**
 * Which files of a plugin folder to fetch: the places Claude Code reads components from (and the paths its
 * plugin.json / marketplace entry name) – not the rest of a big repo. manifest: the parsed plugin.json or null.
 */
export function wantedFilter(manifest, entry, paths) {
  if (paths.includes('SKILL.md') && !paths.some((p) => p.startsWith('skills/'))) return () => true; // the folder is one skill
  const m = { ...(entry || {}), ...(manifest || {}) };
  const onlyEntry = entry && !manifest && Array.isArray(entry.skills);
  const dirs = onlyEntry ? entry.skills.map(rel) : ['skills', 'commands', 'agents', 'hooks', ...arr(m.skills), ...(m.commands && typeof m.commands === 'object' && !Array.isArray(m.commands) ? Object.values(m.commands).map((v) => v?.source) : arr(m.commands)), ...arr(m.agents), ...arr(m.hooks), ...arr(m.mcpServers)].filter((x) => typeof x === 'string').map(rel);
  return (p) => p.startsWith('.claude-plugin/') || p === '.mcp.json' || p === '.lsp.json' || dirs.some((d) => d && (p === d || p.startsWith(d + '/')));
}

// ---------- one entry point per input ----------

/**
 * A GitHub link → { kind: 'plugin', plugin, where } or { kind: 'marketplace', market, where }.
 * deps: { http, token, api, raw }. A link to a marketplace.json or plugin.json file opens its folder.
 */
export async function loadGithub(url, deps, { entry = null, cache = new Map() } = {}) {
  const loc = typeof url === 'string' ? parseGithubUrl(url) : url;
  if (!loc) throw new Error('Not a GitHub link (github.com/OWNER/REPO, or a folder in it)');
  if (loc.file) {
    if (!/(^|\/)\.claude-plugin\/(marketplace|plugin)\.json$/.test(loc.path)) throw new Error('Link the plugin’s folder, or its .claude-plugin/plugin.json or marketplace.json');
    loc.path = loc.path.replace(/\/?\.claude-plugin\/[^/]+$/, '');
    loc.file = false;
  }
  const key = `${loc.owner}/${loc.repo}@${loc.ref}`;
  if (!cache.has(key)) cache.set(key, await githubTree(loc, deps));
  const tree = cache.get(key);
  const dir = rel(loc.path);
  const inDir = tree.paths.filter((t) => !dir || t.path.startsWith(dir + '/')).map((t) => (dir ? t.path.slice(dir.length + 1) : t.path));
  if (!inDir.length) throw new Error(tree.truncated ? 'The repository is too big to list – link the plugin’s folder' : `Nothing at ${dir || 'the top'} of ${loc.owner}/${loc.repo}`);
  const kind = entry ? 'plugin' : detectKind(inDir);
  const where = { ...loc, path: dir };
  const fetchOne = async (p) => (await githubFiles(where, tree, { ...deps, only: (r) => r === p })).files[p];
  if (kind === 'marketplace') {
    const text = await fetchOne('.claude-plugin/marketplace.json');
    if (text == null) throw new Error('Could not read marketplace.json');
    return { kind, market: parseMarketplace(text, { owner: loc.owner, repo: loc.repo, ref: loc.ref, root: dir }), where, cache };
  }
  if (!kind) throw new Error('No Claude plugin there: no .claude-plugin/plugin.json, skills/*/SKILL.md, commands/ or agents/');
  const mText = inDir.includes('.claude-plugin/plugin.json') ? await fetchOne('.claude-plugin/plugin.json') : null;
  const manifest = mText != null ? json(mText, 'plugin.json') : null;
  const { files } = await githubFiles(where, tree, { ...deps, only: wantedFilter(manifest, entry, inDir) });
  return { kind: 'plugin', plugin: readPlugin(files, { entry, fallbackName: dir.split('/').pop() || loc.repo }), where };
}

/** One plugin of a marketplace (from loadGithub or loadZip) → { kind: 'plugin', plugin, where } – or throws why not. */
export async function loadMarketEntry(item, deps, { zip = null, cache } = {}) {
  const w = item.where;
  if (w.kind === 'none') throw new Error(`${item.name} cannot be imported here: ${w.why}`);
  if (w.kind === 'here' && zip) {
    const files = subtree(zip, w.path);
    if (!Object.keys(files).length) throw new Error(`${item.name}: nothing at ${w.path} in the zip`);
    return { kind: 'plugin', plugin: readPlugin(files, { entry: item.entry, fallbackName: item.name }), where: w };
  }
  if (!w.owner) throw new Error(`${item.name} is in another folder of the marketplace, which is not here`);
  return loadGithub({ owner: w.owner, repo: w.repo, ref: w.ref || 'HEAD', path: w.path, file: false }, deps, { entry: item.entry, cache });
}

/**
 * Unzip within the limits (fflate's unzipSync passed in): a file bigger than a skill file may be, or past 50 MB in
 * all, is not unpacked – it stays in the list as one byte that reads as binary, so the review says it was left out.
 */
export function unzipLimited(bytes, unzipSync) {
  if (bytes.length > LIMITS.zip) throw new Error('that file is too big for a plugin');
  const big = [];
  let total = 0;
  const out = unzipSync(bytes, { filter: (f) => (f.originalSize > LIMITS.file || (total += f.originalSize) > 50e6 ? (big.push(f.name), false) : true) });
  for (const n of big) out[n] = new Uint8Array([0]);
  return out;
}

/** An unpacked .zip { path: Uint8Array } → { kind: 'plugin', plugin } or { kind: 'marketplace', market, zip }. */
export function loadZip(entries) {
  const n = Object.keys(entries).length;
  if (n > 5000) throw new Error('That zip has too many files for a plugin');
  const { root, files } = zipFiles(entries);
  const paths = Object.keys(files);
  const kind = detectKind(paths);
  if (kind === 'marketplace') return { kind, market: parseMarketplace(files['.claude-plugin/marketplace.json'] ?? '{}'), zip: files };
  if (!kind) throw new Error('No Claude plugin in that zip: no .claude-plugin/plugin.json, skills/*/SKILL.md, commands/ or agents/');
  // a zip is already in memory; the same limits as a download keep the settings small
  let total = 0;
  for (const p of paths) if (typeof files[p] === 'string') (total += files[p].length) > LIMITS.total && (files[p] = null);
  return { kind, plugin: readPlugin(files, { fallbackName: root.split('/').pop() || 'plugin' }) };
}
