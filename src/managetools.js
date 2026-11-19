// Tools that let the agent look after what the user has saved, not only add to it:
//   memory       – list / add / edit / forget the user's memories (what assistants remember about them)
//   saved_tools  – list / read / delete / switch off the reusable Python tools made with save_tool
//   manage_mod   – switch a mod on or off, or remove it (asks first)
//   read_lorebook – list lorebooks, or read one (also those not attached to a character)
import { GLOBAL, newMemory } from './memory.js';

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const manageDefs = (enabled) => [
  fn(
    'memory',
    "The user's memories – the facts assistants remember about them across chats (shown to you in the Memories block). action list: with ids – by default the shared ones and this persona's own (scope all: every persona's too), 50 at a time (offset for more); add: remember something new (a near-duplicate is refused – edit that one instead); edit: correct one; forget: remove one. Only change memories when the user asks, or to fix one that is clearly wrong or outdated. Don't save momentary state (which network the phone is on, where it is now): check it with the phone tools when it matters.",
    {
      action: { type: 'string', enum: ['list', 'add', 'edit', 'forget'] },
      text: { type: 'string', description: 'add / edit: the memory, one short fact in the third person or first person as the others are' },
      id: { type: 'string', description: 'edit / forget: the memory id from list' },
      scope: { type: 'string', enum: ['everyone', 'this_persona', 'all'], description: 'add: shared by every assistant (everyone, the default) or only this persona. list: everyone + this persona (default), this_persona, everyone, or all (every persona\'s)' },
      query: { type: 'string', description: 'list: only memories containing this' },
      limit: { type: 'number', description: 'list: how many (default 50, at most 200)' },
      offset: { type: 'number', description: 'list: skip this many (for the next page)' },
      force: { type: 'boolean', description: 'add: add it although a similar memory exists (only when they really say different things)' },
    },
    ['action'],
  ),
  ...(enabled.python
    ? [
        fn(
          'saved_tools',
          "The reusable Python tools saved with save_tool (callable as tool_<name>). action list: names, descriptions, on/off; read: one tool's code and parameters; delete: remove it; disable / enable: switch it off or on without deleting. To change a tool's code, call save_tool again with the same name.",
          { action: { type: 'string', enum: ['list', 'read', 'delete', 'disable', 'enable'] }, name: { type: 'string', description: 'The tool name (without tool_)' } },
          ['action'],
        ),
      ]
    : []),
  fn('manage_mod', 'Switch an installed mod on or off, or remove it (the user is asked first). See list_mods for ids.', { id: { type: 'string' }, action: { type: 'string', enum: ['enable', 'disable', 'remove'] } }, ['id', 'action']),
  fn('read_lorebook', 'Without a name: list every lorebook (name, entries, which character uses it). With a name (or the character it belongs to): its entries in full. Change one with edit_lorebook.', { name: { type: 'string' } }),
];

/** Two memories that say nearly the same: most of their words (3+ letters) are shared. Exported for testing. */
export function nearDuplicate(a, b) {
  // words of 3+ letters, a plural or -ing/-ed ending dropped so "updating" and "update" meet
  const stem = (w) => w.replace(/(ing|ed|es|s)$/, '').replace(/e$/, '');
  const words = (t) => new Set((String(t).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).map(stem));
  const x = words(a);
  const y = words(b);
  if (x.size < 3 || y.size < 3) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  // reworded still counts ("Amon fixed the black screen with a router update" / "…by updating the router"): most of
  // the shorter one's words in the other, and half of the longer one's
  return both / Math.min(x.size, y.size) >= 0.7 && both / Math.max(x.size, y.size) >= 0.5;
}

const scopeLabel = (m, personaName) => ((m.scope || GLOBAL) === GLOBAL ? 'everyone' : personaName(m.scope) || m.scope);

/** → { ok, result, display } or null when the name is not ours. ctx.settings, ctx.save(), ctx.personaId, ctx.personaName(id), ctx.ask, ctx.mods */
export async function runManageTool(name, args, ctx) {
  const s = ctx.settings;
  if (name === 'memory') {
    const list = (s.memories ||= []);
    const pn = ctx.personaName || (() => '');
    const a = String(args.action || 'list');
    if (a === 'list') {
      const q = String(args.query || '').toLowerCase();
      // another persona's memories are its own: shown only when asked for (scope all)
      const view = ['all', 'everyone', 'this_persona'].includes(args.scope) ? args.scope : 'mine';
      const inView = (m) => {
        const sc = m.scope || GLOBAL;
        if (view === 'all') return true;
        if (view === 'everyone') return sc === GLOBAL;
        if (view === 'this_persona') return !!ctx.personaId && sc === ctx.personaId;
        return sc === GLOBAL || (!!ctx.personaId && sc === ctx.personaId);
      };
      const all = list.filter((m) => inView(m) && (!q || String(m.text).toLowerCase().includes(q)));
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
      const offset = Math.max(0, Number(args.offset) || 0);
      const rows = all.slice(offset, offset + limit);
      const others = view === 'mine' ? list.length - list.filter(inView).length : 0;
      const line = (m) => `${m.id} [${scopeLabel(m, pn)}${m.pinned ? ', pinned' : ''}${m.updatedAt || m.createdAt ? ', noted ' + new Date(m.updatedAt || m.createdAt).toISOString().slice(0, 10) : ''}] ${m.text}`;
      const more = offset + rows.length < all.length ? `\n… ${all.length - offset - rows.length} more – list again with offset ${offset + rows.length}.` : '';
      const note = others ? `\n(${others} memories of other personas are not shown – scope all lists them.)` : '';
      const head = all.length > rows.length ? `Memories ${offset + 1}–${offset + rows.length} of ${all.length}:\n` : '';
      return { ok: true, result: rows.length ? head + rows.map(line).join('\n') + more + note : (q ? `No memory contains "${args.query}".` : offset && all.length ? `Nothing after ${offset} – there are ${all.length}.` : 'There are no memories here yet.') + note, display: { path: 'memories', count: rows.length } };
    }
    if (a === 'add') {
      const t = String(args.text || '').trim();
      if (!t) throw new Error('text is required');
      if (list.some((m) => String(m.text).trim().toLowerCase() === t.toLowerCase())) return { ok: true, result: 'That memory is already there.', display: { path: t.slice(0, 60) } };
      const twin = !args.force && list.find((m) => nearDuplicate(m.text, t));
      if (twin) return { ok: false, result: `Not added: it is nearly the same as ${twin.id} ("${twin.text}"). If that one changed, edit it (action edit, id ${twin.id}); if they really say different things, add again with force: true.`, display: { error: 'near-duplicate' } };
      const m = newMemory(t, args.scope === 'this_persona' && ctx.personaId ? ctx.personaId : GLOBAL);
      m.source = 'assistant';
      list.push(m);
      ctx.save();
      return { ok: true, result: `Remembered (${m.id}, ${scopeLabel(m, pn)}): ${m.text}`, display: { path: m.text.slice(0, 60) } };
    }
    const m = list.find((x) => x.id === args.id);
    if (!m) throw new Error(`No memory with id ${args.id} – call memory with action list`);
    if (a === 'edit') {
      const t = String(args.text || '').trim();
      if (!t) throw new Error('text is required');
      const before = m.text;
      m.text = t.slice(0, 300);
      m.updatedAt = Date.now();
      ctx.save();
      return { ok: true, result: `Changed ${m.id}: "${before}" → "${m.text}"`, display: { path: m.text.slice(0, 60) } };
    }
    if (a === 'forget') {
      s.memories = list.filter((x) => x !== m);
      ctx.save();
      return { ok: true, result: `Forgot: ${m.text}`, display: { path: m.text.slice(0, 60) } };
    }
    throw new Error(`Unknown action ${a}`);
  }
  if (name === 'saved_tools') {
    const list = (s.skills ||= []);
    const a = String(args.action || 'list');
    if (a === 'list') return { ok: true, result: list.length ? list.map((k) => `tool_${k.name}${k.enabled === false ? ' (off)' : ''}: ${k.description}`).join('\n') : 'No saved tools yet.', display: { path: 'saved tools', count: list.length } };
    const n = String(args.name || '').replace(/^tool_/, '');
    const k = list.find((x) => x.name === n);
    if (!k) throw new Error(`No saved tool "${n}". Saved: ${list.map((x) => x.name).join(', ') || 'none'}`);
    if (a === 'read') return { ok: true, result: `tool_${k.name}${k.enabled === false ? ' (off)' : ''}\n${k.description}\nParameters: ${JSON.stringify(k.parameters || {})}\n\n${k.code || ''}`, display: { path: k.name } };
    if (a === 'delete') {
      s.skills = list.filter((x) => x !== k);
      ctx.save();
      return { ok: true, result: `Deleted the saved tool ${k.name}.`, display: { path: k.name } };
    }
    if (a === 'disable' || a === 'enable') {
      k.enabled = a === 'enable';
      ctx.save();
      return { ok: true, result: `${k.name} is now ${a === 'enable' ? 'on' : 'off'}.`, display: { path: k.name } };
    }
    throw new Error(`Unknown action ${a}`);
  }
  if (name === 'manage_mod') {
    const rec = (s.mods || []).find((r) => r.id === args.id || r.name === args.id);
    if (!rec) throw new Error(`No mod "${args.id}" – call list_mods`);
    const a = String(args.action || '');
    if (a === 'remove' || a === 'disable' || a === 'enable') {
      if (a === 'remove' && ctx.ask) {
        const ans = await ctx.ask(`Remove the mod “${rec.name}” and its saved data?`, ['Remove it', 'Keep it']);
        if (!/^remove/i.test(String(ans))) return { ok: false, result: `The user kept the mod (${ans}).`, display: { error: 'kept' } };
      }
      await ctx.mods[a](rec.id);
      return { ok: true, result: `${rec.name}: ${a === 'remove' ? 'removed' : a === 'enable' ? 'switched on' : 'switched off'}.`, display: { path: rec.name } };
    }
    throw new Error(`Unknown action ${a}`);
  }
  if (name === 'read_lorebook') {
    const books = s.lorebooks || [];
    const users = (id) => (s.personas || []).filter((p) => p.lorebookId === id).map((p) => p.name);
    if (!args.name) {
      const count = {};
      for (const b of books) count[String(b.name).toLowerCase()] = (count[String(b.name).toLowerCase()] || 0) + 1;
      const sig = (b) => JSON.stringify((b.entries || []).map((e) => [e.keys, e.content]));
      const line = (b) => {
        const u = users(b.id);
        const dup = count[String(b.name).toLowerCase()] > 1;
        const twin = dup && books.some((o) => o !== b && String(o.name).toLowerCase() === String(b.name).toLowerCase() && sig(o) === sig(b));
        return `${b.name} – ${(b.entries || []).length} entries${u.length ? ` · used by ${u.join(', ')}` : ' · not attached to anyone'}${dup ? ` · id ${b.id}${twin ? ' · same content as another copy' : ''}` : ''}`;
      };
      const dups = Object.values(count).filter((n) => n > 1).length;
      const note = dups ? `\n\n${dups} name${dups === 1 ? ' is' : 's are'} used by more than one lorebook (left over from importing the same card again). Read or edit one of them by its id; an unattached copy with the same content can be deleted with edit_lorebook (delete: true) after asking the user.` : '';
      return { ok: true, result: books.length ? books.map(line).join('\n') + note : 'There are no lorebooks yet.', display: { path: 'lorebooks', count: books.length } };
    }
    const q = String(args.name).toLowerCase();
    const b = books.find((x) => String(x.id).toLowerCase() === q) || books.find((x) => String(x.name).toLowerCase() === q) || books.find((x) => x.id === (s.personas || []).find((p) => p.name.toLowerCase() === q)?.lorebookId);
    if (!b) throw new Error(`No lorebook "${args.name}" – call read_lorebook without a name to list them`);
    const body = (b.entries || []).map((e, i) => `${i + 1}. ${e.name || (e.keys || [])[0] || '(no name)'}${e.enabled === false ? ' (off)' : ''}${e.constant ? ' (always on)' : ''} – keys: ${(e.keys || []).join(', ') || '–'}${e.sticky || e.cooldown || e.delay ? ` – sticky ${e.sticky || 0}, cooldown ${e.cooldown || 0}, delay ${e.delay || 0}` : ''}\n${e.content}`).join('\n\n');
    return { ok: true, result: `Lorebook “${b.name}” (${(b.entries || []).length} entries${users(b.id).length ? `, used by ${users(b.id).join(', ')}` : ''}):\n\n${body}`.slice(0, 40000), display: { path: b.name } };
  }
  return null;
}
