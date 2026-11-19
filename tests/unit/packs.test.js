import { describe, it, expect } from 'vitest';
import { parsePack, reviewPack, installPack, uninstallPack } from '../../src/packs.js';
import { describeEntry, serverFrom } from '../../src/mcpregistry.js';

const PACK = {
  chronicle_pack: 1,
  id: 'writing-kit',
  name: 'Writing kit',
  version: '1.0',
  snippets: [{ cmd: 'tighten', title: 'Tighten', text: 'Make this tighter:​ {{text}}' }, { cmd: 'tldr', title: 'Dup', text: 'x' }],
  recipes: [{ text: '---\nname: outline\n---\n## Outline\nOutline {{topic}}.' }],
  skills: [{ name: 'style-guide', description: 'House style', instructions: 'Use short sentences.' }],
  mcpServers: [{ name: 'time', command: 'uvx mcp-server-time' }],
  personas: [{ name: 'Editor', prompt: 'You edit text.' }],
};
let n = 0;
const deps = { uid: () => 'u' + ++n + 'xxxxxxxx', newSkill: (k) => ({ id: 'sk', enabled: true, ...k }), newPersona: (x) => ({ id: 'p' + ++n, ...x }) };

describe('packs', () => {
  it('reviews what it would install, with hidden characters and the commands it runs', () => {
    const p = parsePack(JSON.stringify(PACK));
    const r = reviewPack(p);
    expect(r.lines).toHaveLength(6);
    expect(r.hidden).toBe(1);
    expect(r.runs).toEqual(['uvx mcp-server-time']);
    expect(() => parsePack({ chronicle_pack: 1, id: 'x1' })).toThrow(/nothing/);
    expect(() => parsePack({ id: 'x' })).toThrow(/Not a Chronicle pack/);
  });
  it('installs, keeps your own things, updates and removes as one', () => {
    const settings = { snippets: [{ id: 's0', cmd: 'tldr', text: 'mine' }], recipes: [], mcpServers: [] };
    const r = installPack(settings, parsePack(PACK), deps);
    expect(r).toEqual({ added: 5, skipped: ['/tldr'] });
    expect(settings.snippets.find((s) => s.cmd === 'tighten').text).toBe('Make this tighter: {{text}}'); // hidden character gone
    expect(settings.mcpServers[0]).toMatchObject({ transport: 'stdio', enabled: false, pack: 'writing-kit' }); // added switched off
    installPack(settings, parsePack({ ...PACK, version: '1.1' }), deps); // an update: no duplicates
    expect(settings.snippets.filter((s) => s.cmd === 'tighten')).toHaveLength(1);
    expect(settings.packs).toHaveLength(1);
    expect(uninstallPack(settings, 'writing-kit')).toBe(5);
    expect(settings.snippets).toEqual([{ id: 's0', cmd: 'tldr', text: 'mine' }]);
  });
});

describe('MCP registry entries', () => {
  it('turns remotes and packages into servers to add', () => {
    const d = describeEntry({ server: { name: 'io.github.x/files', title: 'Files', remotes: [{ type: 'streamable-http', url: 'https://f.example/mcp', headers: [{ name: 'X-API-Key', isSecret: true }] }, { type: 'sse', url: 'https://old' }], packages: [{ registryType: 'npm', identifier: '@x/files', version: '1.2.0', runtimeArguments: [{ type: 'positional', value: '-y' }], packageArguments: [{ type: 'positional', value: '/data' }], environmentVariables: [{ name: 'ROOT', isRequired: true }] }, { registryType: 'oci', identifier: 'x/files' }] } });
    expect(d.publisher).toBe('io.github.x');
    expect(d.options.map((o) => o.kind)).toEqual(['remote', 'npm']);
    expect(d.options[1].command).toBe("npx -y @x/files@1.2.0 '/data'");
    expect(serverFrom(d, d.options[0], { 'X-API-Key': 'k1' }, { id: 'm1' })).toMatchObject({ url: 'https://f.example/mcp', headers: 'X-API-Key: k1' });
    expect(serverFrom(d, d.options[1], { ROOT: '/w s' }, { id: 'm2', secret: 's' }).command).toBe("ROOT='/w s' npx -y @x/files@1.2.0 '/data'");
  });
});
