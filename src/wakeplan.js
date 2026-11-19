/**
 * The wake plan: every moment the app has something to do on its own – a scheduled task, a retry after the
 * usage limit resets, a character writing first – handed to Android, which wakes the app then (AlarmManager,
 * also in Doze) or, if Android has closed the app, shows a notification that opens it.
 */
import { nextProactive } from './proactive.js';

/** → [{ at, convId, kind, title, body }] sorted, the next 40 at most. */
export function wakePlan(convs, { proactiveOn = false, quiet = null, name = (c) => c.title || 'Chronicle', now = Date.now() } = {}) {
  const out = [];
  for (const c of convs || []) {
    const title = String(name(c) || 'Chronicle').slice(0, 60);
    for (const t of c.schedules || []) if (t.next) out.push({ at: t.next, convId: c.id, kind: 'task', title: `⏰ ${title}`, body: `Scheduled: ${String(t.prompt).slice(0, 140)}` });
    if (c.resumeAt) out.push({ at: c.resumeAt, convId: c.id, kind: 'resume', title: `↻ ${title}`, body: 'Your OpenCode Go allowance has reset – open to retry the reply.' });
    if (proactiveOn) {
      const p = nextProactive(c, { quiet });
      if (p) out.push({ at: p, convId: c.id, kind: 'proactive', title: `💬 ${title}`, body: 'Has something to tell you – open to read it.' });
    }
  }
  return out
    .map((x) => ({ ...x, at: Math.max(x.at, now + 60_000) })) // never in the past: a minute from now at the soonest
    .sort((a, b) => a.at - b.at)
    .slice(0, 40);
}

/** A cheap fingerprint, so the plan is only sent to Android when it changed. */
export const planKey = (plan) => plan.map((x) => `${x.kind}:${x.convId}:${Math.round(x.at / 60000)}`).join('|');
