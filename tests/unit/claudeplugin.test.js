import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { unzipLimited, frontMatter, parseGithubUrl, readPlugin, pluginToPack, loadZip, loadGithub, loadMarketEntry, parseMarketplace, pluginSource, githubHeaders, LIMITS } from '../../src/claudeplugin.js';
import { parsePack, reviewPack, installPack, uninstallPack } from '../../src/packs.js';

// a small plugin with every part: manifest, 2 skills (one with a script and a binary file), a command, two MCP
// servers (http + stdio), an agent and hooks
const PLUGIN = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'design', version: '1.2.0', description: 'Design work', author: { name: 'Anthropic' }, license: 'Apache-2.0' }),
  'skills/design-critique/SKILL.md': '---\nname: design-critique\ndescription: >\n  Structured design feedback.\n  Use when asked to critique a design.\nlicense: Apache-2.0\n---\n# Critique\nRun `${CLAUDE_SKILL_DIR}/scripts/check.sh` first.\n',
  'skills/design-critique/scripts/check.sh': '#!/bin/sh\necho ok\n',
  'skills/design-critique/logo.png': null, // binary
  'skills/ux-writing/SKILL.md': '---\nname: ux-writing\ndescription: "Write UX copy"\n---\nShort, clear words. See [connectors](../../CONNECTORS.md).',
  'skills/ux-writing/reference/tone.md': 'Friendly.',
  'commands/critique.md': '---\ndescription: Critique a design\nargument-hint: [file]\nallowed-tools: Read\n---\nCritique this: $ARGUMENTS',
  'commands/README.md': 'not a command',
  '.mcp.json': JSON.stringify({ mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' }, gcal: { type: 'http', url: '' }, files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/root'], env: { DEBUG: '1', TOKEN: '${MY_TOKEN}' } }, local: { command: '${CLAUDE_PLUGIN_ROOT}/bin/server' } } }),
  'agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews designs\ntools: Read, Grep\nmodel: sonnet\n---\nYou review designs carefully.',
  'hooks/hooks.json': JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/fmt.sh' }] }] } }),
  'README.md': '# Design',
};
const enc = (files, prefix = '') => Object.fromEntries(Object.entries(files).map(([p, v]) => [prefix + p, v == null ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) : strToU8(v)]));
const unzip = async (bytes) => (await import('fflate')).unzipSync(bytes);

describe('front matter', () => {
  it('reads folded blocks, quotes and lists', () => {
    const { meta, body } = frontMatter('---\nname: x\ndescription: >\n  one\n  two\ntools:\n  - Read\n  - Grep\nq: "quoted: yes"\n---\nBody');
    expect(meta).toEqual({ name: 'x', description: 'one two', tools: 'Read, Grep', q: 'quoted: yes' });
    expect(body).toBe('Body');
    expect(frontMatter('no front matter').body).toBe('no front matter');
  });
});

describe('reading a plugin', () => {
  it('finds every part', () => {
    const pl = readPlugin(PLUGIN);
    expect(pl.manifest).toMatchObject({ name: 'design', version: '1.2.0', author: 'Anthropic', license: 'Apache-2.0' });
    expect(pl.skills.map((s) => s.name)).toEqual(['design-critique', 'ux-writing']);
    expect(pl.skills[0].description).toBe('Structured design feedback. Use when asked to critique a design.');
    expect(pl.skills[0].files).toEqual({ 'scripts/check.sh': '#!/bin/sh\necho ok\n' });
    expect(pl.skills[0].left).toEqual(['logo.png']);
    expect(pl.skills[1].files).toEqual({ 'reference/tone.md': 'Friendly.' });
    expect(pl.commands).toEqual([{ name: 'critique', description: 'Critique a design', argHint: '[file]', text: 'Critique this: $ARGUMENTS' }]);
    expect(pl.agents).toEqual([{ name: 'reviewer', description: 'Reviews designs', prompt: 'You review designs carefully.', tools: 'Read, Grep', model: 'sonnet' }]);
    expect(pl.mcp.map((m) => [m.name, m.type])).toEqual([['figma', 'http'], ['gcal', 'http'], ['files', 'stdio'], ['local', 'stdio']]);
    expect(pl.hooks).toEqual([{ event: 'PostToolUse', matcher: 'Write|Edit', type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/fmt.sh' }]);
  });

  it('follows the manifest: extra skill folders, a command map, listed agents, inline MCP servers', () => {
    const pl = readPlugin({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'x-tools', skills: ['./extra'], commands: { hi: { content: 'Say hi to $ARGUMENTS', description: 'Greets' } }, agents: ['./people/helper.md'], mcpServers: { api: { url: 'https://api.example.com/mcp' } } }),
      'extra/one/SKILL.md': '---\nname: one\ndescription: One\n---\nDo one.',
      'skills/two/SKILL.md': '---\ndescription: Two\n---\nDo two.',
      'commands/ignored.md': 'the manifest replaced commands/',
      'people/helper.md': 'Help.',
    });
    expect(pl.skills.map((s) => s.name).sort()).toEqual(['one', 'two']);
    expect(pl.commands.map((c) => c.name)).toEqual(['hi']);
    expect(pl.agents.map((a) => a.name)).toEqual(['helper']);
    expect(pl.mcp).toHaveLength(1);
  });

  it('a folder with only SKILL.md is one skill; a marketplace entry may pick the skills', () => {
    expect(readPlugin({ 'SKILL.md': '---\nname: solo\ndescription: S\n---\nGo.', 'ref.md': 'r' }).skills).toMatchObject([{ name: 'solo', files: { 'ref.md': 'r' } }]);
    const files = { 'skills/a/SKILL.md': '---\nname: aa\ndescription: A\n---\na', 'skills/b/SKILL.md': '---\nname: bb\ndescription: B\n---\nb', 'skills/x/SKILL.md': '---\nname: x\n---\nshort name' };
    const pl = readPlugin(files, { entry: { name: 'just-b', strict: false, skills: ['./skills/b'] } });
    expect(pl.manifest.name).toBe('just-b');
    expect(pl.skills.map((s) => s.name)).toEqual(['bb']);
    expect(readPlugin(files).skills.map((s) => s.name)).toEqual(['aa', 'bb']); // "x" is too short a name: skipped
    expect(readPlugin(files).problems).toEqual(['skill in skills/x: no usable name']);
  });
});

describe('a plugin → a pack (the preview model)', () => {
  it('maps skills, commands, agents and servers; lists what is left out and why', () => {
    const { pack, skipped, notes, license } = pluginToPack(readPlugin(PLUGIN), { shell: false });
    const p = parsePack(pack); // the pack checker accepts it
    expect(p).toMatchObject({ id: 'design', name: 'Design', version: '1.2.0', author: 'Anthropic' });
    expect(license).toBe('Apache-2.0');
    expect(p.skills.map((k) => k.name)).toEqual(['design-critique', 'ux-writing']);
    expect(p.skills[0].instructions).toContain('/workspace/skills/design-critique/scripts/check.sh');
    expect(p.snippets).toEqual([{ cmd: 'critique', title: 'Critique a design', text: 'Critique this: {{text}}', send: false }]);
    expect(p.personas).toEqual([{ name: 'reviewer', description: 'Reviews designs', prompt: 'You review designs carefully.' }]);
    expect(p.mcpServers).toEqual([{ name: 'figma', url: 'https://mcp.figma.com/mcp' }]); // no Linux here: no stdio
    const why = skipped.map((s) => `${s.what}: ${s.why}`).join('\n');
    expect(why).toMatch(/design-critique: 1 file \(logo\.png\)/);
    expect(why).toMatch(/MCP server gcal: it has no address/);
    expect(why).toMatch(/MCP server files \(npx\): it runs a program; that needs the built-in Linux/);
    expect(why).toMatch(/1 hook \(PostToolUse\): hooks run commands on a computer/);
    expect(notes.join('\n')).toMatch(/agent becomes a chat persona/);
    expect(notes.join('\n')).toMatch(/ux-writing links to files outside its folder/);
    const r = reviewPack(p);
    expect(r.lines).toHaveLength(2 + 1 + 1 + 1);
  });

  it('with the built-in Linux: a stdio server becomes a command (secrets left for you), one from the plugin folder does not', () => {
    const { pack, skipped, notes } = pluginToPack(readPlugin(PLUGIN), { shell: true });
    expect(pack.mcpServers).toContainEqual({ name: 'files', command: 'DEBUG=1 npx -y @modelcontextprotocol/server-filesystem /root' });
    expect(notes.join('\n')).toMatch(/files needs TOKEN/);
    expect(skipped.map((s) => s.what + ' ' + s.why).join('\n')).toMatch(/local .*plugin folder/);
    expect(reviewPack(parsePack(pack)).runs).toEqual(['DEBUG=1 npx -y @modelcontextprotocol/server-filesystem /root']);
  });

  it('installs as one pack: grouped by pack id, your own skill of the same name is kept, removed together', () => {
    let n = 0;
    const deps = { uid: () => 'u' + ++n + 'xxxxxxxx', newSkill: (k) => ({ id: 'sk' + ++n, enabled: true, ...k }), newPersona: (x) => ({ id: 'p' + ++n, ...x }) };
    const settings = { agentSkills: [{ name: 'ux-writing', instructions: 'mine' }], snippets: [], mcpServers: [] };
    const p = parsePack(pluginToPack(readPlugin(PLUGIN)).pack);
    const r = installPack(settings, p, deps);
    expect(r.skipped).toEqual(['ux-writing']);
    expect(settings.agentSkills.filter((k) => k.pack === 'design').map((k) => k.name)).toEqual(['design-critique']);
    expect(settings.agentSkills.find((k) => k.pack === 'design').files['scripts/check.sh']).toContain('echo ok');
    expect(settings.snippets[0]).toMatchObject({ cmd: 'critique', pack: 'design' });
    expect(settings.mcpServers[0]).toMatchObject({ url: 'https://mcp.figma.com/mcp', enabled: false });
    expect(uninstallPack(settings, 'design')).toBe(4);
    expect(settings.agentSkills).toEqual([{ name: 'ux-writing', instructions: 'mine' }]);
  });
});

describe('inputs', () => {
  it('a .zip of the plugin folder or of its contents', async () => {
    for (const prefix of ['design/', '']) {
      const res = loadZip(await unzip(zipSync({ ...enc(PLUGIN, prefix), '__MACOSX/._x': strToU8('junk') })));
      expect(res.kind).toBe('plugin');
      expect(res.plugin.skills).toHaveLength(2);
      expect(res.plugin.skills[0].left).toEqual(['logo.png']); // binary: left out
    }
    // no plugin.json, one folder of skills
    const res = loadZip(await unzip(zipSync(enc({ 'skills/a/SKILL.md': '---\nname: aa\ndescription: A\n---\nx' }, 'kit/'))));
    expect(res.plugin.manifest.name).toBe('kit');
    expect(() => loadZip(asEntries({ 'notes.txt': 'hi' }))).toThrow(/No Claude plugin/);
  });

  it('a zip is unpacked within the limits: a too-big file is listed as left out, not unpacked', async () => {
    const { unzipSync } = await import('fflate');
    const bytes = zipSync(enc({ ...PLUGIN, 'skills/ux-writing/big.md': 'x'.repeat(LIMITS.file + 1) }));
    const res = loadZip(unzipLimited(bytes, unzipSync));
    expect(res.plugin.skills[1].left).toEqual(['big.md']);
    expect(res.plugin.skills[1].files).toEqual({ 'reference/tone.md': 'Friendly.' });
    expect(() => unzipLimited(new Uint8Array(LIMITS.zip + 1), unzipSync)).toThrow(/too big/);
  });

  it('a zipped marketplace: pick one of its plugins', async () => {
    const files = { '.claude-plugin/marketplace.json': JSON.stringify({ name: 'm', owner: { name: 'O' }, plugins: [{ name: 'design', source: './plugins/design' }, { name: 'far', source: { source: 'npm', package: 'x' } }] }), ...Object.fromEntries(Object.entries(PLUGIN).map(([p, v]) => ['plugins/design/' + p, v])) };
    const res = loadZip(await unzip(zipSync(enc(files, 'mk/'))));
    expect(res.kind).toBe('marketplace');
    expect(res.market.plugins.map((x) => x.where.kind)).toEqual(['here', 'none']);
    const one = await loadMarketEntry(res.market.plugins[0], {}, { zip: res.zip });
    expect(one.plugin.skills).toHaveLength(2);
    await expect(loadMarketEntry(res.market.plugins[1], {}, { zip: res.zip })).rejects.toThrow(/npm/);
  });

  it('GitHub links', () => {
    expect(parseGithubUrl('https://github.com/anthropics/knowledge-work-plugins/tree/main/design')).toEqual({ owner: 'anthropics', repo: 'knowledge-work-plugins', ref: 'main', path: 'design', file: false });
    expect(parseGithubUrl('https://github.com/o/r')).toEqual({ owner: 'o', repo: 'r', ref: 'HEAD', path: '', file: false });
    expect(parseGithubUrl('https://github.com/o/r.git')).toMatchObject({ repo: 'r' });
    expect(parseGithubUrl('o/r')).toMatchObject({ owner: 'o', repo: 'r' });
    expect(parseGithubUrl('https://github.com/o/r/blob/v1/.claude-plugin/marketplace.json')).toMatchObject({ ref: 'v1', path: '.claude-plugin/marketplace.json', file: true });
    expect(parseGithubUrl('https://raw.githubusercontent.com/o/r/main/a/b.json')).toMatchObject({ ref: 'main', path: 'a/b.json', file: true });
    expect(parseGithubUrl('https://gitlab.com/o/r')).toBeNull();
  });

  it('marketplace sources', () => {
    const at = { owner: 'o', repo: 'r', ref: 'main' };
    expect(pluginSource('./plugins/x', at)).toEqual({ kind: 'here', path: 'plugins/x', owner: 'o', repo: 'r', ref: 'main' });
    expect(pluginSource('x', { ...at, pluginRoot: 'plugins' }).path).toBe('plugins/x');
    expect(pluginSource('./../up', at).kind).toBe('none');
    expect(pluginSource({ source: 'github', repo: 'a/b', ref: 'v2' })).toEqual({ kind: 'github', owner: 'a', repo: 'b', ref: 'v2', path: '' });
    expect(pluginSource({ source: 'git-subdir', url: 'https://github.com/a/mono.git', path: 'tools/p' })).toMatchObject({ owner: 'a', repo: 'mono', path: 'tools/p' });
    expect(pluginSource({ source: 'url', url: 'https://gitlab.com/a/b.git' })).toMatchObject({ kind: 'none', why: 'it is not on GitHub' });
    expect(pluginSource({ source: 'archive', url: 'https://x/y.zip' }).kind).toBe('none');
    expect(parseMarketplace({ name: 'm', plugins: [{ name: 'a', source: './a' }, { nope: 1 }] }).plugins).toHaveLength(1);
  });

  it('the token goes to GitHub only', () => {
    expect(githubHeaders('https://api.github.com/repos/o/r', 'tok').Authorization).toBe('Bearer tok');
    expect(githubHeaders('https://raw.githubusercontent.com/o/r/HEAD/x', 'tok').Authorization).toBe('Bearer tok');
    expect(githubHeaders('https://evil.example.com/x', 'tok').Authorization).toBeUndefined();
    expect(githubHeaders('https://api.github.com/x', '').Authorization).toBeUndefined();
  });
});

// a fake GitHub: one tree call for the repo, raw files by path
function fakeGithub(repos) {
  const calls = [];
  const http = async (url, headers) => {
    calls.push({ url, auth: headers.Authorization || '' });
    let m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^?]+)\?recursive=1$/.exec(url);
    if (m) {
      const files = repos[`${m[1]}/${m[2]}`];
      if (!files) return { status: 404, body: '{}' };
      return { status: 200, body: JSON.stringify({ tree: Object.entries(files).map(([path, v]) => ({ path, type: 'blob', size: typeof v === 'number' ? v : (v ?? 'xxxx').length })) }) };
    }
    m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url);
    if (m) {
      const v = repos[`${m[1]}/${m[2]}`]?.[decodeURIComponent(m[4])];
      return typeof v === 'string' ? { status: 200, body: v } : { status: 404, body: '' };
    }
    return { status: 500, body: '' };
  };
  return { http, calls };
}

describe('from GitHub (mocked)', () => {
  const inFolder = (files, dir) => Object.fromEntries(Object.entries(files).map(([p, v]) => [dir + p, v]));

  it('a plugin in a subfolder: one tree call, only that folder’s component files are fetched', async () => {
    const big = 'x'.repeat(10);
    const { http, calls } = fakeGithub({ 'anthropics/kwp': { ...inFolder(PLUGIN, 'design/'), 'design/skills/ux-writing/huge.md': LIMITS.file + 1, 'sales/skills/s/SKILL.md': big, 'design/docs/notes.md': big } });
    const res = await loadGithub('https://github.com/anthropics/kwp/tree/main/design', { http, token: 'tok' });
    expect(res.kind).toBe('plugin');
    expect(res.plugin.skills.map((s) => s.name)).toEqual(['design-critique', 'ux-writing']);
    expect(res.plugin.skills[1].left).toContain('huge.md'); // over the size limit: not fetched
    expect(calls.filter((c) => c.url.includes('/git/trees/'))).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('/sales/') || c.url.includes('/docs/') || c.url.includes('huge.md') || c.url.includes('logo.png'))).toBe(false);
    expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
    expect(calls.every((c) => /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(c.url))).toBe(true);
  });

  it('a marketplace repo: list, then import a relative entry, a github entry and a skills-only entry', async () => {
    const market = { name: 'mk', owner: { name: 'O' }, plugins: [{ name: 'design', source: './plugins/design', description: 'D' }, { name: 'ext', source: { source: 'github', repo: 'other/ext' } }, { name: 'docs', source: './', strict: false, skills: ['./skills/pdf'] }] };
    const { http } = fakeGithub({
      'o/mk': { '.claude-plugin/marketplace.json': JSON.stringify(market), ...inFolder(PLUGIN, 'plugins/design/'), 'skills/pdf/SKILL.md': '---\nname: pdf\ndescription: PDFs\n---\nUse pypdf.', 'skills/other/SKILL.md': '---\nname: other\ndescription: O\n---\nx' },
      'other/ext': { 'commands/hello.md': 'Say hello to $ARGUMENTS' },
    });
    const deps = { http };
    const res = await loadGithub('https://github.com/o/mk', deps);
    expect(res.kind).toBe('marketplace');
    expect(res.market.plugins.map((p) => p.name)).toEqual(['design', 'ext', 'docs']);
    const a = await loadMarketEntry(res.market.plugins[0], deps, { cache: res.cache });
    expect(a.plugin.skills).toHaveLength(2);
    const b = await loadMarketEntry(res.market.plugins[1], deps, { cache: res.cache });
    expect(pluginToPack(b.plugin).pack.snippets[0].text).toBe('Say hello to {{text}}');
    const c = await loadMarketEntry(res.market.plugins[2], deps, { cache: res.cache });
    expect(c.plugin.skills.map((s) => s.name)).toEqual(['pdf']);
    // a link to the marketplace.json file opens the same list
    expect((await loadGithub('https://github.com/o/mk/blob/main/.claude-plugin/marketplace.json', deps)).kind).toBe('marketplace');
  });

  it('says why when there is nothing to import', async () => {
    const { http } = fakeGithub({ 'o/r': { 'README.md': '# hi' } });
    await expect(loadGithub('https://github.com/o/r', { http })).rejects.toThrow(/No Claude plugin there/);
    await expect(loadGithub('https://github.com/o/missing', { http })).rejects.toThrow(/GitHub has no o\/missing/);
    await expect(loadGithub('https://github.com/o/r/blob/main/README.md', { http })).rejects.toThrow(/Link the plugin/);
  });
});

function asEntries(files) {
  // already unpacked: path → bytes
  return Object.fromEntries(Object.entries(files).map(([p, v]) => [p, strToU8(v)]));
}
