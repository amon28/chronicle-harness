// Tools for writing mods (offered to the Mod Builder persona, or when you switch it on in Settings).
const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const modAuthorDefs = () => [
  fn(
    'save_mod',
    'Install (or update) a Chronicle mod. The user ALWAYS sees an install screen listing the permissions and the code, and can refuse. Returns whether the mod started and what it registered, or the error – fix the code and call save_mod again. Read the chronicle-mods skill first for the API.',
    {
      id: { type: 'string', description: 'lowercase-with-hyphens' },
      name: { type: 'string' },
      version: { type: 'string', description: 'e.g. 1.0.0' },
      description: { type: 'string' },
      permissions: { type: 'array', items: { type: 'string' }, description: 'tools, commands, chat, request, storage, net:<host> – only what the mod needs' },
      code: { type: 'string', description: 'The mod code (JavaScript, no header needed – it is added for you)' },
    },
    ['id', 'name', 'description', 'permissions', 'code'],
  ),
  fn('list_mods', 'List the installed mods (id, name, version, enabled, permissions).', {}),
  fn('read_mod', 'Read the code of an installed mod, e.g. to improve it.', { id: { type: 'string' } }, ['id']),
];

export const modAuthorPrompt = () => '- You can write and install mods with save_mod (the user approves each install); read the chronicle-mods skill first. list_mods and read_mod show what is installed.';

export async function runModAuthorTool(name, args, ctx) {
  if (!ctx.mods) return null;
  if (name === 'save_mod') {
    ctx.onStatus?.('waiting for you to approve the install…');
    const r = await ctx.mods.save({ id: args.id, name: args.name, version: args.version, description: args.description, permissions: args.permissions }, String(args.code || ''));
    return { ok: r.ok, result: r.text, display: { path: String(args.name || args.id) } };
  }
  if (name === 'list_mods') {
    const l = ctx.mods.list();
    return { ok: true, result: l.length ? l.map((m) => `${m.id} · ${m.name} v${m.version} · ${m.enabled === false ? 'off' : m.running ? 'running' : m.error ? 'error: ' + m.error : 'stopped'} · permissions: ${m.permissions.join(', ') || 'none'}`).join('\n') : 'No mods installed.', display: { path: String(l.length) } };
  }
  if (name === 'read_mod') {
    const m = ctx.mods.read(String(args.id || ''));
    if (!m) throw new Error('No mod with that id');
    return { ok: true, result: m, display: { path: String(args.id) } };
  }
  return null;
}
