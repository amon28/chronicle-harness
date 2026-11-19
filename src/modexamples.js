// Ready-made mods you can install from the Mods screen. Each is { manifest, code } (the header is added on install).
export const EXAMPLES = [
  {
    manifest: { id: 'word-count', name: 'Word count', version: '1.0.0', description: '/count <text> tells you how many words and characters a text has.', author: 'Chronicle', permissions: ['commands'] },
    code: `mod.command({
  name: 'count',
  description: 'Count words and characters',
  run: async (text) => {
    const words = text.trim().split(/\\s+/).filter(Boolean).length;
    return { toast: words + ' words, ' + text.length + ' characters' };
  },
});`,
  },
  {
    manifest: { id: 'dice', name: 'Dice roller', version: '1.0.0', description: 'Gives the assistant a roll_dice tool (e.g. 2d6+3) – handy in roleplay and games.', author: 'Chronicle', permissions: ['tools'] },
    code: `mod.tool({
  name: 'roll_dice',
  description: 'Roll dice in NdS+M notation, e.g. 2d6+3 or d20. Returns each roll and the total.',
  parameters: { type: 'object', properties: { dice: { type: 'string', description: 'e.g. 2d6+3' } }, required: ['dice'] },
  run: async ({ dice }) => {
    const m = String(dice).trim().toLowerCase().match(/^(\\d*)d(\\d+)([+-]\\d+)?$/);
    if (!m) throw new Error('Use a form like 2d6+3');
    const n = Math.min(Number(m[1] || 1), 50), sides = Math.min(Number(m[2]), 1000), plus = Number(m[3] || 0);
    const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
    const total = rolls.reduce((a, b) => a + b, 0) + plus;
    return rolls.join(' + ') + (plus ? ' ' + (plus > 0 ? '+ ' : '- ') + Math.abs(plus) : '') + ' = ' + total;
  },
});`,
  },
  {
    manifest: { id: 'todays-date', name: "Today's date", version: '1.0.0', description: 'Tells the model today\'s date and time with every message (some models have no clock).', author: 'Chronicle', permissions: ['request'] },
    code: `mod.on('beforeRequest', () => ({
  append: [{ role: 'system', content: 'Right now it is ' + new Date().toLocaleString() + '.' }],
}));`,
  },
  {
    manifest: { id: 'reply-counter', name: 'Reply counter', version: '1.0.0', description: 'Counts the assistant replies you get and shows the total in a chip beside the message box.', author: 'Chronicle', permissions: ['chat', 'storage'] },
    code: `async function show() {
  const n = (await mod.storage.get('replies')) || 0;
  mod.status('💬 ' + n + ' replies');
}
mod.on('afterReply', async () => {
  const n = ((await mod.storage.get('replies')) || 0) + 1;
  await mod.storage.set('replies', n);
  await show();
});
await show();`,
  },
  {
    manifest: { id: 'wikipedia-search', name: 'Wikipedia search', version: '1.0.0', description: 'Adds Wikipedia as an extra source for the assistant’s web search.', author: 'Chronicle', permissions: ['search', 'net:en.wikipedia.org'] },
    code: `mod.searchSource({
  name: 'Wikipedia',
  description: 'English Wikipedia articles',
  run: async (query, { max }) => {
    const r = await mod.fetch('https://en.wikipedia.org/w/rest.php/v1/search/page?limit=' + (max || 5) + '&q=' + encodeURIComponent(query));
    return JSON.parse(r.text).pages.map((p) => ({ title: p.title, url: 'https://en.wikipedia.org/wiki/' + p.key, snippet: p.description || p.excerpt || '' }));
  },
});`,
  },
  {
    manifest: { id: 'tool-guard', name: 'Tool guard', version: '1.0.0', description: 'Blocks the assistant from deleting files (workspace or phone folder) and from reading pages on the hosts you list.', author: 'Chronicle', permissions: ['toolhook'] },
    code: `const BLOCKED_HOSTS = ['example-bank.com']; // edit this list
mod.on('beforeTool', ({ name, args }) => {
  if (name === 'delete_file' || name === 'phone_delete') return { block: 'deleting files is switched off' };
  if (name === 'fetch_url') {
    const urls = [].concat(args.urls || args.url || []);
    const bad = urls.find((u) => BLOCKED_HOSTS.some((h) => String(u).includes(h)));
    if (bad) return { block: 'reading ' + bad + ' is not allowed' };
  }
});`,
  },
  {
    manifest: { id: 'notes-panel', name: 'Notes panel', version: '1.0.0', description: '/note <text> saves a note; the panel (chat menu › Mod panels) lists them.', author: 'Chronicle', permissions: ['panel', 'commands', 'storage'] },
    code: `mod.command({
  name: 'note',
  description: 'Save a note',
  run: async (text) => {
    const notes = (await mod.storage.get('notes')) || [];
    notes.push({ at: new Date().toLocaleString(), text });
    await mod.storage.set('notes', notes.slice(-50));
    return { toast: 'Note saved (' + notes.length + ')' };
  },
});
mod.panel({
  name: 'Notes',
  icon: '📝',
  description: 'Your saved notes',
  render: async () => {
    const notes = (await mod.storage.get('notes')) || [];
    return notes.length ? notes.map((n) => '- **' + n.at + '** – ' + n.text).join('\\n') : 'No notes yet. Type /note followed by some text.';
  },
});`,
  },
];

export const headerFor = (m) => `/*! @mod ${JSON.stringify(m, null, 2)} */\n\n`;
