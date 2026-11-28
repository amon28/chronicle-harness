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
    // the body is what the notification says when the task could NOT run (Android had closed the app – the page
    // answers for itself otherwise): said plainly, and a repeating one is set again by Android so the next one comes
    // (decision 276: "⏰ Scheduled: …" read as done, and a repeat stopped after it)
    for (const t of c.schedules || []) if (t.next) out.push({ at: t.next, convId: c.id, kind: 'task', title: `⏰ ${title}`, body: `Did not run – Android had closed Chronicle: ${String(t.prompt).slice(0, 120)}. Tap to run it now. (To run checks on their own, let Chronicle run in the background: Settings › Apps › Chronicle › Battery › Unrestricted.)`, ...(t.every ? { every: t.every } : {}) });
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
