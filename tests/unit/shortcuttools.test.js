import { describe, it, expect } from 'vitest';
import { runShortcutTool, shortcutDefs } from '../../src/shortcuttools.js';
import { installPack, uninstallPack } from '../../src/packs.js';

const RECIPE = '---\nname: standup\ndescription: My standup\nparams: team (required)\n---\n## Gather\nList what {{team}} did.\n## Write\nWrite it up.\n';
function setup(answer = 'yes') {
  const settings = { snippets: [{ id: 's_tldr', cmd: 'tldr', title: 'TL;DR', text: 'Sum up: {{text}}' }], recipes: [], packs: [] };
  let commits = 0;
  const asked = [];
  let n = 0;
  const ctx = {
    ask: async (q, opts) => (asked.push(q), answer === 'yes' ? opts[0] : 'Not now'),
    shortcuts: {
      settings: () => settings,
      commit: () => commits++,
      install: (p) => (commits++, installPack(settings, p, { uid: () => 'u' + ++n + 'xxxxxxxx', newSkill: (x) => ({ id: 'k' + ++n, ...x }), newPersona: (x) => ({ id: 'p' + ++n, ...x }) })),
      uninstall: (id) => (commits++, uninstallPack(settings, id)),
    },
  };
  return { settings, ctx, asked, commits: () => commits };
}
const run = (ctx, args) => runShortcutTool('shortcuts', args, ctx);

describe('the shortcuts tool', () => {
  it('is one tool, and answers only its own name', async () => {
    expect(shortcutDefs().map((d) => d.function.name)).toEqual(['shortcuts']);
    expect(await runShortcutTool('memory', {}, {})).toBeNull();
  });
  it('lists and reads', async () => {
    const { ctx } = setup();
    const l = await run(ctx, { action: 'list' });
    expect(l.result).toContain('/tldr – TL;DR');
    expect(l.result).toContain('Recipes:\n(none)');
    expect((await run(ctx, { action: 'read', kind: 'snippet', name: '/tldr' })).result).toContain('Sum up: {{text}}');
  });
  it('adds a snippet after a yes, hidden characters removed; changes it in place the next time', async () => {
    const { ctx, settings, asked, commits } = setup();
    const r = await run(ctx, { action: 'save_snippet', cmd: 'standup', title: 'Standup', text: 'Write my standup​ from: {{text}}' });
    expect(r.ok).toBe(true);
    expect(asked[0]).toMatch(/^Add the snippet \/standup/);
    expect(settings.snippets.find((x) => x.cmd === 'standup').text).toBe('Write my standup from: {{text}}');
    await run(ctx, { action: 'save_snippet', cmd: 'standup', text: 'Shorter: {{text}}', send: true });
    expect(asked[1]).toMatch(/^Change the snippet/);
    expect(settings.snippets.filter((x) => x.cmd === 'standup')).toHaveLength(1);
    expect(settings.snippets.find((x) => x.cmd === 'standup')).toMatchObject({ text: 'Shorter: {{text}}', send: true });
    expect(commits()).toBe(2);
  });
  it('a no saves nothing', async () => {
    const { ctx, settings, commits } = setup('no');
    const r = await run(ctx, { action: 'save_recipe', text: RECIPE });
    expect(r.ok).toBe(false);
    expect(settings.recipes).toHaveLength(0);
    expect(commits()).toBe(0);
  });
  it('adds a recipe (its steps shown first) and refuses a broken one', async () => {
    const { ctx, settings, asked } = setup();
    await expect(run(ctx, { action: 'save_recipe', text: 'no front matter' })).rejects.toThrow(/name/);
    const r = await run(ctx, { action: 'save_recipe', text: RECIPE });
    expect(r.ok).toBe(true);
    expect(asked[0]).toContain('1. Gather');
    expect(asked[0]).toContain('Parameters: team');
    expect(settings.recipes[0].name).toBe('standup');
  });
  it('installs a pack it made, and removes it with everything in it', async () => {
    const { ctx, settings, asked } = setup();
    const pack = { id: 'my-kit', name: 'My kit', version: '1', snippets: [{ cmd: 'hi', text: 'Hello {{text}}' }], recipes: [{ text: RECIPE }], mcpServers: [{ name: 'local', command: 'node srv.js' }] };
    const r = await run(ctx, { action: 'save_pack', pack });
    expect(r.ok).toBe(true);
    expect(asked[0]).toContain('MCP servers run programs in Linux: node srv.js');
    expect(settings.snippets.some((x) => x.cmd === 'hi' && x.pack === 'my-kit')).toBe(true);
    expect(settings.mcpServers[0].enabled).toBe(false); // added switched off
    expect((await run(ctx, { action: 'read', name: 'my-kit' })).result).toContain('snippet: /hi');
    const d = await run(ctx, { action: 'delete', kind: 'pack', name: 'my-kit' });
    expect(d.ok).toBe(true);
    expect(settings.snippets.some((x) => x.cmd === 'hi')).toBe(false);
    expect(settings.packs).toHaveLength(0);
  });
  it('deletes a snippet after a yes', async () => {
    const { ctx, settings } = setup();
    await run(ctx, { action: 'delete', kind: 'snippet', name: 'tldr' });
    expect(settings.snippets).toHaveLength(0);
  });
});
