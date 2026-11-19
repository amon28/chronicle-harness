/**
 * Proactive messages: a character (or assistant) writes first after you have been quiet for a while.
 * Off unless switched on in Settings AND for the chat. Never during quiet hours, at most `cap` a day, once per
 * silence (it waits for you to answer before writing again), and not when today's token budget is spent.
 */

/** "22:00" → minutes since midnight. */
const mins = (hm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null;
};

/** Is this moment inside the quiet hours (which may wrap past midnight)? */
export function inQuiet(t, quiet) {
  const a = mins(quiet?.from);
  const b = mins(quiet?.to);
  if (a == null || b == null || a === b) return false;
  const d = new Date(t);
  const x = d.getHours() * 60 + d.getMinutes();
  return a < b ? x >= a && x < b : x >= a || x < b;
}

/** The first moment at or after t that is outside the quiet hours. */
export function afterQuiet(t, quiet) {
  if (!inQuiet(t, quiet)) return t;
  const b = mins(quiet.to);
  const d = new Date(t);
  d.setHours(Math.floor(b / 60), b % 60, 0, 0);
  if (d.getTime() <= t) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const lastReal = (conv) => [...(conv.messages || [])].reverse().find((m) => !m.streaming && (m.content || m.error) && !m.hidden);

/**
 * When this chat may write first next (ms), or 0 if it may not. conv.proactive = { hours } (how long a silence
 * before it writes).
 */
export function nextProactive(conv, { quiet = null } = {}) {
  const hours = Number(conv?.proactive?.hours) || 0;
  if (!hours) return 0;
  const last = lastReal(conv);
  if (!last) return 0;
  if (last.proactive) return 0; // it already wrote first: wait for you
  if (last.error || last.role !== 'assistant') return 0; // only after a finished reply, never on top of your unanswered message
  return afterQuiet((last.at || conv.updatedAt || 0) + hours * 3600e3, quiet);
}

/** Today's count of proactive messages across chats, from the chats themselves. */
export function proactiveToday(convs, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  let n = 0;
  for (const c of convs || []) for (const m of c.messages || []) if (m.proactive && (m.at || 0) >= d.getTime()) n++;
  return n;
}

/** The chats that should write first now: due, not in quiet hours, under the daily cap (oldest silence first). */
export function dueProactive(convs, { now = Date.now(), quiet = null, cap = 3, busy = () => false } = {}) {
  if (inQuiet(now, quiet)) return [];
  const left = Math.max(0, cap - proactiveToday(convs, now));
  if (!left) return [];
  return (convs || [])
    .map((c) => ({ c, at: nextProactive(c, { quiet }) }))
    .filter((x) => x.at && x.at <= now && !busy(x.c))
    .sort((a, b) => a.at - b.at)
    .slice(0, left)
    .map((x) => x.c);
}

/** The instruction for the message: in character, short, a natural reason to reach out, no meta talk. */
export function proactiveGuidance(idleMs, rp) {
  const h = idleMs / 3600e3;
  const gap = h < 1.5 ? 'a little while' : h < 30 ? `about ${Math.round(h)} hours` : `about ${Math.round(h / 24)} day${Math.round(h / 24) > 1 ? 's' : ''}`;
  return rp
    ? `{{user}} has not written for ${gap}. Write a short message {{char}} sends on their own initiative now – picking up the story, a thought, a question, or something that happened meanwhile – the way they would text first. Stay in character; do not mention being an AI or the gap in mechanical terms.`
    : `The user has not written for ${gap}. Send one short, useful follow-up on your own initiative – a check-in on what you were working on, a reminder, or a relevant idea. Do not repeat earlier answers. If there is nothing worth saying, keep it to one friendly line.`;
}
