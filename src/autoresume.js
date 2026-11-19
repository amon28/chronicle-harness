/**
 * Auto-resume after an OpenCode Go limit: when a reply fails on a usage limit, the earliest reset among
 * the limited meters is remembered on the chat; once it passes the failed reply is tried again.
 */

/** The time to resume at, from a usage reading: the latest reset among the limited meters (every limit must clear). */
export function resumeTime(usage, now = Date.now()) {
  if (!usage) return 0;
  const limited = ['rolling', 'weekly', 'monthly'].map((k) => usage[k]).filter((m) => m?.limited && Number.isFinite(m.resetsAt) && m.resetsAt > now);
  if (!limited.length) return 0;
  return Math.max(...limited.map((m) => m.resetsAt)) + 30_000; // a little after, so the allowance has really reset
}

/** The chats whose resume time has passed, and whose last message is still the failed reply. */
export function dueResumes(convs, now = Date.now()) {
  return (convs || []).filter((c) => {
    if (!c?.resumeAt || c.resumeAt > now) return false;
    const last = c.messages?.[c.messages.length - 1];
    return last?.role === 'assistant' && !!last.error;
  });
}

/** "3:40 PM" today, or "Tue 3:40 PM" further out. */
export function fmtResume(ms, now = Date.now()) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return ms - now < 20 * 3600e3 ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
