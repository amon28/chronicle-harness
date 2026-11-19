// Chats in and out: SillyTavern .jsonl chat files, and readable Markdown / text exports.
// ST format: line 1 = header {user_name, character_name, create_date, chat_metadata},
// then one JSON message per line {name, is_user, is_system, send_date, mes, swipes?, swipe_id?}.

const pad = (n) => String(n).padStart(2, '0');
const stDate = (t) => {
  const d = new Date(t || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}@${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}s`;
};
const parseDate = (v) => {
  if (typeof v === 'number') return v;
  const t = Date.parse(String(v || '').replace(/(\d)(am|pm)$/i, '$1 $2'));
  if (!Number.isNaN(t)) return t;
  const m = String(v || '').match(/^(\d{4})-(\d\d)-(\d\d)@(\d\d)h(\d\d)m(\d\d)s/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : undefined;
};

/** Parse a SillyTavern chat. → { user, character, messages: [{ role, name, content, at, swipes?, swipeIndex? }] } */
export function parseStChat(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error('The file is empty');
  const rows = lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`Line ${i + 1} is not valid JSON – is this a SillyTavern .jsonl chat?`);
    }
  });
  const header = rows[0] && rows[0].mes === undefined ? rows.shift() : {};
  const messages = [];
  for (const r of rows) {
    if (r.mes === undefined || r.is_system) continue; // hidden / system notes
    const swipes = Array.isArray(r.swipes) && r.swipes.length > 1 ? r.swipes.map(String) : null;
    const swipeIndex = swipes ? Math.min(Math.max(0, r.swipe_id | 0), swipes.length - 1) : 0;
    messages.push({
      role: r.is_user ? 'user' : 'assistant',
      name: String(r.name || (r.is_user ? header.user_name : header.character_name) || ''),
      content: String(swipes ? swipes[swipeIndex] : r.mes),
      at: parseDate(r.send_date),
      ...(swipes ? { swipes, swipeIndex } : {}),
    });
  }
  if (!messages.length) throw new Error('No messages found in this chat');
  const chars = [...new Set(messages.filter((m) => m.role === 'assistant').map((m) => m.name).filter(Boolean))];
  return { user: header.user_name || messages.find((m) => m.role === 'user')?.name || 'User', character: header.character_name || chars[0] || 'Character', characters: chars, created: parseDate(header.create_date), messages };
}

/** A chat → SillyTavern .jsonl text. nameOf(msg) gives the speaker's name. */
export function toStChat(conv, { user = 'User', character = 'Character', nameOf = () => character } = {}) {
  const head = { user_name: user, character_name: character, create_date: stDate(conv.createdAt), chat_metadata: {} };
  const rows = conv.messages
    .filter((m) => typeof m.content === 'string')
    .map((m) => {
      const isUser = m.role === 'user';
      const row = { name: isUser ? user : nameOf(m), is_user: isUser, is_system: false, send_date: stDate(m.at || conv.createdAt), mes: m.content, extra: {} };
      if (!isUser && m.alts?.length > 1) {
        row.swipes = m.alts.map((a) => a.content || '');
        row.swipe_id = m.altIndex ?? 0;
      }
      return row;
    });
  return [head, ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** A chat → readable Markdown (or plain text). */
export function toReadable(conv, { title = 'Chat', user = 'User', nameOf = () => 'Assistant', markdown = true } = {}) {
  const when = (t) => (t ? new Date(t).toLocaleString() : '');
  const out = markdown ? [`# ${title}`, ''] : [title, '='.repeat(Math.min(60, title.length)), ''];
  for (const m of conv.messages) {
    if (typeof m.content !== 'string' || !m.content.trim()) continue;
    const who = m.role === 'user' ? user : nameOf(m);
    if (markdown) out.push(`**${who}**${m.at ? ` · ${when(m.at)}` : ''}`, '', m.content.trim(), '', '---', '');
    else out.push(`${who}${m.at ? ` (${when(m.at)})` : ''}:`, m.content.trim(), '');
  }
  return out.join('\n').trim() + '\n';
}
