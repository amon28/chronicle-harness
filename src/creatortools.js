import { TOOL_GROUPS } from './toolset.js';
import { planPersonaEdit, planLoreEdit, CARD_FIELDS, PERSONA_FIELDS } from './editpersona.js';
import { newEntry } from './lore.js';
// Tools that let the assistant make things for you: a chat persona, a lorebook, or a full roleplay character (card with
// its own lorebook). Every one asks you first and nothing is added without a yes.
const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

const IMAGE_ARG = { type: 'integer', description: 'Optional: use a picture the user sent in this chat as the picture of what you create. 1 = the most recent image they sent, 2 = the one before it, and so on. Use it when the user sent a reference image for the look.' };

const GROUPS = TOOL_GROUPS.map(([k]) => k);
const TOOLS_ARGS = {
  tools: { type: 'boolean', description: 'Tools on (true) or off (false) when a chat with it starts. Leave out to use the app default (for a change: to keep it as it is).' },
  toolset: {
    type: 'array',
    items: { type: 'string', enum: GROUPS },
    description: 'Only these tool groups are given to it (the others are never sent – a smaller prompt). Leave out for all (for a change: keep as it is). Fit it to the job, e.g. a roleplay or writing persona: [] or ["web"]; research: ["web","files","delegate"]; coding: ["web","python","files","shell","preview","delegate","skills","autonomy","mcp"]. Groups: ' + TOOL_GROUPS.map(([k, l]) => `${k} = ${l.replace(/^\S+\s/, '')}`).join('; '),
  },
  add_tools: { type: 'array', items: { type: 'string' }, description: 'Single tools it gets although their group is not in toolset, by tool name (e.g. a writing persona with no groups that still keeps notes: ["memory"]; one that reads the calendar: ["calendar"]). Give the whole list – it replaces the one before; [] clears it. Leave out to keep it as it is.' },
  remove_tools: { type: 'array', items: { type: 'string' }, description: 'Single tools taken away although their group is on, by tool name (e.g. web on but no screenshot_page: ["screenshot_page"]). The whole list; [] clears it. Leave out to keep it as it is.' },
};
const TOOL_NAME = /^[a-z][a-z0-9_]{1,60}$/;
const names = (x) => (Array.isArray(x) ? [...new Set(x.map(String).filter((n) => TOOL_NAME.test(n)))] : null);
/** add_tools / remove_tools → the persona's single-tool picks; undefined = keep them as they are, null = clear them. */
export function picksArg(a) {
  const on = names(a.add_tools);
  const off = names(a.remove_tools);
  if (!on && !off) return undefined;
  const p = { ...(on?.length ? { on } : {}), ...(off?.length ? { off: off.filter((n) => !on?.includes(n)) } : {}) };
  if (p.off && !p.off.length) delete p.off;
  return p.on || p.off ? { ...p, keepOn: !on, keepOff: !off } : { keepOn: !on, keepOff: !off };
}
const toolsNote = (a) =>
  [a.tools === false ? 'tools off' : a.tools === true ? 'tools on' : '', Array.isArray(a.toolset) ? `tools: ${a.toolset.length ? a.toolset.join(', ') : 'none'}` : '', names(a.add_tools) ? `single tools given: ${names(a.add_tools).join(', ') || 'none'}` : '', names(a.remove_tools) ? `single tools taken away: ${names(a.remove_tools).join(', ') || 'none'}` : ''].filter(Boolean).join(', ');

const EDIT_LIST = { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_text', 'new_text'] } };
export const creatorDefs = () => [
  fn(
    'edit_persona',
    `Change part of an existing chat persona or roleplay character – the rest stays exactly as it is. Use this (not save_persona / save_character) to adjust something: a detail in the description, the tone of the prompt, one more greeting, the tools. Call read_persona first to see the current text. "edits" are exact text replacements inside one field (old_text must match exactly, like edit_file); "set" replaces whole fields. Fields – chat persona: ${PERSONA_FIELDS.join(', ')}; character: ${CARD_FIELDS.join(', ')}. The user approves the change first.`,
    {
      persona: { type: 'string', description: 'Name or id (from list_personas)' },
      edits: { ...EDIT_LIST, description: 'Exact replacements: [{field, old_text, new_text}] – field defaults to prompt (persona) or description (character)' },
      set: { type: 'object', description: 'Whole fields to replace, e.g. {"scenario": "…", "tags": ["fantasy"]}' },
      add_greetings: { type: 'array', items: { type: 'string' }, description: 'Character: extra greetings to add' },
      remove_greetings: { type: 'array', items: { type: 'integer' }, description: 'Character: numbers (1-based) of extra greetings to remove' },
      delete: { type: 'boolean', description: 'Delete this persona or character entirely (with its memories; asks first). Built-ins cannot be deleted.' },
      ...TOOLS_ARGS,
    },
    ['persona'],
  ),
  fn(
    'edit_lorebook',
    'Change entries of an existing lorebook (by its name, or the name of the character it belongs to) without rewriting it: add new entries, update some (by their name or one of their keys – new keys, new content, exact text edits inside the content, timing), or remove some. The user approves first.',
    {
      lorebook: { type: 'string', description: 'Lorebook name, or the character/persona it is attached to' },
      add: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } }, content: { type: 'string' }, constant: { type: 'boolean' }, sticky: { type: 'integer' }, cooldown: { type: 'integer' }, delay: { type: 'integer' } }, required: ['content'] } },
      update: { type: 'array', items: { type: 'object', properties: { entry: { type: 'string', description: 'Its name or one of its keys' }, keys: { type: 'array', items: { type: 'string' } }, content: { type: 'string' }, edits: EDIT_LIST, constant: { type: 'boolean' }, enabled: { type: 'boolean' }, sticky: { type: 'integer' }, cooldown: { type: 'integer' }, delay: { type: 'integer' } }, required: ['entry'] } },
      remove: { type: 'array', items: { type: 'string' }, description: 'Entries to delete (name or key)' },
      delete: { type: 'boolean', description: 'Delete the whole lorebook (asks first)' },
    },
    ['lorebook'],
  ),
  fn('list_personas', "List the user's existing personas and roleplay characters (id, name, kind, whether built-in, description). Call this before creating or changing one so you update the right thing instead of making a copy.", {}),
  fn('read_persona', "Read one existing persona or character in full (system prompt, or the whole card and lorebook) by name or id, e.g. to improve it.", { persona: { type: 'string', description: 'Name or id' } }, ['persona']),
  fn(
    'save_character',
    'Create a roleplay character for the user. Give the finished SillyTavern/Chub character card as JSON (chara_card_v2: {spec, spec_version, data:{name, description, personality, scenario, first_mes, mes_example, alternate_greetings, system_prompt, post_history_instructions, creator_notes, tags, character_book}}). An embedded character_book becomes the character\'s lorebook. The user is asked to approve first; it appears in their Roleplay list. To change a character later, call save_character again – a same-named character is updated only if the user agrees to add it as a new copy.',
    { card: { type: 'object', description: 'The character card JSON (a JSON string also works)' }, replace: { type: 'string', description: 'To CHANGE an existing character instead of adding a new one: its name or id (see list_personas). Its card is replaced and its lorebook updated; the picture stays unless you pass image.' }, image: IMAGE_ARG, ...TOOLS_ARGS },
    ['card'],
  ),
  fn(
    'save_lorebook',
    'Create a lorebook (world info) for the user from SillyTavern/Chub world-info JSON ({entries:[{keys:[...], content, comment, constant, insertion_order, position,…}]}) or a card-style character_book. Optionally attach it to a character or persona by name. The user is asked to approve first.',
    {
      name: { type: 'string' },
      lorebook: { type: 'object', description: 'The lorebook JSON (a JSON string also works)' },
      attach_to: { type: 'string', description: 'Optional: name of a character/persona to attach this lorebook to' },
    },
    ['name', 'lorebook'],
  ),
  fn(
    'save_persona',
    'Create a chat persona (an assistant with its own system prompt) for the user, or UPDATE an existing one – yours or a built-in like the Persona Maker – when a persona with that name (or the id you pass) already exists; it is changed in place, never copied. Use list_personas / read_persona first when the user asks to change something. The user is asked to approve first. Write the prompt in second person ("You are …"), concrete about role, tone, what to do and not do.',
    {
      name: { type: 'string' },
      id: { type: 'string', description: 'Optional: id of the existing persona to update (from list_personas)' },
      prompt: { type: 'string', description: 'The system prompt' },
      description: { type: 'string', description: 'One line shown in the persona list' },
      emoji: { type: 'string', description: 'One emoji for the avatar' },
      ...TOOLS_ARGS,
      image: IMAGE_ARG,
    },
    ['name', 'prompt'],
  ),
];

export const creatorPrompt = () =>
  '- Before changing something the user already has (a persona, a character, even the Persona Maker itself), call list_personas and read_persona, then change it in place – for a small change use edit_persona / edit_lorebook (only what changes; the rest stays exactly as it is), and save_persona / save_character with replace only to rewrite it completely. Never make a second copy. You can create things for the user: save_character (a full roleplay character card with its lorebook), save_lorebook, and save_persona (a chat assistant). Give each one only the tools it needs with tools/toolset (and single tools with add_tools / remove_tools – e.g. a light persona that keeps only memory) – a roleplay character usually needs none or just web, which keeps its prompt small. Each asks the user to approve, so make the real thing and call the tool rather than pasting it into chat. For a big character, keep each call small: save_character with the card (a short lorebook at most), then save_lorebook with attach_to for a large one – one huge call can get cut off and fail. If the user has creation skills (character-sheet, lorebook, scenario, initial-message, example-dialogue…), load them with use_skill first.\n- When the user wants a new ability from an MCP server (GitHub, a database, a service), use manage_mcp: search the registry, add the server (they approve it), then test it; switch off tools they will not need. Tokens and secret values are never yours to set – ask them to enter those in Settings › MCP servers.';

const asObject = (v, what) => {
  let x = v;
  if (typeof x === 'string') {
    try {
      x = JSON.parse(x.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      throw new Error(`${what} is not valid JSON`);
    }
  }
  if (!x || typeof x !== 'object') throw new Error(`${what} must be a JSON object`);
  return x;
};
const entryCount = (b) => (Array.isArray(b?.entries) ? b.entries.length : Object.keys(b?.entries || {}).length);

/** The picture the user sent (n-th most recent), as a data URL; null when no image was asked for. */
function pickImage(args, ctx) {
  if (args.image == null || args.image === false) return null;
  const n = Math.max(1, Number(args.image) || 1);
  const url = ctx.userImage?.(n);
  if (!url) throw new Error(`The user has not sent ${n === 1 ? 'an image' : `${n} images`} in this chat – leave out "image", or ask them to send one.`);
  return url;
}

/** A "not found" the model can act on: what matched, or what exists. */
function lookupError(q, found, ctx, wantCharacter) {
  if (found?.ambiguous) return `"${q}" matches several: ${found.ambiguous.join(', ')}. Use the exact name or the id from list_personas.`;
  if (found && !found.character && wantCharacter) return `"${found.name}" is a chat persona, not a roleplay character – change it with save_persona.`;
  const other = wantCharacter && ctx.creator.find(q, 'persona');
  const hint = other && !other.ambiguous ? ` (There is a chat persona called "${other.name}" – change that one with save_persona; to turn it into a roleplay character leave out "replace".)` : '';
  const names = ctx.creator.list().filter((p) => (wantCharacter ? p.kind === 'character' : true)).map((p) => `${p.name} (${p.id})`).slice(0, 40);
  return `No ${wantCharacter ? 'character' : 'persona'} called "${q}". Existing${wantCharacter ? ' characters' : ''}: ${names.join('; ') || 'none'}. Use one of these, or leave out "replace" to add a new one.${hint}`;
}

async function approve(ctx, summary, yes = 'Add it') {
  if (!ctx.ask) throw new Error('Creating things needs your approval, which is not available here.');
  ctx.onStatus?.('waiting for your approval…');
  const answer = await ctx.ask(summary, [yes, 'Not now'], ctx.signal);
  return answer === yes ? null : answer;
}
const declined = (answer) => ({ ok: false, result: `The user said no (${answer}). Ask what to change, then try again.`, display: { error: 'declined' } });

export async function runCreatorTool(name, args, ctx) {
  if (!ctx.creator) return { ok: false, result: 'Creating things is not available here.', display: { error: 'unavailable' } };
  if (name === 'list_personas') {
    const l = ctx.creator.list();
    return { ok: true, result: l.map((p) => `${p.id} · ${p.name} · ${p.kind}${p.builtin ? ' · built-in' : ''}${p.lorebook ? ` · lorebook: ${p.lorebook}` : ''}${p.description ? ` · ${p.description}` : ''}`).join('\n') || 'No personas.', display: { path: String(l.length) } };
  }
  if (name === 'read_persona') {
    const p = ctx.creator.read(String(args.persona || ''));
    if (!p) throw new Error('No persona with that name or id – call list_personas');
    return { ok: true, result: JSON.stringify(p, null, 1).slice(0, 24000), display: { path: p.name } };
  }
  if (name === 'save_character') {
    const raw = asObject(args.card, 'card');
    const data = raw.data && (raw.spec || raw.data.name) ? raw.data : raw;
    if (!String(data.name || '').trim()) throw new Error('The card needs a name');
    if (!String(data.description || '').trim()) throw new Error('The card needs a description');
    const card = raw.data && raw.spec ? raw : { spec: 'chara_card_v2', spec_version: '2.0', data };
    const image = pickImage(args, ctx);
    const n = entryCount(card.data.character_book);
    const summary = `Add the character “${card.data.name}”?\n\n${String(card.data.description).replace(/\s+/g, ' ').slice(0, 220)}…\n\n${[card.data.first_mes ? 'first message' : '', card.data.alternate_greetings?.length ? `${card.data.alternate_greetings.length} extra greetings` : '', card.data.mes_example ? 'example dialogue' : '', n ? `lorebook with ${n} entries` : '', image ? 'the picture you sent' : '', toolsNote(args)].filter(Boolean).join(' · ')}`;
    const target = args.replace ? ctx.creator.find(String(args.replace), 'character') : null;
    if (args.replace && (!target || target.ambiguous || !target.character)) throw new Error(lookupError(args.replace, target, ctx, true));
    const no = await approve(ctx, target ? summary.replace(/^Add the character/, 'Replace the character').replace('?\n', ` (keeps its place in your list)?\n`) : summary);
    if (no) return declined(no);
    const r = await ctx.creator.character(card, image, target?.id, { tools: args.tools, toolset: args.toolset, toolPicks: picksArg(args) });
    return { ok: true, result: `${r.updated ? 'Updated' : 'Added'} ${r.name}${r.lorebook ? ` with a ${r.lorebook}-entry lorebook` : ''}${image ? ' and the picture they sent' : ''}. The user finds it in their Roleplay list.`, display: { path: r.name } };
  }
  if (name === 'edit_persona') {
    const cur = ctx.creator.read(String(args.persona || ''));
    if (!cur) throw new Error('No persona or character with that name or id – call list_personas');
    if (args.delete === true) {
      if (cur.builtin) throw new Error(`“${cur.name}” is built in and cannot be deleted – it can be changed, or restored in its editor`);
      const no = await approve(ctx, `Delete ${cur.character ? 'the character' : 'the persona'} “${cur.name}” and the memories it learned? Chats that used it switch to the default persona.`, 'Delete it');
      if (no) return declined(no);
      await ctx.creator.remove(cur.id);
      return { ok: true, result: `Deleted “${cur.name}”.`, display: { path: cur.name } };
    }
    const plan = planPersonaEdit(cur, args);
    const tsn = toolsNote(args);
    const what = [...plan.changed, tsn].filter(Boolean).join(', ');
    const no = await approve(ctx, `Change ${cur.character ? 'the character' : 'the persona'} “${cur.name}”: ${what}?`, 'Change it');
    if (no) return declined(no);
    await ctx.creator.edit(cur.id, { persona: plan.persona, card: plan.card, tools: typeof args.tools === 'boolean' ? args.tools : undefined, toolset: Array.isArray(args.toolset) ? args.toolset.filter((g) => GROUPS.includes(g)) : undefined, toolPicks: picksArg(args) });
    return { ok: true, result: `Changed “${cur.name}”: ${what}. Everything else is as it was.`, display: { path: cur.name } };
  }
  if (name === 'edit_lorebook') {
    const book = ctx.creator.findLorebook(String(args.lorebook || ''));
    if (!book) throw new Error(`No lorebook "${args.lorebook}" (and no character with that name that has one)`);
    if (args.delete === true) {
      const no = await approve(ctx, `Delete the lorebook “${book.name}” (${(book.entries || []).length} entries)?`, 'Delete it');
      if (no) return declined(no);
      await ctx.creator.removeLorebook(book.id);
      return { ok: true, result: `Deleted the lorebook “${book.name}”.`, display: { path: book.name } };
    }
    const plan = planLoreEdit(book.entries || [], args, newEntry);
    const no = await approve(ctx, `Change the lorebook “${book.name}”: ${plan.changed.join(', ')}?`, 'Change it');
    if (no) return declined(no);
    await ctx.creator.setLoreEntries(book.id, plan.entries);
    return { ok: true, result: `Lorebook “${book.name}”: ${plan.changed.join(', ')}. It now has ${plan.entries.length} entries.`, display: { path: book.name } };
  }
  if (name === 'save_lorebook') {
    const lb = asObject(args.lorebook, 'lorebook');
    const n = entryCount(lb.character_book || lb.data?.character_book || lb);
    if (!n) throw new Error('The lorebook has no entries');
    const title = String(args.name || '').trim() || 'Lorebook';
    const no = await approve(ctx, `Add the lorebook “${title}” (${n} entries)${args.attach_to ? ` and attach it to ${args.attach_to}` : ''}?`);
    if (no) return declined(no);
    const r = await ctx.creator.lorebook(title, lb, String(args.attach_to || '').trim());
    return { ok: true, result: `Added the lorebook “${title}” with ${r.entries} entries${r.attached ? ` and attached it to ${r.attached}` : args.attach_to ? ` (no character called "${args.attach_to}" was found, so it is not attached yet)` : ''}.`, display: { path: title } };
  }
  if (name === 'save_persona') {
    const image = pickImage(args, ctx);
    const title = String(args.name || '').trim();
    const prompt = String(args.prompt || '').trim();
    if (!title || !prompt) throw new Error('name and prompt are required');
    const existing = ctx.creator.find(String(args.id || title), args.id ? undefined : 'persona');
    if (existing?.ambiguous) throw new Error(lookupError(args.id || title, existing, ctx, false));
    if (existing?.character) throw new Error(`“${existing.name}” (${existing.id}) is a roleplay character – change it with save_character and replace: "${existing.id}"`);
    const no = await approve(ctx, `${existing ? 'Update' : 'Add'} the persona “${title}”${existing?.builtin ? ' (a built-in persona – it can be restored to the original in its editor)' : ''}${image ? ' with the picture you sent' : ''}?\n\n${String(args.description || prompt).replace(/\s+/g, ' ').slice(0, 220)}${toolsNote(args) ? `\n\n${toolsNote(args)}` : ''}`);
    if (no) return declined(no);
    const r = await ctx.creator.persona({ name: title, prompt, description: String(args.description || '').slice(0, 120), emoji: String(args.emoji || '').slice(0, 4), tools: typeof args.tools === 'boolean' ? args.tools : undefined, toolset: Array.isArray(args.toolset) ? args.toolset.filter((g) => GROUPS.includes(g)) : undefined, toolPicks: picksArg(args), image, id: existing?.id });
    return { ok: true, result: `${r.updated ? 'Updated' : 'Added'} the persona “${title}”. The user can pick it from the persona list.`, display: { path: title } };
  }
  return null;
}
