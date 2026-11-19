/**
 * Choice chips: in roleplay the model can end a reply with a few options for what you do next, in a
 * <choices> block. The block is hidden from the reply (and from what is sent back to the model) and shown
 * as buttons under the newest reply.
 */
const BLOCK = /\s*<choices>([\s\S]*?)(?:<\/choices>|$)\s*/i;

/** The reply without its choices block (also while it is still being written). */
export function stripChoices(text) {
  const s = String(text || '');
  if (!/<choices>/i.test(s)) return s.replace(/\s*<[a-z]{0,7}$/i, (m) => (m.trim().length > 2 && '<choices>'.startsWith(m.trim().toLowerCase()) ? '' : m)); // "<cho…" still arriving
  return s.replace(BLOCK, '\n').trimEnd();
}

/** The options in a finished reply: up to 4 short lines, numbering and bullets removed. */
export function parseChoices(text) {
  const m = String(text || '').match(/<choices>([\s\S]*?)<\/choices>/i);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|[A-D][.)])\s*/, '').trim())
    .filter((l) => l && l.length <= 300)
    .slice(0, 4);
}
