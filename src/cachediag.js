// Where the provider's prompt cache stopped matching (decision 199): providers cache the start of a request – tools,
// then the system prompt, then the messages in order – and reuse it while the next request starts the same way. This
// compares a request with the one before it from the same chat and says where they first differ, so a prompt that
// changes its start every turn (and pays for the whole history again) shows up in the prompt inspector.
/** A quick 32-bit FNV-1a hash of a string (not for security: only to tell two prompts apart). */
function fnv1a(s) {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return x.toString(36) + ':' + s.length;
}
const h = (x) => fnv1a(typeof x === 'string' ? x : JSON.stringify(x ?? null));

/** A request's shape for the comparison: a hash of its tools and of each message (the first system one is "system"). */
export function requestShape(req) {
  const msgs = req?.messages || [];
  const sysEnd = msgs.findIndex((m) => m.role !== 'system');
  // the per-turn context after the history (memories, notes): trailing system messages, expected to change
  let tail = msgs.length;
  while (tail > 0 && msgs[tail - 1].role === 'system') tail--;
  return { model: req?.model || '', tools: h(req?.tools || []), msgs: msgs.map((m) => h({ r: m.role, c: m.content, t: m.tool_calls, i: m.tool_call_id })), system: sysEnd < 0 ? msgs.length : sysEnd, tail };
}

/**
 * prev, cur: requestShape()s. → null (nothing to compare, or cur continues prev: the cache can hit up to the new
 * part) or { at: 'model' | 'tools' | 'system' | 'message', index, of, reused } – index: the first message that
 * differs; reused: how many of the earlier messages still match.
 */
export function cacheBreak(prev, cur) {
  if (!prev || !cur) return null;
  if (prev.model !== cur.model) return { at: 'model', index: 0, of: cur.msgs.length, reused: 0 };
  if (prev.tools !== cur.tools) return { at: 'tools', index: 0, of: cur.msgs.length, reused: 0 };
  // the per-turn context at the end of the earlier request is expected to change – only a difference before it is a break
  const n = Math.min(prev.msgs.length, cur.msgs.length);
  for (let i = 0; i < n; i++) {
    if (prev.msgs[i] === cur.msgs[i]) continue;
    if (i >= (prev.tail ?? prev.msgs.length)) return null;
    return { at: i < cur.system ? 'system' : 'message', index: i, of: cur.msgs.length, reused: i };
  }
  return null;
}

/** For the inspector: one line. */
export function cacheBreakText(b) {
  if (!b) return 'Cache: this request starts like the one before (it can reuse its cached start)';
  if (b.at === 'model') return 'Cache: another model than the request before – nothing reused';
  if (b.at === 'tools') return 'Cache: the tool list changed since the request before – nothing reused (tools come first)';
  if (b.at === 'system') return 'Cache: the system prompt changed since the request before – only the tools reused';
  return `Cache: changed from message #${b.index + 1} of ${b.of} – the ${b.reused} before it can be reused`;
}
