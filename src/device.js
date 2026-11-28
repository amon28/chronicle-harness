/**
 * The phone's own data as tools: calendar (read, and add an event), contacts (read only) and location.
 *
 * Two locks on each: Android's permission (asked by Android the first time), and the user's OK in the chat before
 * the assistant sees any of it (once per chat for reading; every time for adding an event). An approximate location
 * stays approximate – the coordinates are rounded to about a kilometre unless precise location is allowed and asked for.
 */
const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const deviceDefs = () => [
  fn(
    'calendar',
    "The phone's calendar. action list (default): events between from and to (default: the next 7 days), optionally only those matching query; calendars: the calendars on the phone; add: a new event (asks the user first, every time). Times are ISO dates or date-times in the user's local time (2026-11-14 or 2026-11-14T15:00).",
    {
      action: { type: 'string', enum: ['list', 'calendars', 'add'] },
      from: { type: 'string', description: 'list: start (default now)' },
      to: { type: 'string', description: 'list: end (default 7 days after from)' },
      query: { type: 'string', description: 'list: only events whose title, place or notes contain this' },
      limit: { type: 'number', description: 'list: at most this many (default 50)' },
      title: { type: 'string', description: 'add: what it is' },
      start: { type: 'string', description: 'add: when it starts' },
      end: { type: 'string', description: 'add: when it ends (default an hour later, or the same day for all_day)' },
      all_day: { type: 'boolean' },
      location: { type: 'string' },
      notes: { type: 'string' },
      calendar_id: { type: 'number', description: 'add: which calendar (from calendars); default the main one' },
      reminder_minutes: { type: 'number', description: 'add: a reminder this many minutes before' },
    },
  ),
  fn('contacts', "Look up people in the phone's contacts (read only): names with their numbers and email addresses. query is part of a name.", { query: { type: 'string' }, limit: { type: 'number', description: 'at most this many (default 20)' } }),
  fn('location', "Where the phone is now: coordinates, accuracy and the place name when Android can tell it. Approximate (about 1 km) unless precise is true and the user allowed precise location.", { precise: { type: 'boolean', description: 'ask for the exact position (only when the task needs it, e.g. directions)' } }),
];

export const devicePrompt = () =>
  "- calendar, contacts and location read the phone's own data (the user allows each once per chat; Android may ask too). calendar add creates an event after the user agrees – say what you added. Use location only when the answer depends on where the user is (weather, directions), and prefer the approximate one.";

const pad = (n) => String(n).padStart(2, '0');
/** '2026-11-14' → local midnight; a date-time without a zone → local time; anything Date can read. → ms or NaN */
export function parseWhen(s) {
  const t = String(s ?? '').trim();
  if (!t) return NaN;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (d) return new Date(+d[1], +d[2] - 1, +d[3]).getTime();
  return Date.parse(t);
}
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d) => `${DAY[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** One event as a line, in local time. All-day events are stored at midnight UTC, so they are read in UTC. */
export function eventLine(e) {
  if (e.allDay) {
    const s = new Date(e.start);
    const startDay = new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
    const days = Math.max(1, Math.round((e.end - e.start) / 86400000));
    return `${day(startDay)} (all day${days > 1 ? `, ${days} days` : ''}) · ${e.title || '(no title)'}${e.location ? ` · @ ${e.location}` : ''}${e.calendar ? ` · [${e.calendar}]` : ''}`;
  }
  const s = new Date(e.start);
  const en = new Date(e.end);
  const same = s.toDateString() === en.toDateString();
  return `${day(s)} ${hm(s)}–${same ? hm(en) : `${day(en)} ${hm(en)}`} · ${e.title || '(no title)'}${e.location ? ` · @ ${e.location}` : ''}${e.calendar ? ` · [${e.calendar}]` : ''}${e.notes ? `\n    ${e.notes.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
}

const allowed = new Set(); // `${chat}:${what}` the user said yes to in this app run
// …and kept with the chat itself (ctx.deviceOks, decision 270): the OK was asked again after every app restart
async function okOnce(ctx, what, question, yes) {
  const key = `${ctx.convId || ''}:${what}`;
  if (allowed.has(key) || ctx.deviceOks?.has(what)) return null;
  if (!ctx.ask) return { ok: false, result: `Reading the ${what} needs the user's OK, which is not available here.`, display: { error: 'unavailable' } };
  ctx.onStatus?.('waiting for your OK…');
  const ans = await ctx.ask(question, [yes, 'Not now'], ctx.signal);
  if (ans !== yes) return { ok: false, result: `The user said no (${ans}).`, display: { error: 'declined', path: what } };
  allowed.add(key);
  ctx.deviceOks?.add(what);
  return null;
}
/** for tests */
export const forgetDeviceOks = () => allowed.clear();
/** The same once-per-chat OK for the other phone tools (places, Wi-Fi names, phone controls). */
export const deviceOkOnce = okOnce;
export const deviceOkGiven = (ctx, what) => allowed.has(`${ctx.convId || ''}:${what}`) || !!ctx.deviceOks?.has(what);
export const deviceOkGrant = (ctx, what) => {
  allowed.add(`${ctx.convId || ''}:${what}`);
  ctx.deviceOks?.add(what);
};
/** The chat's OKs were taken back (the chat's ✕ on "Allowed in this chat"): this app run's copy goes too. */
export const forgetChatOks = (convId, what = null) => {
  for (const k of [...allowed]) if (k.startsWith(`${convId}:`) && (!what || k === `${convId}:${what}`)) allowed.delete(k);
};
export const deviceFailed = (e, what) => failed(e, what);

const failed = (e, what) => {
  const m = String(e?.message || e);
  const code = e?.code || '';
  if (code === 'DENIED' || /not allow|refused/i.test(m)) return { ok: false, result: `${m} Tell the user how to allow it if they want this; do not try another way around it.`, display: { error: 'not allowed', path: what } };
  return { ok: false, result: `FAILED: ${m}`, display: { error: m.slice(0, 80), path: what } };
};

/** ctx.device: the Device plugin (calendars, events, addEvent, contacts, location); ctx.ask(question, options) */
export async function runDeviceTool(name, args = {}, ctx = {}) {
  const dev = ctx.device;
  if (!dev) return { ok: false, result: "The phone's calendar, contacts and location are only available in the Android app.", display: { error: 'unavailable' } };
  if (name === 'calendar') {
    const action = args.action || 'list';
    if (action === 'add') {
      const start = parseWhen(args.start);
      if (!String(args.title || '').trim() || !Number.isFinite(start)) return { ok: false, result: 'add needs title and start (an ISO date or date-time).', display: { error: 'title and start' } };
      let end = args.end ? parseWhen(args.end) : NaN;
      if (!Number.isFinite(end) || end < start) end = start + (args.all_day ? 86400000 : 3600000);
      const ev = { title: String(args.title).trim().slice(0, 300), start: Math.round(start), end: Math.round(end), allDay: !!args.all_day, location: String(args.location || '').slice(0, 300), notes: String(args.notes || '').slice(0, 4000) };
      const when = args.all_day ? `${day(new Date(start))} (all day)` : `${day(new Date(start))} ${hm(new Date(start))}–${hm(new Date(end))}`;
      if (!ctx.ask) return { ok: false, result: "Adding an event needs the user's OK, which is not available here.", display: { error: 'unavailable' } };
      ctx.onStatus?.('waiting for your OK…');
      const yes = 'Add it';
      const ans = await ctx.ask(`Add to your calendar?\n\n${ev.title}\n${when}${ev.location ? `\n@ ${ev.location}` : ''}${args.reminder_minutes != null ? `\nreminder ${Math.round(args.reminder_minutes)} min before` : ''}`, [yes, 'Not now'], ctx.signal);
      if (ans !== yes) return { ok: false, result: `The user said no (${ans}).`, display: { error: 'declined', path: 'calendar add' } };
      try {
        ctx.onStatus?.('Waiting for Android…');
        const r = await dev.addEvent({ ...ev, ...(args.calendar_id != null ? { calendarId: Math.round(args.calendar_id) } : {}), ...(args.reminder_minutes != null ? { reminderMinutes: Math.max(0, Math.round(args.reminder_minutes)) } : {}) });
        return { ok: true, result: `Added “${ev.title}” on ${when} to the calendar ${r?.calendar || ''} (event ${r?.id}).`, display: { path: `calendar add ${ev.title.slice(0, 40)}` } };
      } catch (e) {
        return failed(e, 'calendar add');
      }
    }
    const no = await okOnce(ctx, 'calendar', 'Let the assistant read your calendar in this chat?', 'Allow');
    if (no) return no;
    try {
      ctx.onStatus?.('Waiting for Android…'); // the first time Android may ask for its own permission too
      if (action === 'calendars') {
        const { calendars = [] } = await dev.calendars();
        return { ok: true, result: calendars.length ? calendars.map((c) => `${c.id}: ${c.name}${c.account && c.account !== c.name ? ` (${c.account})` : ''}${c.primary ? ' – main' : ''}${c.writable ? '' : ' – read only'}`).join('\n') : 'No calendars on this phone.', display: { path: 'calendars', count: calendars.length } };
      }
      const from = Number.isFinite(parseWhen(args.from)) ? parseWhen(args.from) : Date.now();
      let to = Number.isFinite(parseWhen(args.to)) ? parseWhen(args.to) : from + 7 * 86400000;
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(args.to || '').trim())) to += 86400000 - 1; // a date as the end: the whole day
      const limit = Math.max(1, Math.min(200, Math.round(args.limit) || 50));
      // what was really read (decision 270): the phone reads at most a year from the start, and at most `limit` events –
      // both were cut without a word, so "no events in March" could mean "March was not looked at"
      const YEAR = 366 * 86400000;
      const clamped = to - from > YEAR;
      if (clamped) to = from + YEAR;
      const { events = [] } = await dev.events({ from: Math.round(from), to: Math.round(to), query: String(args.query || ''), limit });
      const span = `${day(new Date(from))} – ${day(new Date(to))}`;
      const notes = [clamped && `only one year from the start is read at a time – ask again from ${day(new Date(to))} for later dates`, events.length >= limit && `these are the first ${limit}; more may exist – narrow the dates or the query${limit < 200 ? ', or raise limit (up to 200)' : ''}`].filter(Boolean);
      const tail = notes.length ? `\n[${notes.join('; ')}]` : '';
      return { ok: true, result: events.length ? `${events.length} event${events.length > 1 ? 's' : ''} (${span}):\n${events.map(eventLine).join('\n')}${tail}` : `No events ${args.query ? `matching “${args.query}” ` : ''}in ${span}.${tail}`, display: { path: `calendar ${span}`, count: events.length } };
    } catch (e) {
      return failed(e, 'calendar');
    }
  }
  if (name === 'contacts') {
    const no = await okOnce(ctx, 'contacts', 'Let the assistant look people up in your contacts in this chat?', 'Allow');
    if (no) return no;
    try {
      ctx.onStatus?.('Waiting for Android…');
      const limit = Math.max(1, Math.min(50, Math.round(args.limit) || 20));
      const { contacts = [] } = await dev.contacts({ query: String(args.query || ''), limit });
      const line = (c) => [c.name, ...(c.phones || []).map((p) => `${p.label}: ${p.value}`), ...(c.emails || []).map((m) => `${m.label}: ${m.value}`)].join(' · ');
      const more = contacts.length >= limit ? `\n[the first ${limit}; more may match – a longer query narrows it${limit < 50 ? ', or raise limit (up to 50)' : ''}]` : '';
      return { ok: true, result: contacts.length ? contacts.map(line).join('\n') + more : `No contact matches “${args.query || ''}”.`, display: { path: `contacts ${args.query || ''}`.trim(), count: contacts.length } };
    } catch (e) {
      return failed(e, 'contacts');
    }
  }
  if (name === 'location') {
    const precise = !!args.precise;
    const no = await okOnce(ctx, precise ? 'precise location' : 'location', precise ? 'Share your exact location with the assistant in this chat?' : 'Share your approximate location (about 1 km) with the assistant in this chat?', 'Share');
    if (no) return no;
    try {
      ctx.onStatus?.(precise ? 'Waiting for a fix from Android (GPS can take up to 30 s)…' : 'Asking Android for the location…');
      const r = await dev.location({ precise });
      const age = Math.round((Date.now() - (r.time || Date.now())) / 60000);
      return {
        ok: true,
        result: `${r.address ? `${r.address}\n` : ''}${r.lat}, ${r.lon} (±${r.accuracy} m, ${r.precise ? 'precise' : 'approximate'}${age > 2 ? `, from ${age} min ago` : ''})`,
        display: { path: r.address ? `location ${r.address.slice(0, 40)}` : 'location' },
      };
    } catch (e) {
      return failed(e, 'location');
    }
  }
  return null;
}
