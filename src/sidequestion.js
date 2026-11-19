// /btw: the request for a side question (pure; app/btw.js shows the answer). See app/btw.js.

export const BTW_NOTE = '[A quick side question from the user – "by the way". Answer it briefly from the conversation above. You cannot use tools now, and this answer is not added to the chat; the work in progress (if any) carries on separately, so do not continue it here.]';

/** The request: the chat as the next reply would see it, tool calls written out as text (no tools are offered). */
export function btwMessages(history, question) {
  const out = [];
  const names = new Map();
  for (const m of history) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const c of m.tool_calls) names.set(c.id, c.function?.name || 'tool');
      const calls = m.tool_calls.map((c) => `[called ${c.function?.name} ${String(c.function?.arguments || '').slice(0, 300)}]`).join('\n');
      out.push({ role: 'assistant', content: [m.content, calls].filter((x) => x && x !== '(working)').join('\n') || '(working)' });
    } else if (m.role === 'tool') out.push({ role: 'user', content: `[result of ${names.get(m.tool_call_id) || 'a tool'}]\n${String(m.content || '').slice(0, 3000)}` });
    else {
      const { role, content } = m; // reasoning fields and the like are left out
      out.push({ role, content });
    }
  }
  out.push({ role: 'user', content: `${BTW_NOTE}\n\n${question}` });
  return out;
}
