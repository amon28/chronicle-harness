// The chat list by time, like a chat app's drawer: Today, Yesterday, 7 Days, 30 Days, then months, then years.
// Pure (the clock and the locale are passed in), so it is tested with a fixed "now".

/** When a chat was last used: its last change, or when it was made. */
export const convTime = (c) => Number(c?.updatedAt) || Number(c?.createdAt) || 0;

const DAY_NAMES = ['Today', 'Yesterday', '7 Days', '30 Days'];
const midnight = (y, m, d) => new Date(y, m, d).getTime(); // local time: a DST day is still one day

/**
 * The group a time falls in, seen from `now`. → { key, label }
 * Days count in local calendar days (Yesterday = the calendar day before today, not "24 hours ago"); a time in the
 * future (another phone's clock) counts as today. Months are used for the last 12 months, years before that.
 */
// one formatter per kind and language, made once: making one per row cost about a third of drawing the chat list (258)
const FMT = { my: { month: 'short', year: 'numeric' }, hm: { hour: 'numeric', minute: '2-digit' }, wd: { weekday: 'short' }, dm: { day: 'numeric', month: 'short' } };
const fmts = new Map();
function dateFmt(locale, kind) {
  const key = `${locale || ''}|${kind}`;
  let f = fmts.get(key);
  if (!f) fmts.set(key, (f = new Intl.DateTimeFormat(locale, FMT[kind])));
  return f;
}

export function timeGroup(t, now = Date.now(), locale) {
  const n = new Date(now);
  const [y, m, d] = [n.getFullYear(), n.getMonth(), n.getDate()];
  const bounds = [midnight(y, m, d), midnight(y, m, d - 1), midnight(y, m, d - 6), midnight(y, m, d - 29)];
  for (let i = 0; i < bounds.length; i++) if (t >= bounds[i]) return { key: ['today', 'yesterday', 'week', 'month'][i], label: DAY_NAMES[i] };
  const at = new Date(t || 0);
  const monthsAgo = (y - at.getFullYear()) * 12 + (m - at.getMonth());
  if (t > 0 && monthsAgo < 12) {
    return { key: `m${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`, label: dateFmt(locale, 'my').format(at) };
  }
  if (!(t > 0)) return { key: 'y0', label: 'Older' };
  return { key: `y${at.getFullYear()}`, label: String(at.getFullYear()) };
}

/** Chats → [{ key, label, items }] newest group first, each group newest chat first. */
export function groupConvs(convs, now = Date.now(), locale) {
  const sorted = [...convs].sort((a, b) => convTime(b) - convTime(a));
  const groups = [];
  for (const c of sorted) {
    const g = timeGroup(convTime(c), now, locale);
    const last = groups[groups.length - 1];
    if (last?.key === g.key) last.items.push(c);
    else groups.push({ ...g, items: [c] });
  }
  return groups;
}

/** A short, quiet time for a row: "14:05" today, "Mon" in the last 7 days, "12 Oct" before that. */
export function shortTime(t, now = Date.now(), locale) {
  if (!(t > 0)) return '';
  const n = new Date(now);
  const today = midnight(n.getFullYear(), n.getMonth(), n.getDate());
  const at = new Date(t);
  if (t >= today) return dateFmt(locale, 'hm').format(at);
  if (t >= midnight(n.getFullYear(), n.getMonth(), n.getDate() - 6)) return dateFmt(locale, 'wd').format(at);
  return dateFmt(locale, 'dm').format(at); // the year is in the group's header
}
