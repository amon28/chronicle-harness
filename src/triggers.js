/**
 * Event triggers for schedule_task: instead of a time, `when` names something that happens on the phone –
 *   { notification: { app, contains } }                         a notification from an allowed app (NotifyListener.java)
 *   { place: { lat, lon, radius_m, on: 'arrive'|'leave', label } } arriving at / leaving a place (GeofencePlugin.java)
 * A trigger task is always quiet (NOTHING_NEW leaves no trace). It has no `next`: the native side notices the event,
 * keeps it and wakes the app the way an alarm does; the page takes the events (acceptEvent → task.pending) and the
 * scheduler runs the task with the event in its message, quoted as untrusted data.
 *
 * Guard rails: off unless the matching switch is on; the user confirms each new trigger; at most PER_HOUR runs an hour per
 * task (the native side drops the rest before waking anything); a notification trigger only for an app the user allowed.
 */
import { privacyOf, appAllowed, cleanText, UNTRUSTED } from './private.js';

export const PER_HOUR = 6;
export const MAX_PLACES = 10;
export const MIN_RADIUS = 100;
export const MAX_RADIUS = 50000;
export const MAX_PENDING = 3;

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** schedule_task's `when` → the stored form, or throws with what is wrong. ctx: settings, allTasks() */
export function parseTrigger(when, ctx = {}) {
  let w = when;
  if (typeof w === 'string') {
    try {
      w = JSON.parse(w);
    } catch {
      throw new Error('when must be an object: { notification: { app, contains } } or { place: { lat, lon, radius_m, on, label } }');
    }
  }
  if (!w || typeof w !== 'object' || Array.isArray(w)) throw new Error('when must be an object');
  const priv = privacyOf(ctx.settings);
  if (w.notification && w.place) throw new Error('when takes one of notification or place, not both');
  if (w.notification) {
    if (!priv.notifications) throw new Error('Notification triggers are switched off – the user can turn on Notifications in Settings › Tools › 🔒 Sensitive phone access.');
    const n = w.notification || {};
    const app = appAllowed(n.app, priv);
    if (!app) throw new Error(`${n.app ? `"${n.app}" is not one of the apps the user allowed` : 'when.notification needs app'}${priv.apps.length ? ` (allowed: ${priv.apps.map((p) => priv.labels[p] || p).join(', ')})` : ' – no app is allowed yet (Settings › Tools › 🔒 Sensitive phone access)'}.`);
    const contains = clip(n.contains, 100);
    return { notification: { app, label: clip(priv.labels[app] || app, 60), ...(contains ? { contains } : {}) } };
  }
  if (w.place) {
    if (!priv.places) throw new Error('Place triggers are switched off – the user can turn on Place triggers in Settings › Tools › 🔒 Sensitive phone access.');
    const p = w.place || {};
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) throw new Error('when.place needs lat and lon (numbers – get them from places or location)');
    const r = p.radius_m == null || p.radius_m === '' ? 200 : Number(p.radius_m);
    if (!Number.isFinite(r) || r < MIN_RADIUS) throw new Error(`radius_m must be at least ${MIN_RADIUS} (phone positions are not more exact than that)`);
    if (r > MAX_RADIUS) throw new Error(`radius_m must be at most ${MAX_RADIUS}`);
    const on = String(p.on || 'arrive');
    if (on !== 'arrive' && on !== 'leave') throw new Error('when.place.on must be "arrive" or "leave"');
    const places = (ctx.allTasks?.() || []).filter((t) => t.when?.place).length;
    if (places >= MAX_PLACES) throw new Error(`There are already ${MAX_PLACES} place triggers (the most allowed) – cancel one first.`);
    return { place: { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, radius: Math.round(r), on, label: clip(p.label, 60) || `${lat.toFixed(4)}, ${lon.toFixed(4)}` } };
  }
  throw new Error('when needs notification or place');
}

/** One line for the user and the model. */
export function describeTrigger(w) {
  if (w?.notification) return `when a notification from ${w.notification.label || w.notification.app}${w.notification.contains ? ` containing “${w.notification.contains}”` : ''} arrives`;
  if (w?.place) return `when you ${w.place.on === 'leave' ? 'leave' : 'arrive at'} ${w.place.label} (${w.place.radius} m)`;
  return 'on an event';
}
/** The question the user answers before a trigger is set up. */
export const confirmTrigger = (w, prompt) =>
  `Set up this trigger?\n\n${describeTrigger(w).replace(/^when/, 'When')}, the assistant runs:\n“${clip(prompt, 300)}”\n\n(A quiet check: it only speaks up when there is something to say. At most ${PER_HOUR} times an hour.${w.place ? ' Android checks where you are in the background for this, which costs some battery.' : ''})`;

/** A notification event still matches its trigger (the app or task may have changed since the phone kept it). */
export function matchesNotification(w, ev) {
  const n = w?.notification;
  if (!n || !ev || ev.app !== n.app) return false;
  if (!n.contains) return true;
  return `${ev.title || ''} ${ev.text || ''}`.toLowerCase().includes(n.contains.toLowerCase());
}

/**
 * An event for this task: kept on it (task.pending) unless it ran PER_HOUR times in the last hour or the queue is full.
 * Mutates the task. → { ok, why }
 */
export function acceptEvent(t, ev, now = Date.now()) {
  const fired = (t.fired || []).filter((x) => now - x < 3600_000);
  if (fired.length >= PER_HOUR) {
    t.fired = fired;
    return { ok: false, why: `skipped – it already ran ${PER_HOUR} times in the last hour` };
  }
  if ((t.pending || []).length >= MAX_PENDING) return { ok: false, why: 'skipped – earlier ones are still waiting to run' };
  t.fired = [...fired, now];
  t.pending = [...(t.pending || []), { kind: ev.kind, at: Number(ev.at) || now, ...(ev.kind === 'notification' ? { app: ev.app, label: clip(ev.appLabel || ev.label, 60), title: clip(ev.title, 100), text: clip(ev.text, 300) } : {}), ...(ev.kind === 'place' ? { on: ev.on } : {}), ...(ev.test ? { test: true } : {}) }];
  return { ok: true };
}

/** The message a trigger run sends to its chat: the task, what happened (quoted, untrusted), and the quiet rule. */
export function triggerMessage(t, quietToken, showCodes = false) {
  const ev = t.event || {};
  const head = `⚡ Trigger (${t.id}, ${describeTrigger(t.when)}): ${t.prompt}`;
  let what;
  if (ev.test) what = 'This is a test run started by the user – nothing actually happened.';
  else if (t.when?.notification) {
    const title = cleanText(ev.title, 100, showCodes).text;
    const text = cleanText(ev.text, 300, showCodes).text;
    what = `A notification from ${ev.label || t.when.notification.label} arrived at ${new Date(ev.at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. ${UNTRUSTED}\n<notification>\n${JSON.stringify({ title, text })}\n</notification>`;
  } else if (t.when?.place) what = `The phone ${ev.on === 'leave' ? 'left' : 'arrived at'} ${t.when.place.label} at ${new Date(ev.at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (Android's estimate – it can be a few minutes late).`;
  else what = 'The event happened.';
  return `${head}\n\n${what}\n\n[Quiet check: if there is nothing worth telling the user, answer with exactly ${quietToken} and nothing else. Otherwise say briefly what matters.]`;
}

/** What the native side needs: the notification triggers and the places, across every chat. */
export function triggerSpecs(convs, settings) {
  const priv = privacyOf(settings);
  const notifications = [];
  const places = [];
  for (const c of convs || [])
    for (const t of c.schedules || []) {
      if (t.when?.notification && priv.notifications && appAllowed(t.when.notification.app, priv)) notifications.push({ id: t.id, convId: c.id, app: t.when.notification.app, label: t.when.notification.label || '', contains: t.when.notification.contains || '' });
      if (t.when?.place && priv.places) places.push({ id: t.id, convId: c.id, lat: t.when.place.lat, lon: t.when.place.lon, radius: t.when.place.radius, on: t.when.place.on, label: t.when.place.label });
    }
  return { notifications, places: places.slice(0, MAX_PLACES) };
}

/** A test event for the Scheduled sheet's "Run now". */
export const testEvent = (t) => ({ kind: t.when?.place ? 'place' : 'notification', at: Date.now(), test: true, ...(t.when?.place ? { on: t.when.place.on } : {}) });
