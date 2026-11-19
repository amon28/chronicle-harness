// Context management for long agent chats, without a model call (decision 147):
//  - structuredRecord: compaction by extraction – the user's messages verbatim, files touched, commands run, the
//    to-do list, errors, URLs and a short list of the tool calls, built deterministically from the folded messages;
//  - deadWeight: at send time, results that a later call made stale (the same call again, a file read before it was
//    changed) and the large arguments of old failed calls are sent as one-line stubs. Stored messages never change;
//  - todoNote: the open to-do list / approved plan, put back in front of the model after a compaction and every
//    TODO_EVERY tool rounds of a long run.
// Pure functions; engine.js wires them in.

export const COMPACT_STYLES = [
  ['summary', 'Summary (a model writes it)'],
  ['structured', 'Structured (no model call)'],
  ['both', 'Structured + short summary'],
];
/** The style a chat compacts with: roleplays always keep the model summary (they slide anyway, see contextLimit). */
export const compactStyleOf = (pref, { rp = false } = {}) => (rp || !COMPACT_STYLES.some(([k]) => k === pref) ? 'summary' : pref);

const parse = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  try {
    const a = JSON.parse(raw || '{}');
    return a && typeof a === 'object' ? a : {};
  } catch {
    return {};
  }
};
const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const cleanPath = (p) => String(p || '').trim().replace(/^\/?workspace\//, '').replace(/^\.\//, '');

/** The one argument that says what a call was about (a path, a command, a URL, a query). */
export function keyArg(name, raw) {
  const a = parse(raw);
  if (name === 'shell') return a.command || '';
  if (name === 'run_python') return (String(a.code || '').split('\n').find((l) => l.trim() && !/^(import|from)\s/.test(l)) || '').trim();
  if (name === 'web_search') return a.query || '';
  if (name === 'fetch_url') return (a.urls || (a.url ? [a.url] : [])).join(', ');
  if (name === 'browser') return [a.action, a.url || a.selector || a.text].filter(Boolean).join(' ');
  if (name === 'move_file') return `${a.from || ''} → ${a.to || ''}`;
  if (name === 'apply_patch') return patchFiles(a.patch).map((f) => f.path).join(', ');
  if (name === 'todo_write') return `${(a.items || []).length} items`;
  if (name === 'read_chat') return a.id || '';
  return a.path || a.name || a.action || a.id || '';
}

/** The files a patch touches: [{ path, op }] with op add / update / delete (a move adds the destination). */
function patchFiles(patch) {
  const out = [];
  const s = String(patch || '');
  for (const m of s.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) out.push({ path: cleanPath(m[2]), op: m[1].toLowerCase() });
  for (const m of s.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.push({ path: cleanPath(m[1]), op: 'add' });
  if (!out.length) for (const m of s.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) if (m[1].trim() !== '/dev/null') out.push({ path: cleanPath(m[1]), op: 'update' });
  return out;
}

/** The calls of messages[from, to), in order, with where each one sits. */
function callsOf(messages, from, to) {
  const out = [];
  for (let mi = Math.max(0, from); mi < Math.min(to, messages.length); mi++) {
    const m = messages[mi];
    if (m?.role !== 'assistant') continue;
    (m.rounds || []).forEach((r, ri) => (r.calls || []).forEach((c, ci) => out.push({ c, mi, key: `${mi}:${ri}:${ci}` })));
  }
  return out;
}
const okOf = (c) => c.status === 'done' || (c.status == null && !/^(Error|Failed)\b/i.test(String(c.result || '')));
// writes that went through: a syntax problem still saves the file ("Wrote, but it does not parse", "saved as patched")
const wrote = (c) => okOf(c) || /^Wrote\b|saved as (written|patched)/.test(String(c.result || ''));

/** The paths a call changed: [{ path, op }] (op create / change / delete). */
function fileChanges(c) {
  if (!wrote(c)) return [];
  const a = parse(c.arguments);
  const res = String(c.result || '');
  if (c.name === 'write_file') return a.path ? [{ path: cleanPath(a.path), op: c.display?.diff || /replaced an existing file/.test(res) ? 'change' : 'create' }] : [];
  if (c.name === 'edit_file') return a.path ? [{ path: cleanPath(a.path), op: 'change' }] : [];
  if (c.name === 'delete_file') return a.path ? [{ path: cleanPath(a.path), op: 'delete' }] : [];
  if (c.name === 'move_file') return [...(a.copy ? [] : [{ path: cleanPath(a.from), op: 'delete' }]), { path: cleanPath(a.to), op: 'create' }].filter((x) => x.path);
  if (c.name === 'apply_patch') return patchFiles(a.patch).map((f) => ({ path: f.path, op: f.op === 'add' ? 'create' : f.op === 'delete' ? 'delete' : 'change' }));
  return [];
}

// ---------- the to-do list / plan note ----------
export const TODO_EVERY = 12; // a long run sees its open list again every 12 tool rounds

/** '' when there is no open list; else a short note with the to-do list (and the approved plan being carried out). */
export function todoNote(todos, plan) {
  const t = Array.isArray(todos) ? todos.filter((x) => x?.text) : [];
  const open = t.some((x) => x.status !== 'done');
  const steps = plan?.status === 'approved' && Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : [];
  const planOpen = steps.length > 0 && (!t.length || open);
  if (!open && !planOpen) return '';
  const lines = ['[Reminder – where the work stands. Carry on from here; keep the list up to date with todo_write.]'];
  if (planOpen) lines.push(`Approved plan${plan.title ? ` "${oneLine(plan.title, 120)}"` : ''}:`, ...steps.slice(0, 20).map((s, i) => `${i + 1}. ${oneLine(s, 200)}`));
  if (open) lines.push('To-do list:', ...t.map((x) => `- [${x.status === 'done' ? 'x' : x.status === 'in_progress' ? '>' : ' '}] ${oneLine(x.text, 200)}`));
  return lines.join('\n');
}

/** The note a round of a long run carries: the open list after every TODO_EVERY-th round with tool calls, else ''. */
export const roundTodoNote = (rounds, todos, plan) => {
  const n = (rounds || []).filter((r) => r.calls?.length).length;
  return n > 0 && n % TODO_EVERY === 0 ? todoNote(todos, plan) : '';
};

// ---------- compaction by extraction ----------
export const USER_CLIP = 1500; // a longer user message is clipped (the whole one stays readable with read_chat)
const USERS_MAX = 14000; // all user messages together; beyond that the oldest are named, not quoted
const STEPS_MAX = 5000;
const REPLY_CLIP = 300;
export const RECORD_MAX = 40000; // the whole record; a smaller maxChars (a model that refused a long request) shrinks every part

/**
 * The structured record of messages[from, to): what a model summary would have to keep, taken out verbatim.
 * Deterministic: the same messages and list give the same text. `prev` is an earlier summary (kept in front, clipped).
 */
export function structuredRecord(messages, opts = {}) {
  const max = Math.max(1500, Number(opts.maxChars) || RECORD_MAX);
  let text = '';
  for (const k of [1, 0.5, 0.25, 0.12, 0.05]) {
    text = buildRecord(messages, opts, { userClip: Math.max(200, Math.round(USER_CLIP * Math.sqrt(k))), users: USERS_MAX * k, steps: STEPS_MAX * k, reply: Math.max(80, Math.round(REPLY_CLIP * Math.sqrt(k))), prev: 12000 * k, list: Math.max(3, Math.round(30 * k)) });
    if (text.length <= max) return text;
  }
  return `${text.slice(0, max - 120)}\n… [record cut to fit – read_chat with id "this" reads the messages themselves]`;
}

function buildRecord(messages, { from = 0, to = messages.length, todos = null, plan = null, goal = null, focus = '', prev = '', nameOf = null }, L) {
  const users = [];
  const replies = [];
  const files = new Map(); // path → last op
  const commands = [];
  const errors = [];
  const urls = [];
  const searches = [];
  const steps = [];
  const readMore = (i) => `read_chat with id "this" and from=${i} shows it in full`;
  for (let mi = Math.max(0, from); mi < Math.min(to, messages.length); mi++) {
    const m = messages[mi];
    if (!m || m.hidden) continue;
    if (m.role === 'user') {
      const text = String(m.content || '');
      const clip = text.length > L.userClip ? `${text.slice(0, L.userClip)}… [${text.length - L.userClip} more chars – ${readMore(mi)}]` : text;
      const extra = [m.images?.length ? `${m.images.length} image${m.images.length === 1 ? '' : 's'}${m.imagePaths?.length ? ` (${m.imagePaths.join(', ')})` : ''}` : '', ...(m.files || []).map((f) => `attached ${f.name}`), ...(m.atFiles || []).map((f) => `@${f.path || f.name || f}`)].filter(Boolean);
      users.push({ mi, line: `#${mi}: ${clip.trim() || '(no text)'}${extra.length ? ` [${extra.join(', ')}]` : ''}` });
      continue;
    }
    if (m.role !== 'assistant') continue;
    const who = nameOf?.(m) || '';
    const said = String(m.content || '').trim();
    if (said) replies.push(`#${mi}${who ? ` ${who}` : ''}: ${oneLine(said, L.reply)}`);
    if (m.error) errors.push(`#${mi} the reply stopped: ${oneLine(m.error, 200)}`);
    const parts = [];
    for (const r of m.rounds || [])
      for (const c of r.calls || []) {
        const ok = okOf(c);
        const arg = oneLine(keyArg(c.name, c.arguments), 80);
        parts.push(`${c.name}${arg ? ` ${arg}` : ''} ${c.status === 'cancelled' ? '(cancelled)' : ok ? '✓' : '✗'}`);
        for (const f of fileChanges(c)) {
          const was = files.get(f.path);
          // created then changed is still "created"; created then deleted is gone (deleted)
          files.set(f.path, was === 'create' && f.op === 'change' ? 'create' : f.op);
        }
        const res = String(c.result || '');
        if (c.name === 'shell' || c.name === 'run_python') {
          const exit = /exit code (-?\d+)/.exec(res)?.[1];
          const how = /^TIMED OUT/.test(res) ? 'timed out' : /\[still running after \d+ s - job /.test(res) ? 'started as a job' : exit != null ? `exit ${exit}${ok ? '' : ', failed'}` : ok ? 'ok' : 'failed';
          commands.push(`#${mi} ${c.name === 'shell' ? '$' : 'python:'} ${oneLine(keyArg(c.name, c.arguments), 160)} → ${how}`);
        }
        if (!ok && c.status !== 'cancelled') errors.push(`#${mi} ${c.name}${arg ? ` ${arg}` : ''}: ${oneLine(String(c.display?.error || res).replace(/^Error:\s*/i, '').split('\n').find((l) => l.trim()) || 'failed', 240)}`);
        const a = parse(c.arguments);
        if (c.name === 'fetch_url') for (const u of a.urls || (a.url ? [a.url] : [])) urls.push(`${oneLine(u, 200)}${ok ? '' : ' (failed)'}`);
        if (c.name === 'browser' && a.url && /^(open|navigate|goto)$/.test(String(a.action || ''))) urls.push(`${oneLine(a.url, 200)} (browser)${ok ? '' : ' (failed)'}`);
        if (c.name === 'web_search' && a.query) searches.push(oneLine(a.query, 120));
      }
    if (parts.length) steps.push(`#${mi}: ${parts.join(' · ')}`);
  }

  const out = [`[Structured record of messages #${from}–#${Math.max(from, to - 1)}, taken from the chat as it was (no summary was written). The original messages are kept: read_chat with id "this" reads them, tool results included.]`];
  if (prev?.trim()) out.push(`## Earlier record\n${prev.length > L.prev ? '… ' + prev.slice(-L.prev) : prev}`);
  if (goal?.text) out.push(`## Goal (${goal.status || 'active'})\n${oneLine(goal.text, 600)}`);
  if (focus?.trim()) out.push(`## The user asked to keep in particular\n${oneLine(focus, 400)}`);
  if (users.length) {
    let size = 0;
    let keepFrom = users.length;
    while (keepFrom > 0 && size + users[keepFrom - 1].line.length <= L.users) size += users[--keepFrom].line.length + 1;
    if (keepFrom === users.length) keepFrom = users.length - 1; // the newest one, at least
    // the first message usually says what the whole task is: it is always quoted, then the newest that fit
    const first = keepFrom > 0 ? users[0].line + '\n' : '';
    const left = users.slice(first ? 1 : 0, keepFrom);
    out.push(`## What the user said (verbatim)\n${first}${left.length ? `[${left.length} earlier message${left.length === 1 ? '' : 's'} (#${left.map((u) => u.mi).join(', #')}) not quoted – read_chat with id "this" shows them]\n` : ''}${users.slice(keepFrom).map((u) => u.line).join('\n')}`);
  }
  if (files.size) {
    const by = (op) => [...files].filter(([, o]) => o === op).map(([p]) => p);
    out.push(['## Files', by('create').length && `created: ${by('create').join(', ')}`, by('change').length && `changed: ${by('change').join(', ')}`, by('delete').length && `deleted: ${by('delete').join(', ')}`].filter(Boolean).join('\n'));
  }
  if (commands.length) out.push(`## Commands run\n${(commands.length > L.list ? [`[${commands.length - L.list} earlier commands not listed]`, ...commands.slice(-L.list)] : commands).join('\n')}`);
  if (errors.length) out.push(`## Errors seen\n${(errors.length > L.list ? [`[${errors.length - L.list} earlier errors not listed]`, ...errors.slice(-L.list)] : errors).join('\n')}`);
  if (urls.length || searches.length) out.push(['## Read on the web', ...[...new Set(urls)].slice(-L.list), searches.length && `searched: ${[...new Set(searches)].slice(-15).join(' | ')}`].filter(Boolean).join('\n'));
  if (steps.length) {
    let size = 0;
    let k = steps.length;
    while (k > 0 && size + steps[k - 1].length <= L.steps) size += steps[--k].length + 1;
    out.push(`## Tool calls (✓ ok, ✗ failed)\n${k ? `[${k} earlier steps not listed]\n` : ''}${steps.slice(k).join('\n')}`);
  }
  if (replies.length) out.push(`## What the assistant answered (start of each reply)\n${(replies.length > L.list ? replies.slice(-L.list) : replies).join('\n')}`);
  const note = todoNote(todos, plan);
  if (note) out.push(`## Open to-do list / plan\n${note}`);
  return out.join('\n\n');
}

// ---------- dead weight at send time ----------
export const PRUNE_RECENT = 6; // the newest messages are always sent as they are
export const PRUNE_EVERY = 6; // the line before which pruning applies moves in steps, so the prompt start stays the same between turns
const STUB_MIN = 240; // a result shorter than this is left alone: the stub would save nothing
const ARGS_MAX = 600; // a failed call's arguments longer than this are clipped once 3 turns have passed
const FAILED_TURNS = 3;
const NEVER_STUB = new Set(['ask_user', 'propose_plan', 'view_images', 'take_photo', 'delegate', 'todo_write', 'goal']);
export const STUB_REPEAT = '[Result left out: the same call (same tool, same arguments) was made again later – its newer result is further down.]';
export const stubRead = (path) => `[Result left out: ${path} was changed later in this chat, so this read is out of date – read it again if you need the current text.]`;

/** Messages before this index may be pruned (and only what they say decides it): a step function of the count. */
export const pruneCut = (n) => Math.floor(Math.max(0, n - PRUNE_RECENT) / PRUNE_EVERY) * PRUNE_EVERY;

const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const sigOf = (c) => {
  let a;
  try {
    a = JSON.parse(c.arguments || '{}');
  } catch {
    return `${c.name}\u0000${c.arguments || ''}`;
  }
  return `${c.name}\u0000${canon(a)}`;
};

// ---------- superseded browser snapshots ----------
const SNAP_AT = /(^|\n)Page: [^\n]*\nURL: [^\n]*\nScroll: /;
const EVIDENCE = /\n?[^\n]*\[surface=[^\]]*\][^\n]*\s*$/;
export const STUB_SNAPSHOT = '[Element list and page text left out: newer browser results replaced this page view – open or read the page again if you need it.]';
/** True for a browser result that holds a page snapshot (screenshot / eval / get / query_all results do not). */
export const hasSnapshot = (text) => SNAP_AT.test(String(text ?? ''));

/** A browser result without its element list and page text: notes, Page:/URL: lines and the trailing evidence line stay. */
export function stubSnapshot(text) {
  const t = String(text ?? '');
  const m = SNAP_AT.exec(t);
  if (!m) return t;
  const start = m.index + m[1].length;
  const notes = t.slice(0, start);
  const lines = t.slice(start).split('\n');
  const head = lines.slice(0, 2).join('\n'); // Page: + URL:
  const ev = EVIDENCE.exec(t.slice(start));
  const evidence = ev ? ev[0].replace(/^\n/, '').trim() : '';
  return [notes.trimEnd(), head, STUB_SNAPSHOT, evidence].filter(Boolean).join('\n');
}

/**
 * The indexes (into `calls`, oldest first) of browser results to send as stubs. The newest `keepLast` are always whole;
 * calls leave that window only in groups of `step`, so the set changes in batches and the prompt start stays cacheable.
 * `calls` are the browser calls only. Results without a snapshot are never in the set.
 */
export function supersededBrowser(calls, { keepLast = 3, step = 4 } = {}) {
  const out = new Set();
  const n = (calls || []).length;
  const k = Math.floor(Math.max(0, n - keepLast) / Math.max(1, step)) * Math.max(1, step);
  for (let i = 0; i < k; i++) {
    const c = calls[i];
    if (c && c.status !== 'running' && !c.streaming && hasSnapshot(c.result)) out.add(i);
  }
  return out;
}

/** A failed call's arguments, with every long string clipped – still valid JSON, so every provider takes it. */
export function clipArgs(raw) {
  let a;
  try {
    a = JSON.parse(raw || '{}');
  } catch {
    return JSON.stringify({ clipped: `${String(raw).slice(0, 200)}… [${String(raw).length} chars of arguments of a failed call left out]` });
  }
  const walk = (v) => (typeof v === 'string' ? (v.length > 300 ? `${v.slice(0, 200)}… [${v.length - 200} chars left out – this call failed]` : v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return JSON.stringify(walk(a));
}

/**
 * → { results: Map(key → stub), args: Map(key → clipped arguments) }, key = "message:round:call". Only messages in
 * [from, cut) are looked at, and only what they contain decides, so two requests with the same cut get the same
 * answer – the start of the prompt (and the provider's cache) stays the same until the cut moves on.
 */
export function deadWeight(messages, { from = 0, cut = pruneCut(messages.length) } = {}) {
  const results = new Map();
  const args = new Map();
  if (cut <= from) return { results, args };
  const calls = callsOf(messages, from, cut).filter((x) => !x.c.streaming && x.c.status !== 'running');
  const long = (c) => String(c.result ?? '').length >= STUB_MIN;
  // 1. the same call again: only the newest keeps its result
  const newest = new Map();
  for (const x of calls) newest.set(sigOf(x.c), x);
  for (const x of calls) if (!NEVER_STUB.has(x.c.name) && newest.get(sigOf(x.c)) !== x && long(x.c)) results.set(x.key, STUB_REPEAT);
  // 2. a file read, then changed later: the read is out of date
  const changedLater = new Set();
  for (let i = calls.length - 1; i >= 0; i--) {
    const { c, key } = calls[i];
    if (c.name === 'read_file' && !results.has(key) && long(c)) {
      const p = cleanPath(parse(c.arguments).path);
      if (p && changedLater.has(p)) results.set(key, stubRead(p));
    }
    for (const f of fileChanges(c)) changedLater.add(f.path);
  }
  // 4. browser snapshots that newer ones replaced (in batches, see supersededBrowser)
  const br = calls.filter((x) => x.c.name === 'browser');
  for (const i of supersededBrowser(br.map((x) => x.c))) if (!results.has(br[i].key) && long(br[i].c)) results.set(br[i].key, stubSnapshot(br[i].c.result));
  // 3. the large arguments of a call that failed, once three more turns have passed
  const userAt = [];
  for (let mi = from; mi < cut; mi++) if (messages[mi]?.role === 'user') userAt.push(mi);
  for (const { c, mi, key } of calls) {
    if (okOf(c) || c.status === 'cancelled' || String(c.arguments || '').length <= ARGS_MAX) continue;
    if (userAt.filter((u) => u > mi).length >= FAILED_TURNS) args.set(key, clipArgs(c.arguments));
  }
  return { results, args };
}
