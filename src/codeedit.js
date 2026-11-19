// Editing code like a coding agent: exact-text edits instead of rewriting whole files, a guard against writing over
// a file that changed since the assistant last saw it, a syntax check after every write, and grep / glob over the
// workspace. Pure functions here (tested in Node); tools.js wires them to the workspace.

/** Lines with their 1-based numbers, for messages: "12│ text". */
const numbered = (lines, from) => lines.map((l, i) => `${String(from + i).padStart(4)}│ ${l}`).join('\n');

/** Where in the file something that did not match probably was: the lines sharing the most words with it. */
export function nearestLines(text, needle, around = 2) {
  const lines = text.split('\n');
  const first = needle.split('\n').find((l) => l.trim()) || needle;
  const key = first.trim();
  // 1. the first line of what was asked for, ignoring indentation
  let at = key ? lines.findIndex((l) => l.trim() === key) : -1;
  if (at < 0 && key.length > 6) at = lines.findIndex((l) => l.includes(key.slice(0, Math.min(40, key.length))));
  // 2. the line that shares the most words
  if (at < 0) {
    const words = new Set(key.toLowerCase().match(/[a-z0-9_$]{3,}/g) || []);
    let best = 0;
    lines.forEach((l, i) => {
      const n = (l.toLowerCase().match(/[a-z0-9_$]{3,}/g) || []).filter((w) => words.has(w)).length;
      if (n > best) (best = n), (at = i);
    });
  }
  if (at < 0) return '';
  const from = Math.max(0, at - around);
  const span = Math.max(1, needle.split('\n').length);
  return numbered(lines.slice(from, at + span + around), from + 1);
}

const count = (hay, needle) => {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

/**
 * Apply edits [{ old_text, new_text, replace_all }] in order. All or nothing: on the first edit that does not
 * match (or matches more than once without replace_all) it throws with what the file really has there.
 * A file with Windows line endings is edited with them: old/new text written with \n is matched as \r\n.
 * → { text, replaced } (replaced = how many places changed)
 */
export function applyEdits(original, edits, path = 'the file', { loose = false } = {}) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('edits is empty – give at least one { old_text, new_text }');
  const crlf = original.includes('\r\n');
  const eol = (s) => (crlf ? String(s).replace(/\r?\n/g, '\r\n') : String(s));
  let text = original;
  let replaced = 0;
  const notes = [];
  edits.forEach((e, k) => {
    const label = edits.length > 1 ? `edit #${k + 1}` : 'the edit';
    const oldText = eol(e?.old_text ?? e?.old ?? '');
    const newText = eol(e?.new_text ?? e?.new ?? '');
    if (!oldText) throw new Error(`${label}: old_text is empty. To add text, include a nearby line in old_text and repeat it in new_text; to write a whole new file use write_file.`);
    if (oldText === newText) throw new Error(`${label}: old_text and new_text are the same – nothing would change.`);
    const n = count(text, oldText);
    // code (edit_file): the same lines with other spacing or indentation, in exactly one place – applied with the
    // file's own indentation, and said (decision 201); zero or several such places still refuse
    if (!n && loose && !e.replace_all) {
      const hit = looseLineMatch(text, oldText, newText, crlf);
      if (hit) {
        text = hit.text;
        replaced += 1;
        notes.push(`${label}: old_text matched line${hit.lines > 1 ? `s ${hit.line}–${hit.line + hit.lines - 1}` : ` ${hit.line}`} only with different spacing/indentation – applied there with the file's indentation`);
        return;
      }
    }
    if (!n) {
      const plain = text.replace(/\r\n/g, '\n');
      const near = nearestLines(plain, oldText.replace(/\r\n/g, '\n'));
      const loose = looseHits(plain, oldText.replace(/\r\n/g, '\n'));
      throw new Error(
        `${label}: old_text was not found in ${path}${k ? ' (after the edits before it)' : ''}. Nothing was changed.` +
          (loose ? ` It does appear with different spacing/indentation – copy it exactly from the file.` : '') +
          (near ? `\nThe closest part of the file is:\n${near}` : '') +
          '\nRead the file again (read_file with start_line) and copy old_text exactly, including indentation.',
      );
    }
    if (n > 1 && !e.replace_all) throw new Error(`${label}: old_text appears ${n} times in ${path}. Nothing was changed. Include more surrounding lines so it is unique, or set replace_all: true to change every one.`);
    text = e.replace_all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    replaced += e.replace_all ? n : 1;
  });
  return { text, replaced, notes };
}

/**
 * old_text that matches whole lines of the file once their spacing is ignored (indentation, trailing spaces, runs
 * of spaces): exactly one such place → the text with new_text put there, re-indented by the difference between the
 * file's indentation and old_text's. → { text, line, lines } or null (none, or more than one).
 */
export function looseLineMatch(text, oldText, newText, crlf = false) {
  const nl = crlf ? '\r\n' : '\n';
  const squash = (l) => l.replace(/\s+/g, ' ').trim();
  const want = oldText.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '').split('\n');
  if (!want.some((l) => l.trim()) || want.join('').trim().length < 4) return null;
  const lines = text.split(nl);
  const keys = want.map(squash);
  const hits = [];
  for (let i = 0; i + want.length <= lines.length; i++) if (keys.every((k, j) => squash(lines[i + j]) === k)) hits.push(i);
  if (hits.length !== 1) return null;
  const at = hits[0];
  const indentOf = (l) => l.match(/^[ \t]*/)[0];
  const firstWant = want.findIndex((l) => l.trim());
  const fileIndent = indentOf(lines[at + firstWant]);
  const wantIndent = indentOf(want[firstWant]);
  const repl = newText
    .replace(/\r\n/g, '\n')
    .replace(/^\n+|\n+$/g, '')
    .split('\n')
    .map((l) => (!l.trim() ? l : l.startsWith(wantIndent) ? fileIndent + l.slice(wantIndent.length) : fileIndent + l.trimStart()));
  const out = [...lines.slice(0, at), ...(newText.trim() ? repl : []), ...lines.slice(at + want.length)];
  return { text: out.join(nl), line: at + 1, lines: want.length };
}

/** Does the needle appear if spacing is ignored? (only to say WHY an exact match failed – never applied) */
function looseHits(hay, needle) {
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  return needle.trim().length > 3 && squash(hay).includes(squash(needle));
}

/** The lines around the edit, numbered, so the assistant sees the result without reading the file again. */
export function editPreview(before, after, around = 2) {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) ea--, eb--;
  const from = Math.max(0, s - around);
  const to = Math.min(b.length, eb + 1 + around);
  if (to - from > 40) return numbered(b.slice(from, from + 18), from + 1) + `\n   …│ (${to - from - 36} more changed lines)\n` + numbered(b.slice(to - 18, to), to - 17);
  return numbered(b.slice(from, to), from + 1);
}

const MAX_LINES = 2000;
const MAX_LINE = 2000;
const MAX_RANGE = 40000;
/** read_file by lines: 1-based, inclusive, at most 2000 lines / ~40K characters. → { text, total, from, to } */
export function sliceLines(text, start, end) {
  const lines = text.split('\n');
  const s = Math.max(1, Number(start) || 1);
  let e = Math.min(lines.length, Number(end) || s + 199, s + MAX_LINES - 1);
  // long lines (minified code, data on one line) are clipped; the range stops at ~40K characters
  const clip = (l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + ` … [line cut: ${l.length} characters – use offset/max_chars to read it]` : l);
  const out = [];
  let size = 0;
  for (let i = s - 1; i < e; i++) {
    const l = clip(lines[i]);
    if (size + l.length > MAX_RANGE && out.length) {
      e = i;
      break;
    }
    out.push(l);
    size += l.length + 1;
  }
  return { text: numbered(out, s), total: lines.length, from: s, to: e };
}

/** src/**\/*.js, *.{ts,tsx}, notes/?.md → a RegExp for the whole path. */
export function globRegex(glob) {
  let g = String(glob || '**').trim().replace(/^\.?\/+/, '').replace(/^workspace\//, '');
  if (!g.includes('/') && !g.startsWith('**')) g = '**/' + g; // "*.py" means anywhere, like most tools
  let rx = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          rx += '(?:.*/)?';
        } else rx += '.*';
      } else rx += '[^/]*';
    } else if (c === '?') rx += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end < 0) rx += '\\{';
      else {
        rx += '(?:' + g.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
        i = end;
      }
    } else rx += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + rx + '$', 'i');
}

/** Files (from wsList) matching a glob, newest first. */
export function globFiles(files, glob) {
  const rx = globRegex(glob);
  return files.filter((f) => rx.test(f.path)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || a.path.localeCompare(b.path));
}

/**
 * grep over text files: { pattern, regex?, ignore_case?, context? } → { hits: [{ path, line, text, context }], files, truncated }
 * read(path) returns the text or null for binary files.
 */
export function grepFiles(files, read, { pattern, literal = false, ignoreCase = false, context = 0, max = 100, glob = '', mode = 'lines' } = {}) {
  if (mode !== 'files' && mode !== 'count') mode = 'lines';
  if (!pattern) throw new Error('pattern is required');
  let rx;
  try {
    rx = new RegExp(literal ? String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : String(pattern), ignoreCase ? 'i' : '');
  } catch (e) {
    throw new Error(`Bad regular expression (${e.message}). Pass literal: true to search for the text as it is.`);
  }
  const pool = glob ? globFiles(files, glob) : [...files].sort((a, b) => a.path.localeCompare(b.path));
  const hits = [];
  const inFiles = new Set();
  let truncated = false;
  const ctx = Math.max(0, Math.min(5, Number(context) || 0));
  const tooBig = []; // over the size limit: never opened, so they must not count as "searched"
  let binary = 0;
  const counts = []; // files and count modes: every match is counted, no limit
  for (const f of pool) {
    if (f.size > 4 * 1024 * 1024) {
      tooBig.push(f.path);
      continue;
    }
    const text = read(f.path);
    if (text == null) {
      binary++;
      continue;
    }
    const lines = text.split('\n');
    if (mode !== 'lines') {
      let n = 0;
      for (const l of lines) if (rx.test(l)) n++;
      if (n) counts.push({ path: f.path, n });
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (!rx.test(lines[i])) continue;
      if (hits.length >= max) {
        truncated = true;
        break;
      }
      inFiles.add(f.path);
      hits.push({ path: f.path, line: i + 1, text: lines[i].replace(/\r$/, '').slice(0, 300), before: lines.slice(Math.max(0, i - ctx), i), after: lines.slice(i + 1, i + 1 + ctx) });
    }
    if (truncated) break;
  }
  return { hits, mode, counts, files: mode === 'lines' ? inFiles.size : counts.length, truncated, searched: pool.length - tooBig.length - binary, tooBig, binary };
}

export function formatGrep(r, pattern, mode = r.mode || 'lines') {
  // a file that was not opened is said, or "no match" reads as "it is not there"
  const big = r.tooBig?.length && !r.truncated ? `\n(not searched: ${r.tooBig.slice(0, 3).join(', ')}${r.tooBig.length > 3 ? ` and ${r.tooBig.length - 3} more` : ''} – over 4 MB; search ${r.tooBig.length === 1 ? 'it' : 'them'} with grep in the shell or with run_python)` : '';
  const none = mode === 'lines' ? !r.hits.length : !r.counts?.length;
  if (none) return `No match for ${JSON.stringify(pattern)} in ${r.searched} file${r.searched === 1 ? '' : 's'}.${big}`;
  if (mode === 'files' || mode === 'count') {
    const list = r.counts;
    const total = list.reduce((a, c) => a + c.n, 0);
    const out = mode === 'files' ? list.slice(0, 500).map((c) => c.path) : list.slice(0, 500).map((c) => `${c.path}: ${c.n}`);
    if (list.length > 500) out.push(`+${list.length - 500} more`);
    out.push(`\n${total} match${total === 1 ? '' : 'es'} in ${list.length} file${list.length === 1 ? '' : 's'}.${big}`);
    return out.join('\n');
  }
  const out = [];
  let last = '';
  for (const h of r.hits) {
    if (h.path !== last) out.push(`${out.length ? '\n' : ''}${h.path}`);
    last = h.path;
    h.before.forEach((t, k) => out.push(`  ${h.line - h.before.length + k}- ${t.slice(0, 300)}`));
    out.push(`  ${h.line}: ${h.text}`);
    h.after.forEach((t, k) => out.push(`  ${h.line + k + 1}- ${t.slice(0, 300)}`));
  }
  out.push(`\n${r.hits.length} match${r.hits.length === 1 ? '' : 'es'} in ${r.files} file${r.files === 1 ? '' : 's'}${r.truncated ? ' – stopped at the limit; narrow the pattern or the glob' : ''}.${big}`);
  return out.join('\n');
}

// ---------- what the assistant has seen: no silent writes over someone else's change ----------
const seenBy = new WeakMap(); // workspace → Map(path → content hash it last read or wrote)
const quickHash = (bytes) => {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  return (h >>> 0).toString(36) + ':' + bytes.length;
};
const seenMap = (w) => {
  let m = seenBy.get(w);
  if (!m) seenBy.set(w, (m = new Map()));
  return m;
};
/** The assistant read or wrote this version of the file. */
export function markSeen(w, path) {
  const f = w?.files?.[path];
  if (f) seenMap(w).set(path, quickHash(f.data));
}
/** 'unseen' (never read or written by the assistant), 'same', or 'changed' (by the shell, Python or you since). */
export function seenState(w, path) {
  const f = w?.files?.[path];
  const s = seenMap(w).get(path);
  if (!f) return 'missing';
  if (!s) return 'unseen';
  return s === quickHash(f.data) ? 'same' : 'changed';
}
export const forgetSeen = (w, path) => seenMap(w).delete(path);

// ---------- a syntax check after every write ----------
let acornP = null;
const loadAcorn = () => (acornP ||= import('acorn'));

/** → '' when fine (or the language is not checked here), else a one-line problem with its line number. */
export async function checkSyntaxLocal(path, text) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'json') {
    try {
      JSON.parse(text);
      return '';
    } catch (e) {
      const pos = Number((/position (\d+)/.exec(e.message) || [])[1]);
      const line = Number.isFinite(pos) ? text.slice(0, pos).split('\n').length : null;
      return `JSON: ${e.message.replace(/ in JSON at position \d+.*$/, '')}${line ? ` (line ${line})` : ''}`;
    }
  }
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) {
    const { parse } = await loadAcorn();
    const module = ext === 'mjs' || /^\s*(import|export)\s/m.test(text);
    try {
      parse(text, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script', allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
      return '';
    } catch (e) {
      if (ext === 'jsx' && /Unexpected token/.test(e.message)) return ''; // JSX is not plain JavaScript: not checked here
      return `JavaScript: ${e.message.replace(/\s*\((\d+):(\d+)\)$/, (_, l, c) => ` (line ${l}, column ${Number(c) + 1})`)}`;
    }
  }
  return '';
}
/** Languages the shell (or Python) checks: → the command, or '' */
export const pythonFile = (path) => /\.py$/i.test(path);
