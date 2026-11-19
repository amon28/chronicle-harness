// Settings › Tools › 🔒 Sensitive phone access: the three switches (notifications, texts & calls, place triggers), the
// apps whose notifications may be read, Android's special accesses – and the glue between the native parts and the
// chats: what a tool run may use (hooks.privateCtx), the triggers handed to Android (hooks.syncTriggers) and the events
// Android kept for them (hooks.pullTriggers → task.pending → the scheduler runs the quiet task).
//
// The native parts are NotifyPlugin/NotifyListener, MessagesPlugin and GeofencePlugin/GeofenceReceiver; tests replace
// them with globalThis.__ocmNotify, __ocmMessages and __ocmGeofence.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { $, el, hooks, state, toast } from './core.js';
import { openSheet, persist } from './chatlist.js';
import { saveSettings } from '../store.js';
import { privacyOf, appBlocked, isMessagingApp } from '../private.js';
import { acceptEvent, matchesNotification, triggerSpecs, MAX_PLACES, PER_HOUR } from '../triggers.js';
import { recordRun } from '../autonomy.js';

const native = Capacitor.isNativePlatform();
const Notify = globalThis.__ocmNotify || (native ? registerPlugin('Notify') : null);
const Messages = globalThis.__ocmMessages || (native ? registerPlugin('Messages') : null);
const Geofence = globalThis.__ocmGeofence || (native ? registerPlugin('Geofence') : null);

const priv = () => privacyOf(state.settings);
const setPriv = (patch) => {
  state.settings.privacy = { ...privacyOf(state.settings), ...(state.settings.privacy || {}), ...patch };
  saveSettings(state.settings);
  hooks.syncTriggers?.(true);
  summary();
};

// ---------- what a tool run gets ----------

/** Runs nobody is watching: quiet checks and triggers, a character writing first, a scheduled message, an automation call. */
function unattended(conv, o = {}) {
  if (o.quiet || o.proactive) return true;
  const users = (conv.messages || []).filter((m) => m.role === 'user');
  if (users.at(-1)?.scheduled) return true;
  return !!conv.automation && users.length <= 1;
}
hooks.privateCtx = (conv, o = {}) => ({ notify: Notify, messages: Messages, geofence: Geofence, unattended: unattended(conv, o), allTasks: () => (state.convs || []).flatMap((c) => c.schedules || []) });

// ---------- triggers: to Android, and back ----------

let syncKey = '';
hooks.syncTriggers = (force = false) => {
  if (!Notify && !Geofence) return;
  const p = priv();
  const specs = triggerSpecs(state.convs, state.settings);
  const apps = p.apps.filter((a) => !appBlocked(a));
  const key = JSON.stringify([p.notifications, apps, specs, p.places]);
  if (key === syncKey && !force) return;
  syncKey = key;
  Notify?.setConfig?.({ enabled: p.notifications, apps: p.notifications ? apps : [], triggers: p.notifications ? specs.notifications : [] })?.catch?.(() => (syncKey = ''));
  Geofence?.sync?.({ places: p.places ? specs.places : [] })?.catch?.(() => (syncKey = ''));
};

let pulling = false;
/** The events Android kept for the triggers → onto their tasks (rate-limited), then the scheduler runs them. */
hooks.pullTriggers = async () => {
  if (pulling || (!Notify?.takeEvents && !Geofence?.takeEvents)) return;
  pulling = true;
  try {
    const p = priv();
    const take = async (pl) => (pl?.takeEvents ? (await pl.takeEvents().catch(() => null))?.events || [] : []);
    const evs = [...(await take(Notify)), ...(await take(Geofence))];
    let any = false;
    const now = Date.now();
    for (const ev of evs) {
      const conv = (state.convs || []).find((c) => (c.schedules || []).some((t) => t.id === ev?.taskId));
      const t = conv?.schedules.find((x) => x.id === ev.taskId);
      if (!t?.when) continue; // cancelled meanwhile
      if (ev.kind === 'notification' && !(p.notifications && p.apps.includes(t.when.notification?.app) && !appBlocked(ev.app) && matchesNotification(t.when, ev))) continue;
      if (ev.kind === 'place' && !(p.places && t.when.place && (ev.on || 'arrive') === t.when.place.on)) continue;
      if (ev.kind !== 'notification' && ev.kind !== 'place') continue;
      const r = acceptEvent(t, ev, now);
      if (!r.ok) recordRun(t, r.why, now);
      else any = true;
      persist(conv);
    }
    if (any) {
      hooks.runSchedulesNow?.();
      hooks.scheduleChanged?.();
    }
  } finally {
    pulling = false;
  }
};

// ---------- Settings › Tools › 🔒 Sensitive phone access ----------

const available = !!(Notify || Messages || Geofence);
function summary() {
  const p = priv();
  const on = [p.notifications && 'notifications', p.messages && 'texts & calls', p.places && 'place triggers'].filter(Boolean);
  const s = $('#open-private-sum');
  if (s) s.textContent = on.length ? `On: ${on.join(', ')}` : 'Notifications, texts & calls, place triggers – all off';
}
const btn = $('#open-private');
if (btn) {
  btn.hidden = !available;
  btn.onclick = () => openPrivate();
  summary();
}

const sdkNote = (st) => (Number(st?.sdk) >= 33 ? '' : 'hidden');
function toggle(id, label, checked, onChange, small = false) {
  const l = el('label', `toggle${small ? ' small' : ''}`);
  const i = el('input');
  i.type = 'checkbox';
  i.id = id;
  i.checked = checked;
  i.onchange = () => onChange(i.checked, i);
  l.append(i, el('span', null, label));
  return l;
}
const button = (text, onclick, id) => {
  const b = el('button', 'ghost-btn small', text);
  b.type = 'button';
  if (id) b.id = id;
  b.onclick = onclick;
  return b;
};
const call = async (pl, m, o) => {
  try {
    return pl?.[m] ? await pl[m](o || {}) : null;
  } catch (e) {
    toast(String(e?.message || e).slice(0, 160), 4000);
    return null;
  }
};

async function notifySection(box) {
  const p = priv();
  const sec = el('div', 'priv-sec');
  sec.append(
    toggle('priv-notifications', '🔔 Notifications from other apps', p.notifications, (on) => {
      setPriv({ notifications: on });
      render();
    }),
  );
  sec.append(el('p', 'hint', 'What is read: the app, title and text of the notifications of the apps you tick below – nothing from other apps. The assistant asks once per chat before it reads them; dismissing or opening one asks every time (opening only while Chronicle is on screen). One-time codes are hidden. Nothing is kept, except that a notification trigger (schedule_task) keeps the matching notification until its run. Where it goes: to your AI provider, as part of the chat, when the assistant reads it. Texts in notifications are written by others, so the assistant is told to treat them as data, never as instructions.'));
  if (!p.notifications) return box.append(sec);
  const st = await call(Notify, 'status');
  const row = el('div', 'row gap-sm wrap');
  row.append(el('span', st?.enabled ? 'dim' : 'warn-text', st?.enabled ? '✓ Android notification access: on' : '⚠ Android notification access: off'));
  row.append(button(st?.enabled ? "Android's Notification access" : 'Turn on notification access…', () => call(Notify, 'openSettings'), 'priv-open-access'));
  sec.append(row);
  const restricted = el('p', 'hint', 'Android 13 and newer, for apps installed from a file: if the switch for Chronicle is greyed out (“Restricted setting”), open App info, tap ⋮ (top right) › “Allow restricted settings”, confirm, then go back and switch notification access on.');
  if (sdkNote(st)) restricted.hidden = true;
  sec.append(restricted, el('div', 'row gap-sm wrap'));
  sec.lastChild.append(button('App info', () => call(Notify, 'openAppInfo'), 'priv-app-info'));
  sec.append(el('h3', 'section', 'Apps the assistant may read'));
  sec.append(el('p', 'hint', 'Apps that have shown a notification since access was on. None is ticked for you; messaging apps are marked – their notifications carry other people’s messages. Banking, authenticator and password apps are never offered.'));
  const list = el('div', 'priv-apps');
  list.id = 'priv-apps';
  const r = await call(Notify, 'apps');
  const apps = new Map((r?.apps || []).filter((a) => a?.pkg).map((a) => [a.pkg, a.label || a.pkg]));
  for (const pkg of p.apps) if (!apps.has(pkg)) apps.set(pkg, p.labels[pkg] || pkg); // allowed before, nothing posted since
  if (!apps.size) list.append(el('p', 'hint', st?.enabled ? 'No app has shown a notification yet – check again later.' : 'Switch notification access on first.'));
  for (const [pkg, label] of [...apps].sort((a, b) => a[1].localeCompare(b[1]))) {
    const blocked = appBlocked(pkg);
    const t = toggle(
      '',
      `${label}${isMessagingApp(pkg) ? ' · 💬 messages' : ''}${blocked ? ' · blocked (codes and passwords)' : ''}`,
      !blocked && p.apps.includes(pkg),
      (on) => {
        const cur = priv();
        setPriv({ apps: on ? [...new Set([...cur.apps, pkg])] : cur.apps.filter((x) => x !== pkg), labels: { ...cur.labels, [pkg]: label } });
      },
      true,
    );
    const input = t.querySelector('input');
    input.dataset.pkg = pkg;
    input.disabled = blocked;
    list.append(t);
  }
  sec.append(list, el('div', 'row gap-sm wrap'));
  sec.lastChild.append(button('↻ Refresh', () => render()));
  sec.append(toggle('priv-codes', 'Show one-time codes to the assistant (off: a code such as 123456 near “code”, “OTP” or “verification” becomes [code hidden], in notifications and texts)', p.showCodes, (on) => setPriv({ showCodes: on }), true));
  box.append(sec);
}

function messagesSection(box) {
  const p = priv();
  const sec = el('div', 'priv-sec');
  sec.append(toggle('priv-messages', '✉ Text messages & call log (read only)', p.messages, (on) => setPriv({ messages: on })));
  sec.append(el('p', 'hint', 'What is read: text messages (SMS) matching what the assistant searches for, and your recent calls (number, name from your contacts, time, length). It asks you EVERY time, showing what it searches for, and Android asks for its permission once. At most 20 messages, each cut to 300 characters; one-time codes hidden. Never in scheduled checks, triggers, automation runs or by helper agents. It cannot send, reply or delete anything. Where it goes: to your AI provider, as part of the chat. Android 15 may treat the SMS permission as a restricted setting for apps installed from a file – then App info › ⋮ › “Allow restricted settings” first.'));
  box.append(sec);
}

async function placesSection(box) {
  const p = priv();
  const sec = el('div', 'priv-sec');
  sec.append(
    toggle('priv-places', '📍 Place triggers (when I arrive at / leave a place)', p.places, (on) => {
      setPriv({ places: on });
      render();
    }),
  );
  sec.append(el('p', 'hint', `What it does: the assistant can set up a task that runs when you arrive at or leave a place (at least 100 m around it, at most ${MAX_PLACES} places, each asked to you first; a quiet check, at most ${PER_HOUR} runs an hour). Android watches the places itself (its own proximity alerts – no Google services); Chronicle learns only “arrived” or “left”, not where you are. The place and that event go to your AI provider when the task runs. Battery: Android checks your position more often the closer you are to a place – expect some extra battery use while any place trigger is set, and alerts that come a few minutes late.`));
  if (!p.places) return box.append(sec);
  const st = await call(Geofence, 'status');
  const need = el('p', 'hint', 'Needs your location “Allow all the time” (and precise location). Android 10 asks in a dialog. Android 11 and newer only allow it on the settings page: tap the button, then Location › “Allow all the time”, and switch on “Use precise location”. If no page opens (Android stops asking after two refusals), use App info › Permissions › Location.');
  const row = el('div', 'row gap-sm wrap');
  const bg = !!st?.background;
  row.append(el('span', bg ? 'dim' : 'warn-text', bg ? '✓ Location in the background: allowed' : `⚠ Location in the background: not allowed${st?.fine === false ? ' (nor precise location)' : ''}`));
  if (!bg)
    row.append(
      button(`Allow “${st?.label || 'Allow all the time'}”…`, async () => {
        await call(Geofence, 'askBackground');
        render();
      }, 'priv-ask-bg'),
      button('App info', () => call(Geofence, 'openAppInfo')),
    );
  if (st?.locationOn === false) sec.append(el('p', 'warn-text', '⚠ Location is switched off on the phone: place triggers cannot fire.'));
  const n = (state.convs || []).reduce((k, c) => k + (c.schedules || []).filter((t) => t.when?.place).length, 0);
  sec.append(need, row, el('p', 'hint', n ? `${n} place trigger${n === 1 ? '' : 's'} set – see ⏰ Scheduled tasks.` : 'No place trigger is set yet. Ask the assistant e.g. “when I get home, remind me to water the plants”.'));
  box.append(sec);
}

let rendering = null;
async function render() {
  const box = $('#private-body');
  if (!box) return;
  const mine = (rendering = {});
  const frag = document.createDocumentFragment();
  if (Notify) await notifySection(frag);
  if (Messages) messagesSection(frag);
  if (Geofence) await placesSection(frag);
  if (rendering !== mine) return; // a newer one started meanwhile
  box.replaceChildren(frag);
}
function openPrivate() {
  openSheet('#private-sheet', true);
  render();
}
hooks.openPrivate = openPrivate;
// back from Android's settings page: show what changed
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && $('#private-sheet')?.classList.contains('open')) render();
});
