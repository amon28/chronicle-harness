// The app's own error log (decision 177): what went wrong, also when nothing on screen says so – a crash in the app's
// code, a failed reply, a tool error, an error toast that vanished, Claude Code failing to install or start, Android
// refusing background work. Kept on the phone only (localStorage), the newest 500, and only the error text: never the
// message you wrote or a tool's arguments.

const KEY = 'ocm.errlog';
export const MAX = 500;
export const KINDS = { app: 'App', reply: 'Replies', tool: 'Tools', message: 'Messages', claudecode: 'Claude Code', android: 'Android' };

let mem = null; // the log in memory; written back shortly after a change
let timer = null;
const now = () => Date.now();

function load() {
  if (mem) return mem;
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) || '[]');
    mem = Array.isArray(v) ? v : [];
  } catch {
    mem = [];
  }
  return mem;
}
function save() {
  clearTimeout(timer);
  timer = setTimeout(flushLog, 400);
}
/** Write the log now (also on the way to the background). */
export function flushLog() {
  clearTimeout(timer);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(load()));
  } catch {
    // storage full: drop the older half and try once more – the log must never break the app
    try {
      mem = load().slice(-Math.floor(MAX / 2));
      globalThis.localStorage?.setItem(KEY, JSON.stringify(mem));
    } catch {
      /* give up quietly */
    }
  }
}

const clip = (s, n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
// what can identify the user is kept out of the text: API keys and tokens look alike enough to be caught by shape
const scrub = (s) => String(s).replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g, '[secret]').replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}/gi, '$1 [secret]');

/**
 * Log one error. kind: app | reply | tool | message | claudecode | android. extra: { where, conv, title, tool, model }.
 * The same error again within a minute is counted on the entry instead of filling the log.
 */
export function logError(kind, msg, extra = {}) {
  const text = clip(scrub(msg instanceof Error ? msg.message : msg), 600);
  if (!text) return null;
  const list = load();
  const e = { at: now(), kind: KINDS[kind] ? kind : 'app', msg: text };
  for (const k of ['where', 'conv', 'title', 'tool', 'model']) if (extra[k]) e[k] = clip(scrub(extra[k]), k === 'where' ? 300 : 120);
  const last = list.at(-1);
  if (last && last.kind === e.kind && last.msg === e.msg && last.tool === e.tool && last.conv === e.conv && e.at - last.at < 60000) {
    last.n = (last.n || 1) + 1;
    last.at = e.at;
  } else {
    list.push(e);
    if (list.length > MAX) list.splice(0, list.length - MAX);
  }
  save();
  for (const fn of listeners) fn();
  return e;
}

const listeners = new Set();
/** Called after each new entry (the log sheet, when it is open). */
export const onLog = (fn) => (listeners.add(fn), () => listeners.delete(fn));

/** Newest first, optionally only one kind. */
export const readLog = (kind = '') => load().filter((e) => !kind || e.kind === kind).slice().reverse();
export function clearLog() {
  mem = [];
  flushLog();
  for (const fn of listeners) fn();
}

/** Whether a toast reads like an error (it is then logged as a message). */
export const isErrorText = (t) => /\b(fail(ed|s)?|error|could ?n[o']t|cannot|can't|did not|didn't|not allowed|denied|refused|timed? ?out|not found|invalid|unavailable|not running|no longer|stopped by|blocked|too (big|large|long)|went wrong)\b/i.test(String(t || ''));

/** The log as text (copy / export / doctor): one line per entry, newest first. */
export function formatLog(list = readLog(), { limit = MAX } = {}) {
  const d = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  return list
    .slice(0, limit)
    .map((e) => `${d(e.at)}  ${(KINDS[e.kind] || e.kind).padEnd(11)} ${e.tool ? e.tool + ': ' : ''}${e.msg}${e.n > 1 ? ` (×${e.n})` : ''}${e.model ? ` [${e.model}]` : ''}${e.title ? ` – chat “${e.title}”` : ''}${e.where ? `\n    at ${e.where}` : ''}`)
    .join('\n');
}

/** For tests: forget what is in memory (the next read loads from storage). */
export const _resetLogForTest = () => {
  mem = null;
  clearTimeout(timer);
};
