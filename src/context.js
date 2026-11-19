// Keeping a long agent chat inside the model's context without losing what matters:
//  - spill: a huge tool result is saved in full to .out/ and the model gets its start and end plus where the rest is;
//  - prune: old tool results (already acted on) are cut to a short head when they are sent again;
//  - search_chats / read_chat: the assistant can look things up in your earlier chats.
// Pure functions here; tools.js and engine.js wire them in.
import { keyArg } from './foldcontext.js';

export const SPILL_AT = 16000; // a result longer than this is spilled
export const SPILL_KEEP = 12 * 1024; // what the model still sees of it (start + end)
export const SPILL_DIR = '.out';
export const SPILL_FILES = 30; // older spills are deleted

/** → { text, spilled } – the head and tail of a long result, with a pointer to the full file. */
export function spillText(full, path) {
  if (full.length <= SPILL_AT) return { text: full, spilled: false };
  const head = Math.floor(SPILL_KEEP * 0.7);
  const tail = SPILL_KEEP - head;
  const cutHead = full.lastIndexOf('\n', head) > head * 0.8 ? full.lastIndexOf('\n', head) : head;
  const cutTail = full.indexOf('\n', full.length - tail) > 0 && full.indexOf('\n', full.length - tail) < full.length - tail * 0.8 ? full.indexOf('\n', full.length - tail) + 1 : full.length - tail;
  const where = path ? `The full output (${full.length} chars) is saved in ${path} – read parts of it with read_file (start_line / offset) or search it with grep_files (path ".out") instead of running this again.` : `${full.length - (cutHead + full.length - cutTail)} chars were left out.`;
  return { text: `${full.slice(0, cutHead)}\n\n… [${full.length - cutHead - (full.length - cutTail)} chars not shown. ${where}] …\n\n${full.slice(cutTail)}`, spilled: !!path };
}

export const spillName = (tool, now = Date.now()) => {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${SPILL_DIR}/${tool.replace(/[^\w-]+/g, '_').slice(0, 30)}-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 5)}.txt`;
};

/**
 * Spill files beyond the newest SPILL_FILES: → paths to delete. Newest by the file's time (mtimeOf(path)): the name
 * starts with the tool, so sorting names kept 30 old shell-… files and deleted a list_files-… result the moment it
 * was written - while the model was being told to read it. Names decide only between files of the same time.
 */
export const oldSpills = (paths, mtimeOf = () => 0) =>
  paths
    .filter((p) => p.startsWith(SPILL_DIR + '/'))
    .sort((a, b) => (mtimeOf(b) || 0) - (mtimeOf(a) || 0) || (a < b ? 1 : a > b ? -1 : 0))
    .slice(SPILL_FILES);

// ---------- pruning ----------
export const PRUNE_OVER = 1500; // results shorter than this are kept as they are
export const PRUNE_KEEP = 500;
export const KEEP_ROUNDS = 8; // the newest rounds of the reply being written are always sent in full
export const PRUNE_STEP = 10; // rounds are trimmed ten at a time, so the start of the prompt (and the provider's cache) stays the same between steps

const TRIM_HEAD = 300;
const TRIM_TAIL = 150;
const TRIM_LINE = 120;
const TRIM_ERRORS = 3;
const ERROR_LINE = /\b(error|failed|exception|traceback|exit code [1-9]|TIMED OUT|KILLED|not found|denied)\b/i;

/** A trimmed old result: the head, up to 3 error-like lines from the middle, the tail, and a note. Deterministic; body <= ~900 chars. */
export function trimResult(text) {
  const s = String(text ?? '');
  if (s.length <= PRUNE_OVER) return s;
  const evidence = (s.match(/\[surface=[^\]]*\]\s*$/) || [''])[0];
  const body = s.slice(0, s.length - evidence.length).trimEnd();
  const h = body.slice(0, TRIM_HEAD);
  const nl = h.lastIndexOf('\n');
  const head = nl > TRIM_HEAD * 0.6 ? h.slice(0, nl) : h;
  const tailStart = Math.max(head.length, body.length - TRIM_TAIL);
  const tail = body.slice(tailStart).trimStart();
  const errors = body
    .slice(head.length, tailStart)
    .split('\n')
    .filter((l) => ERROR_LINE.test(l))
    .slice(0, TRIM_ERRORS)
    .map((l) => l.trim().slice(0, TRIM_LINE));
  const parts = [head];
  if (errors.length) parts.push('…', ...errors);
  if (tail) parts.push('…', tail);
  return `${parts.join('\n')}\n… [older tool result trimmed: ${s.length} chars – you already used it; call the tool again (or read the file) if you need the details]${evidence ? '\n' + evidence : ''}`;
}

/** How many of the current reply's rounds get trimmed results (0 while the reply is short). */
export const roundsToTrim = (n) => Math.max(0, Math.floor((n - KEEP_ROUNDS) / PRUNE_STEP) * PRUNE_STEP);

/**
 * The index from which messages keep their tool results in full: at least the last `turns` user messages. The line
 * moves in steps of `step` user turns, not at every one (decision 199): moving it trims older results, which changes
 * the prompt from there on and costs the provider's cache – so it is done in batches, a few turns at a time.
 */
export function pruneBoundary(messages, turns = 2, step = 3) {
  const users = [];
  messages.forEach((m, i) => m.role === 'user' && users.push(i));
  const k = users.length - turns;
  if (k <= 0) return 0;
  return users[Math.floor(k / step) * step] ?? 0;
}

// ---------- your earlier chats ----------
const words = (q) => [...new Set(String(q || '').toLowerCase().match(/[\p{L}\p{N}_.-]{2,}/gu) || [])];
const textOfMsg = (m) => [m.content || '', ...(m.rounds || []).map((r) => r.content || '')].join('\n');

/** → [{ id, title, at, score, snippet }] best first. convs: [{ id, title, messages, updatedAt }]. */
export function searchChats(convs, query, { exclude = null, max = 8 } = {}) {
  const terms = words(query);
  if (!terms.length) return [];
  const out = [];
  for (const c of convs) {
    if (c.id === exclude || !c.messages?.length) continue;
    const title = String(c.title || '').toLowerCase();
    let score = 0;
    let best = { n: 0, text: '', at: 0 };
    for (const m of c.messages) {
      const t = textOfMsg(m);
      if (!t) continue;
      const low = t.toLowerCase();
      const n = terms.reduce((k, w) => k + (low.includes(w) ? 1 : 0), 0);
      if (!n) continue;
      score += n;
      if (n > best.n) best = { n, text: t, at: m.at || 0, low };
    }
    score += terms.reduce((k, w) => k + (title.includes(w) ? 3 : 0), 0);
    if (!score) continue;
    const all = terms.every((w) => title.includes(w) || c.messages.some((m) => textOfMsg(m).toLowerCase().includes(w)));
    let snippet = '';
    if (best.text) {
      const at = Math.max(0, Math.min(...terms.map((w) => best.low.indexOf(w)).filter((i) => i >= 0)) - 80);
      snippet = (at ? '…' : '') + best.text.slice(at, at + 240).replace(/\s+/g, ' ').trim() + (best.text.length > at + 240 ? '…' : '');
    }
    out.push({ id: c.id, title: c.title || 'Untitled chat', at: c.updatedAt || c.messages.at(-1)?.at || 0, score: score + (all ? 10 : 0), snippet });
  }
  return out.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, max);
}

/**
 * A chat as text for the assistant: its summary (if compacted) and the messages, from `from`. `upto` stops before
 * that message (the part of this chat that was compacted); `detail` adds each tool call with its argument and result.
 */
export function chatTranscript(c, { from = 0, maxChars = 12000, upto = null, detail = false } = {}) {
  const lines = [];
  if (c.summary?.text && from === 0 && upto == null) lines.push(`[Summary of the earlier part]\n${c.summary.text}\n`);
  const all = c.messages || [];
  const msgs = upto == null ? all : all.slice(0, upto);
  let i = Math.max(0, from);
  let size = lines.join('\n').length;
  for (; i < msgs.length; i++) {
    const m = msgs[i];
    const tools = (m.rounds || []).flatMap((r) => r.calls.map((x) => x.name)).join(', ');
    const steps = detail ? (m.rounds || []).flatMap((r) => r.calls.map((x) => `\n  [${x.name} ${keyArg(x.name, x.arguments).slice(0, 160)}] ${x.status === 'error' ? 'FAILED: ' : '→ '}${String(x.result ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)}`)).join('') : '';
    const line = `#${i} ${m.role === 'user' ? 'User' : 'Assistant'}${tools && !detail ? ` [used ${tools}]` : ''}: ${textOfMsg(m).trim()}${steps}`;
    if (size + line.length > maxChars && lines.length) break;
    lines.push(line.length > maxChars ? line.slice(0, maxChars) + '…' : line);
    size += line.length + 1;
  }
  const more = i < msgs.length ? `\n… [${msgs.length - i} more messages – read_chat with from=${i}]` : '';
  return lines.join('\n') + more;
}

/**
 * Tool turns written out as text, for a request sent without tools (the wrap-up at the step limit): some providers
 * refuse assistant tool_calls and role:'tool' messages when no tools are offered.
 */
export function flattenToolTurns(messages = []) {
  const names = new Map();
  const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : '');
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      m.tool_calls.forEach((c) => names.set(c.id, c.function?.name));
      const calls = m.tool_calls.map((c) => `→ ${c.function?.name}(${String(c.function?.arguments || '').slice(0, 400)})`).join('\n');
      const { tool_calls: _t, ...rest } = m;
      out.push({ ...rest, content: [text(m.content), calls].filter((x) => x.trim()).join('\n') });
    } else if (m.role === 'tool') out.push({ role: 'user', content: `[Result of ${names.get(m.tool_call_id) || 'a tool'}]\n${text(m.content)}` });
    else out.push(m);
  }
  return out;
}

/** The note for the last request at the step limit: say where things stand, no more tools. */
export const wrapUpNote = (steps, goal = false) =>
  `[Chronicle: you have used all ${steps} tool steps${goal ? ' for this stretch of the goal' : ''} – no more tools in this reply. In a few short lines tell the user: what is done (with the files or results), what is left, and the next step. Do not apologise or repeat the work.]`;
