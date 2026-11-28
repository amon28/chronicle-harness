/**
 * android_intent: hand something to another app on the phone – open a page, start a call (dialer only), write a
 * text or email, show a place on the map, add a calendar event, set an alarm or timer, share text, open a
 * settings page or an app. Only these kinds exist, each one opens the other app for the user to finish (nothing
 * is sent or saved by itself), and the user is asked before every one.
 */
const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const SETTINGS_PAGES = { wifi: 'android.settings.WIFI_SETTINGS', bluetooth: 'android.settings.BLUETOOTH_SETTINGS', display: 'android.settings.DISPLAY_SETTINGS', sound: 'android.settings.SOUND_SETTINGS', battery: 'android.intent.action.POWER_USAGE_SUMMARY', location: 'android.settings.LOCATION_SOURCE_SETTINGS', notifications: 'android.settings.ALL_APPS_NOTIFICATION_SETTINGS', apps: 'android.settings.APPLICATION_SETTINGS', date: 'android.settings.DATE_SETTINGS', language: 'android.settings.LOCALE_SETTINGS', accessibility: 'android.settings.ACCESSIBILITY_SETTINGS', storage: 'android.settings.INTERNAL_STORAGE_SETTINGS', developer: 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS', nfc: 'android.settings.NFC_SETTINGS', vpn: 'android.settings.VPN_SETTINGS', this_app: 'android.settings.APPLICATION_DETAILS_SETTINGS' };

export const intentDefs = () => [
  fn(
    'android_intent',
    'Hand something to another app on the phone. kind: open_url (a web page in the browser), dial (opens the dialer with the number – the user presses call), sms (a text ready to send in the messages app), email (a draft in the mail app), map (a place or search on the map), calendar_event (a new event filled in, to save), alarm, timer, share (the share sheet with text), settings (a settings page), open_app (launch an installed app by package name – call list_apps first to find it; list_apps with query narrows the list), deep_link (open an app’s own link, e.g. myapp://screen, homeassistant://navigate, market://details?id=… – url, optionally package to pick the app), share_file (the share sheet with a file from /workspace – path), open_file (open a /workspace file in another app that can show it – path). The other app opens for the user to finish – nothing is sent or saved by itself – and the user is asked first every time.',
    {
      kind: { type: 'string', enum: ['list_apps', 'open_url', 'dial', 'sms', 'email', 'map', 'calendar_event', 'alarm', 'timer', 'share', 'settings', 'open_app', 'deep_link', 'share_file', 'open_file'] },
      path: { type: 'string', description: 'share_file / open_file: a file in /workspace' },
      url: { type: 'string', description: "open_url: an http(s) address; deep_link: the app's link (myapp://…)" },
      to: { type: 'string', description: 'dial / sms: the phone number; email: the address(es), comma-separated' },
      subject: { type: 'string', description: 'email: subject' },
      text: { type: 'string', description: 'sms / email: the message; share: what to share' },
      query: { type: 'string', description: 'map: an address, place or search; list_apps: part of an app name or package' },
      all: { type: 'boolean', description: 'list_apps: also apps without a launcher icon (keyboards, services, system parts)' },
      title: { type: 'string', description: 'calendar_event: the title; alarm / timer: a label' },
      start: { type: 'string', description: 'calendar_event: start, ISO date-time (e.g. 2026-11-14T15:00)' },
      end: { type: 'string', description: 'calendar_event: end, ISO date-time (default an hour after start)' },
      location: { type: 'string', description: 'calendar_event: where' },
      description: { type: 'string', description: 'calendar_event: notes' },
      all_day: { type: 'boolean', description: 'calendar_event: an all-day event' },
      hour: { type: 'integer', description: 'alarm: 0-23' },
      minute: { type: 'integer', description: 'alarm: 0-59' },
      days: { type: 'array', items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }, description: 'alarm: repeat on these days (left out: once, at the next time it comes round)' },
      seconds: { type: 'integer', description: 'timer: length in seconds' },
      page: { type: 'string', enum: Object.keys(SETTINGS_PAGES), description: 'settings: which page' },
      package: { type: 'string', description: 'open_app: the app package from list_apps, e.g. com.spotify.music; deep_link: optionally the app that should open the link' },
    },
    ['kind'],
  ),
];

const PHONE_RX = /^[+\d][\d\s().#*-]{2,30}$/;
const isoMs = (s) => {
  const t = Date.parse(String(s || ''));
  if (!Number.isFinite(t)) throw new Error(`"${s}" is not a date and time (use e.g. 2026-11-14T15:00)`);
  return t;
};

/** The intent to start and how to describe it to the user. Throws on anything outside the allow-list. */
export function buildIntent(a, opts = {}) {
  const k = String(a.kind || '');
  const text = (x, n = 2000) => String(x ?? '').slice(0, n);
  switch (k) {
    case 'deep_link': {
      // an app's own link (decision 276) – testing a deep link, Home Assistant, the store page; the user is asked first
      const u = String(a.url || '').trim();
      const m = /^([a-z][a-z0-9+.-]{1,40}):[^\s]+$/i.exec(u);
      if (!m) throw new Error('deep_link needs a url like myapp://path');
      const sch = m[1].toLowerCase();
      if (['http', 'https'].includes(sch)) throw new Error('deep_link is for an app\'s own scheme – for a web page use open_url');
      if (['file', 'content', 'intent', 'javascript', 'data', 'jar', 'android-app', 'android.resource', 'blob', 'about'].includes(sch)) throw new Error(`deep_link cannot open ${sch}: links – they reach into files or other apps' content`);
      const pkg = String(a.package || '').trim();
      if (pkg && !/^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/.test(pkg)) throw new Error('package must be an app package name like com.example.app');
      return { intent: { action: 'android.intent.action.VIEW', data: u, deepLink: true, ...(pkg ? { package: pkg } : {}) }, summary: `Open this link in ${pkg || 'the app that handles it'}?\n\n${u.slice(0, 300)}` };
    }
    case 'open_url': {
      const u = String(a.url || '');
      if (!/^https?:\/\/[^\s]+$/i.test(u)) throw new Error('open_url needs an http(s) url');
      return { intent: { action: 'android.intent.action.VIEW', data: u }, summary: `Open ${u} in the browser?` };
    }
    case 'dial': {
      const n = String(a.to || '').trim();
      if (!PHONE_RX.test(n)) throw new Error('dial needs a phone number');
      return { intent: { action: 'android.intent.action.DIAL', data: 'tel:' + encodeURIComponent(n) }, summary: `Open the dialer with ${n}? (You press call.)` };
    }
    case 'sms': {
      const n = String(a.to || '').trim();
      if (n && !PHONE_RX.test(n)) throw new Error('sms needs a phone number');
      return { intent: { action: 'android.intent.action.SENDTO', data: 'smsto:' + encodeURIComponent(n), extras: { sms_body: text(a.text) } }, summary: `Write a text${n ? ' to ' + n : ''}?\n\n“${text(a.text, 300)}”\n\n(It opens in Messages – you press send.)` };
    }
    case 'email': {
      const to = String(a.to || '').trim();
      if (to && !/^[^\s@,]+@[^\s@,]+(\s*,\s*[^\s@,]+@[^\s@,]+)*$/.test(to)) throw new Error('email: "to" must be email addresses');
      const q = new URLSearchParams();
      if (a.subject) q.set('subject', text(a.subject, 300));
      if (a.text) q.set('body', text(a.text, 8000));
      return { intent: { action: 'android.intent.action.SENDTO', data: `mailto:${to.split(/\s*,\s*/).map(encodeURIComponent).join(',')}${q.toString() ? '?' + q.toString().replace(/\+/g, '%20') : ''}` }, summary: `Draft an email${to ? ' to ' + to : ''}${a.subject ? ` – “${text(a.subject, 120)}”` : ''}? (It opens in your mail app – you press send.)` };
    }
    case 'map': {
      const qy = String(a.query || '').trim();
      if (!qy) throw new Error('map needs a query');
      return { intent: { action: 'android.intent.action.VIEW', data: 'geo:0,0?q=' + encodeURIComponent(qy.slice(0, 300)) }, summary: `Show “${qy.slice(0, 120)}” on the map?` };
    }
    case 'calendar_event': {
      if (!a.title) throw new Error('calendar_event needs a title');
      const begin = isoMs(a.start);
      const end = a.end ? isoMs(a.end) : begin + 3600e3;
      if (end < begin) throw new Error('The event ends before it starts');
      const extras = { title: text(a.title, 200), beginTime: begin, endTime: end };
      if (a.location) extras.eventLocation = text(a.location, 300);
      if (a.description) extras.description = text(a.description);
      if (a.all_day) extras.allDay = true;
      const when = new Date(begin).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return { intent: { action: 'android.intent.action.INSERT', data: 'content://com.android.calendar/events', extras }, summary: `Add “${extras.title}” on ${when} to your calendar? (You check it and save.)` };
    }
    case 'alarm': {
      const h = Number(a.hour);
      const m = Number(a.minute ?? 0);
      if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) throw new Error('alarm needs hour 0-23 and minute 0-59');
      // which day it rings, said in the question and the result (decision 270): a 7:00 asked for at 8 in the morning is
      // tomorrow's, and "an alarm for 07:00" read as today
      const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const days = [...new Set((Array.isArray(a.days) ? a.days : []).map((d) => String(d).toLowerCase().slice(0, 3)))].filter((d) => DAYS.includes(d));
      const NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
      const now = new Date(opts.now ?? Date.now());
      const at = new Date(now);
      at.setHours(h, m, 0, 0);
      if (at <= now) at.setDate(at.getDate() + 1);
      const day = at.toDateString() === now.toDateString() ? 'today' : 'tomorrow';
      const when = days.length ? `every ${days.length === 7 ? 'day' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].filter((d) => days.includes(d)).map((d) => NAMES[d]).join(', ')}` : `${day}, ${at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;
      return { intent: { action: 'android.intent.action.SET_ALARM', extras: { 'android.intent.extra.alarm.HOUR': h, 'android.intent.extra.alarm.MINUTES': m, ...(days.length ? { 'android.intent.extra.alarm.DAYS': days.map((d) => DAYS.indexOf(d) + 1) } : {}), ...(a.title ? { 'android.intent.extra.alarm.MESSAGE': text(a.title, 100) } : {}) } }, summary: `Set an alarm for ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${when}${a.title ? ` (“${text(a.title, 60)}”)` : ''}?` };
    }
    case 'timer': {
      const sec = Number(a.seconds);
      if (!Number.isInteger(sec) || sec < 1 || sec > 86400) throw new Error('timer needs seconds, 1 to 86400');
      const fmt = sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : sec >= 60 ? `${Math.floor(sec / 60)} min${sec % 60 ? ` ${sec % 60} s` : ''}` : `${sec} s`;
      return { intent: { action: 'android.intent.action.SET_TIMER', extras: { 'android.intent.extra.alarm.LENGTH': sec, ...(a.title ? { 'android.intent.extra.alarm.MESSAGE': text(a.title, 100) } : {}) } }, summary: `Start a ${fmt} timer${a.title ? ` (“${text(a.title, 60)}”)` : ''}?` };
    }
    case 'share': {
      if (!String(a.text || '').trim()) throw new Error('share needs text');
      return { intent: { action: 'android.intent.action.SEND', type: 'text/plain', extras: { 'android.intent.extra.TEXT': text(a.text, 20000) }, chooser: true }, summary: `Share this?\n\n“${text(a.text, 300)}”` };
    }
    case 'settings': {
      const p = SETTINGS_PAGES[a.page];
      if (!p) throw new Error(`settings needs page: ${Object.keys(SETTINGS_PAGES).join(', ')}`);
      return { intent: { action: p, ...(a.page === 'this_app' ? { data: 'package:self' } : {}) }, summary: `Open the ${a.page.replace('_', ' ')} settings?` };
    }
    case 'open_app': {
      const pkg = String(a.package || '').trim();
      if (!/^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/.test(pkg)) throw new Error('open_app needs a package name like com.spotify.music');
      return { intent: { launch: pkg }, summary: `Open the app ${pkg}?` };
    }
    default:
      throw new Error(`Unknown kind "${k}"`);
  }
}

/** ctx.ask(question, options), ctx.intents.start(intent) → { ok, result, display } */
const appListOk = new Set(); // chats where you allowed the assistant to see your apps
export async function runIntentTool(args, ctx) {
  if (args?.kind === 'list_apps') {
    if (!ctx.intents?.apps) return { ok: false, result: 'The list of apps is only available in the Android app.', display: { error: 'unavailable' } };
    if (!appListOk.has(ctx.convId || '')) {
      if (!ctx.ask) return { ok: false, result: 'Seeing your apps needs your approval, which is not available here.', display: { error: 'unavailable' } };
      const yes = 'Show my apps';
      const ans = await ctx.ask('Let the assistant see the names of the apps on your phone (to open the right one)?', [yes, 'Not now'], ctx.signal);
      if (ans !== yes) return { ok: false, result: `The user said no (${ans}).`, display: { error: 'declined', path: 'list_apps' } };
      appListOk.add(ctx.convId || '');
    }
    ctx.onStatus?.('Waiting for Android…');
    const { apps = [] } = await ctx.intents.apps({ query: String(args.query || ''), ...(args.all ? { all: true } : {}) });
    return { ok: true, result: apps.length ? apps.map((a) => `${a.name} – ${a.package}`).join('\n') : `No app matches ${JSON.stringify(args.query || '')}. (Chronicle itself is never listed: it is the app you are running in.)`, display: { path: `list_apps${args.query ? ' ' + args.query : ''}`, count: apps.length } };
  }
  if (args?.kind === 'share_file' || args?.kind === 'open_file') return fileIntent(args, ctx);
  let b;
  try {
    b = buildIntent(args || {});
  } catch (e) {
    return { ok: false, result: `FAILED: ${e.message}`, display: { error: e.message.slice(0, 80) } };
  }
  if (!ctx.intents) return { ok: false, result: 'Other apps can only be opened in the Android app.', display: { error: 'unavailable' } };
  if (!ctx.ask) return { ok: false, result: 'Opening another app needs your approval, which is not available here.', display: { error: 'unavailable' } };
  ctx.onStatus?.('waiting for your approval…');
  const yes = 'Open it';
  const ans = await ctx.ask(b.summary, [yes, 'Not now'], ctx.signal);
  if (ans !== yes) return { ok: false, result: `The user said no (${ans}).`, display: { error: 'declined', path: args.kind } };
  let started;
  try {
    ctx.onStatus?.('Waiting for Android…');
    started = await ctx.intents.start({ ...b.intent, title: String(b.summary || '').slice(0, 80) });
  } catch (e) {
    const m = String(e?.message || e);
    return { ok: false, result: /no app|ActivityNotFound/i.test(m) ? `No app on this phone can do that (${args.kind}).` : `FAILED: ${m}`, display: { error: m.slice(0, 80) } };
  }
  // in the background Android does not let an app open another one: it waits in a notification instead
  if (started?.notified) return { ok: true, result: `Chronicle is in the background, so Android did not open it: a notification asks the user to tap it (${args.kind}). Say so; do not assume it was opened, sent or saved.`, display: { path: `${args.kind} – waiting in a notification` } };
  const what = args.kind === 'alarm' ? ` – ${b.summary.replace(/^Set an alarm for /, 'an alarm for ').replace(/\?$/, '')}` : '';
  return { ok: true, result: `Opened (${args.kind}${what}). The user finishes it in the other app – do not assume it was sent or saved.`, display: { path: args.kind } };
}

const FILE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', csv: 'text/csv', json: 'application/json', html: 'text/html', htm: 'text/html', txt: 'text/plain', md: 'text/markdown', zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', epub: 'application/epub+zip', xml: 'text/xml', py: 'text/x-python', js: 'text/javascript', css: 'text/css', apk: '' };
export const MAX_SHARE_BYTES = 50 * 1024 * 1024;
const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** share_file / open_file: a file of the chat's workspace goes to another app (through the app's file provider). */
async function fileIntent(args, ctx) {
  const kind = args.kind;
  const bad = (m) => ({ ok: false, result: `FAILED: ${m}`, display: { error: m.slice(0, 80), path: kind } });
  const path = String(args.path || '').replace(/^\/?workspace\//, '').replace(/^\/+/, '');
  if (!path || path.split('/').includes('..')) return bad(`${kind} needs path: a file in /workspace`);
  const f = ctx.workspace?.files?.[path];
  if (!f) return bad(`${path} is not in the workspace (list_files shows what is)`);
  const name = path.split('/').pop().replace(/[^\w.() +-]/g, '_').slice(0, 100) || 'file';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (ext === 'apk') return bad("an app cannot be installed or handed over from here. To install it, the user copies it to the phone's Download folder (phone_write from_workspace, or cp to /sdcard/Download in the shell when storage access is on) and opens it from the Files app – Android then asks them itself");
  if (f.data.byteLength > MAX_SHARE_BYTES) return bad(`${path} is ${sizeText(f.data.byteLength)} – too big to hand to another app from here (limit ${sizeText(MAX_SHARE_BYTES)})`);
  if (!ctx.intents?.file) return { ok: false, result: 'Files can only be handed to other apps in the Android app.', display: { error: 'unavailable' } };
  if (!ctx.ask) return { ok: false, result: 'Opening another app needs your approval, which is not available here.', display: { error: 'unavailable' } };
  ctx.onStatus?.('waiting for your approval…');
  const yes = 'Open it';
  const summary = kind === 'share_file' ? `Share ${name} (${sizeText(f.data.byteLength)}) with another app?` : `Open ${name} in another app?`;
  const ans = await ctx.ask(summary, [yes, 'Not now'], ctx.signal);
  if (ans !== yes) return { ok: false, result: `The user said no (${ans}).`, display: { error: 'declined', path: kind } };
  let started;
  try {
    ctx.onStatus?.('Waiting for Android…');
    started = await ctx.intents.file({ name, mime: FILE_MIME[ext] || 'application/octet-stream', mode: kind === 'share_file' ? 'send' : 'view', title: summary.slice(0, 80), bytes: f.data });
  } catch (e) {
    const m = String(e?.message || e);
    return { ok: false, result: /no app|ActivityNotFound/i.test(m) ? `No app on this phone can ${kind === 'share_file' ? 'take' : 'open'} ${name}.` : `FAILED: ${m}`, display: { error: m.slice(0, 80), path: kind } };
  }
  if (started?.notified) return { ok: true, result: `Chronicle is in the background, so Android did not open it: a notification asks the user to tap it (${kind} ${name}). Say so; do not assume it was opened or sent.`, display: { path: `${kind} ${name} – waiting in a notification` } };
  return { ok: true, result: kind === 'share_file' ? `The share sheet is open with ${name}. The user picks the app and finishes there – do not assume it was sent.` : `Opened ${name} in another app.`, display: { path: `${kind} ${name}` } };
}
