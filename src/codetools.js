// The coding-agent file tools: edit_file, grep_files, glob_files, plus what write_file and read_file share with them
// (the "only overwrite what you have seen" guard and the syntax check after a write). Logic in codeedit.js.
import { wsPut, wsDelete, wsList, looksText, bytesToText, cleanPath, sandbox } from './sandbox.js';
import { shellOnly } from './shellfs.js';
import { parsePatch, applyHunks } from './patch.js';
import { repoMap } from './repomap.js';
import { applyEdits, editPreview, sliceLines, globFiles, grepFiles, formatGrep, markSeen, seenState, checkSyntaxLocal, pythonFile } from './codeedit.js';
import { canUseShell, shellStatus, runShell, plain } from './shell.js';
import { lineDiff, collapseDiff } from './diff.js';

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const codeDefs = () => [
  fn(
    'edit_file',
    'Change part of a text file in /workspace by exact text replacement – the way to fix or extend code without rewriting the whole file. old_text must match the file exactly (indentation included) and be unique; give several edits to change several places at once (all apply or none do). The result shows the changed lines and a syntax check.',
    {
      path: { type: 'string' },
      edits: {
        type: 'array',
        description: 'Applied in order, each to the result of the one before',
        items: {
          type: 'object',
          properties: {
            old_text: { type: 'string', description: 'Exact text now in the file' },
            new_text: { type: 'string', description: 'What it becomes ("" deletes it)' },
            replace_all: { type: 'boolean', description: 'Change every occurrence (default: old_text must be unique)' },
          },
          required: ['old_text', 'new_text'],
        },
      },
      old_text: { type: 'string', description: 'For a single edit instead of edits' },
      new_text: { type: 'string' },
    },
    ['path'],
  ),
  fn(
    'grep_files',
    'Search the text of files in /workspace with a regular expression (JavaScript syntax) – shows path:line: text for each match. Faster and cheaper than reading files to find something.',
    {
      pattern: { type: 'string' },
      glob: { type: 'string', description: 'Only files matching this, e.g. "src/**/*.js" or "*.py"' },
      path: { type: 'string', description: 'Only under this folder' },
      ignore_case: { type: 'boolean' },
      literal: { type: 'boolean', description: 'Search for the text as it is, not as a regex' },
      context: { type: 'integer', description: 'Lines of context around each match (0-5)' },
      max_results: { type: 'integer', description: 'Default 100' },
      output: { type: 'string', enum: ['lines', 'files', 'count'], description: 'lines (default): matching lines; files: only the matching paths; count: matches per file and a total' },
    },
    ['pattern'],
  ),
  fn(
    'apply_patch',
    'Change several files in one go with a patch – add, update (by context hunks), move or delete files; all apply or none do. Format:\n*** Begin Patch\n*** Update File: src/app.js\n@@ function start() {\n   const a = 1;\n-  run(a);\n+  run(a, true);\n*** Add File: src/new.js\n+export const x = 1;\n*** Delete File: old.txt\n*** End Patch\nHunk lines start with " " (context, copy it exactly), "-" (remove) or "+" (add); give 2-3 context lines so the place is unique. A plain unified diff (---/+++/@@) also works. For one small change edit_file is simpler. Example (rename a function and its one caller): *** Begin Patch\n*** Update File: src/util.js\n@@\n-export function fmt(x) {\n+export function formatDate(x) {\n*** Update File: src/main.js\n@@\n-import { fmt } from \'./util.js\';\n+import { formatDate } from \'./util.js\';\n@@\n-console.log(fmt(now));\n+console.log(formatDate(now));\n*** End Patch',
    { patch: { type: 'string', description: 'The whole patch text' } },
    ['patch'],
  ),
  fn(
    'repo_map',
    'A map of the code in /workspace: every source file with its classes, functions and other top-level definitions (with line numbers), so you can find your way in a project without reading every file. Use it first in an unfamiliar project, then read_file the parts you need.',
    { path: { type: 'string', description: 'Only under this folder' }, max_files: { type: 'integer', description: 'Default 200' } },
  ),
  fn(
    'move_file',
    'Rename or move a file (any kind, images and zips too) or a whole folder in /workspace; with copy: true it is copied instead. The destination must not exist unless overwrite is true.',
    { from: { type: 'string' }, to: { type: 'string' }, copy: { type: 'boolean' }, overwrite: { type: 'boolean' } },
    ['from', 'to'],
  ),
  fn('delete_file', 'Delete a file, or a whole folder with everything in it, from /workspace. (↩ Undo under the reply can bring it back.)', { path: { type: 'string' } }, ['path']),
  fn('glob_files', 'Find files in /workspace by name pattern, e.g. "**/*.py", "src/*.{js,css}", "test_*" – newest first, with size.', { pattern: { type: 'string' }, path: { type: 'string', description: 'Only under this folder' } }, ['pattern']),
];

export const codePrompt = () =>
  '- Editing files: change existing files with edit_file (exact old_text → new_text, several edits at once), not by rewriting them with write_file. Read the part you will change first (read_file with start_line/end_line shows line numbers – leave the "  12│ " prefix out of old_text). Find things with grep_files and glob_files instead of reading whole files (start with output "files" to see where something is); in an unfamiliar project start with repo_map (files and their functions/classes with line numbers). To change several files at once (or add, move and delete files together) use apply_patch. write_file refuses to replace a file that changed since you last read it (the shell, Python or the user edited it) – read it again, or pass overwrite: true if replacing it is really what you want. Every write is syntax-checked (JSON, JavaScript, Python): fix a reported problem before moving on.';

const under = (dir) => (f) => !dir || f.path === dir || f.path.startsWith(dir + '/');
const textOf = (w, p) => {
  const f = w.files[p];
  return f && looksText(f.data) ? bytesToText(f.data) : null;
};

/**
 * A name is a file or a folder, never both. The workspace is a flat map and would take "docs" next to "docs/a.md",
 * but the shell's /workspace and Python's cannot hold that: the file would never reach them. → '' or why p cannot be
 * written (gone: paths this same call removes first).
 */
export function inTheWay(w, p, gone = new Set()) {
  for (let up = p; up.includes('/'); ) {
    up = up.slice(0, up.lastIndexOf('/'));
    if (w.files[up] && !gone.has(up)) return `${up} is a file, so nothing can be written under it – move or delete ${up} first, or use another folder name`;
  }
  const inside = Object.keys(w.files).find((x) => x.startsWith(p + '/') && !gone.has(x));
  return inside ? `${p} is a folder (it holds ${inside}) – write into it (${p}/…), or move or delete the folder first` : '';
}

/** The diff for the tool card: [{ t: ' ' | '+' | '-' | '…', s }], unchanged stretches folded, kept small. */
export function cardDiff(before, after, max = 80) {
  const ops = collapseDiff(lineDiff(before, after), 2).map((o) => ({ t: o.t, s: o.s.length > 300 ? o.s.slice(0, 300) + '…' : o.s }));
  return ops.length > max ? [...ops.slice(0, max), { t: '…', s: `${ops.length - max} more diff lines` }] : ops;
}

// ---------- the syntax check ----------
const b64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const PY_CHECK = (path) => `import ast,sys\ntry:\n    ast.parse(sys.stdin.read(), ${JSON.stringify(path)})\nexcept SyntaxError as e:\n    print('Python: %s (line %s)' % (e.msg, e.lineno)); sys.exit(1)`;

/** → '' or the problem. Python goes to Pyodide when it is already running for this chat, else to the Linux shell. */
export async function checkSyntax(path, text, ctx, w) {
  try {
    if (!pythonFile(path)) return await checkSyntaxLocal(path, text);
    if (text.length > 300000) return '';
    if (sandbox.worker && sandbox.convId === w.id) {
      const code = `import ast\ntry:\n    ast.parse(open(${JSON.stringify(path)}, encoding='utf-8').read(), ${JSON.stringify(path)})\nexcept SyntaxError as e:\n    print('Python: %s (line %s)' % (e.msg, e.lineno))`;
      const r = await sandbox.run(w, code, { timeoutMs: 20000 });
      return String(r.stdout || '').trim().split('\n').find((l) => l.startsWith('Python:')) || '';
    }
    if (canUseShell() && (await shellStatus()).installed) {
      const cmd = `command -v python3 >/dev/null 2>&1 || exit 0\necho ${b64(text)} | base64 -d | python3 -c ${shq(PY_CHECK(path))}`;
      const r = await runShell(cmd, { id: 'chat:' + (ctx.convId || 'main') + ':check', timeoutMs: 20000 });
      return plain(r.output || '').trim().split('\n').find((l) => l.startsWith('Python:')) || '';
    }
  } catch {
    /* a check that cannot run is no reason to fail the write */
  }
  return '';
}
// node_modules and .git are never mirrored (the shell keeps them): a file the app writes there stays in the app
const shellOnlyNote = (p) => (shellOnly(p) ? ` Note: files under node_modules/ and .git/ are not copied into the shell's /workspace, so this one exists only in the app (read_file and Python see it, programs in the shell do not) – write it with the shell tool if something there needs it.` : '');
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const syntaxNote = (problem) => (problem ? `\n⚠ Syntax check: ${problem}. The file is saved as written, but this step counts as FAILED until it parses: fix it with edit_file.` : '');

// ---------- the tools ----------
// Searches leave out what is not the user's work: the app's spilled results (.out/ – a grep would find its own earlier
// output there), dependencies and build output. Naming one of those folders in path or the pattern searches it.
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.out|__pycache__|\.venv|venv|dist|build|\.next|coverage)(\/|$)/;
function searchable(files, dir, pattern) {
  if (SKIP_DIRS.test(dir + '/') || SKIP_DIRS.test(String(pattern || '') + '/')) return { files, skipped: 0 };
  const keep = files.filter((f) => !SKIP_DIRS.test(f.path));
  return { files: keep, skipped: files.length - keep.length };
}
const skippedNote = (n) => (n ? `\n(${n} file${n === 1 ? '' : 's'} in .out/, node_modules, .git, dist… not searched – give that folder as path to search it)` : '');

/**
 * An absolute path outside /workspace (/root/app/x.js, /tmp/a) is the shell's own disk, not the chat's files (decision
 * 276): cleanPath dropped the slash, so write_file /root/app/x.js wrote /workspace/root/app/x.js and said "Wrote
 * root/app/x.js". Refused with where to go instead. /workspace/… and relative paths are as before.
 */
export function outsideWorkspace(...paths) {
  for (const raw of paths) {
    const t = String(raw ?? '').trim();
    if (!t.startsWith('/') || /^\/workspace(\/|$)/.test(t) || t === '/') continue;
    if (/^\/phone(\/|$)/.test(t)) throw new Error(`${t} is the linked phone folder – use the phone_* tools (phone_read, phone_write) or the shell for it; these tools work on the chat's files in /workspace.`);
    throw new Error(`${t} is outside /workspace – it is on the Linux shell's own disk, which these tools cannot reach. Use the shell for it (cat, sed -n, grep -n, or a heredoc to write), or keep the project in /workspace/<name> (a clone's .git and node_modules stay in the shell only, so that is cheap) and use these tools there.`);
  }
}

export async function runCodeTool(name, args, ctx, w) {
  outsideWorkspace(args?.path, args?.from, args?.to);
  if (name === 'edit_file') {
    const p = cleanPath(args.path);
    if (!p) throw new Error('path is required');
    const before = textOf(w, p);
    if (before == null) throw new Error(w.files[p] ? `${p} is not a text file.` : `File not found: ${p}. Use write_file to create it (or glob_files to find the right name).`);
    const state = seenState(w, p);
    const edits = Array.isArray(args.edits) && args.edits.length ? args.edits : args.old_text != null ? [{ old_text: args.old_text, new_text: args.new_text ?? '', replace_all: args.replace_all }] : [];
    const { text, replaced, notes } = applyEdits(before, edits, p, { loose: true });
    wsPut(w, p, text, { by: 'the assistant' });
    markSeen(w, p);
    const problem = await checkSyntax(p, text, ctx, w);
    const changedBy = state === 'changed' ? `\n(Note: ${p} had been changed by ${w.files[p]?.by && w.files[p].by !== 'the assistant' ? 'someone else' : 'another step'} since you last read it; your old_text still matched.)` : '';
    const result = `Edited ${p}: ${replaced} change${replaced === 1 ? '' : 's'}.${notes.length ? `\n(${notes.join('; ')}.)` : ''}\n${editPreview(before, text)}${syntaxNote(problem)}${changedBy}`;
    return { ok: !problem, result, display: { path: p, files: [p], diff: cardDiff(before, text), syntax: problem || undefined } };
  }
  if (name === 'grep_files') {
    const dir = cleanPath(args.path || '');
    const { files, skipped } = searchable(wsList(w).filter(under(dir)), dir, args.glob);
    const r = grepFiles(files, (p) => textOf(w, p), { pattern: args.pattern, literal: !!args.literal, ignoreCase: !!args.ignore_case, context: args.context, max: Math.max(1, Math.min(500, Number(args.max_results) || 100)), glob: args.glob || '', mode: args.output });
    for (const h of r.hits) markSeen(w, h.path);
    for (const c of r.counts) markSeen(w, c.path); // it has seen this version: a later change by the shell or Python is then caught by write_file
    return { ok: true, result: formatGrep(r, args.pattern) + skippedNote(skipped), display: { path: args.glob || dir || String(args.pattern), count: r.mode === 'lines' ? r.hits.length : r.files } };
  }
  if (name === 'apply_patch') {
    const ops = parsePatch(args.patch);
    // work everything out first; nothing is written unless every file applies
    const planned = [];
    for (const o of ops) {
      const p = cleanPath(o.path);
      if (!p) throw new Error(`Bad path in the patch: ${o.path}`);
      const before = textOf(w, p);
      if (o.op === 'add') {
        if (w.files[p] && !o.unified) throw new Error(`${p} already exists – use "*** Update File: ${p}" to change it.`);
        planned.push({ op: 'add', p, before, after: o.lines.join('\n') + (o.lines.length ? '\n' : '') });
      } else if (o.op === 'delete') {
        if (!w.files[p]) throw new Error(`Cannot delete ${p}: it does not exist.`);
        planned.push({ op: 'delete', p, before });
      } else {
        if (before == null) throw new Error(w.files[p] ? `${p} is not a text file.` : `Cannot update ${p}: it does not exist (use "*** Add File").`);
        const to = o.moveTo ? cleanPath(o.moveTo) : p;
        planned.push({ op: 'update', p, to, before, after: applyHunks(before, o.hunks, p) });
      }
    }
    // a file where a folder is (or under a file) would never reach the shell: refused before anything is written,
    // unless this patch itself deletes or moves away what is in the way
    const gone = new Set(planned.filter((x) => x.op === 'delete' || (x.to && x.to !== x.p)).map((x) => x.p));
    for (const x of planned) {
      const clash = x.op === 'delete' ? '' : inTheWay(w, x.to || x.p, gone);
      if (clash) throw new Error(`The patch was not applied: ${clash}.`);
      // a move onto a file that is there (and stays) would replace it without a word
      if (x.to && x.to !== x.p && w.files[x.to] && !gone.has(x.to)) throw new Error(`The patch was not applied: ${x.to} already exists – "*** Move to" does not replace a file. Delete it in the same patch (*** Delete File: ${x.to}) if replacing it is meant, or move to another name.`);
    }
    const lines = [];
    const files = [];
    let diff = [];
    for (const x of planned) {
      if (x.op === 'delete') {
        wsDelete(w, x.p);
        lines.push(`deleted ${x.p}`);
        continue;
      }
      const dest = x.to || x.p;
      wsPut(w, dest, x.after, { by: 'the assistant' });
      if (x.to && x.to !== x.p) wsDelete(w, x.p);
      markSeen(w, dest);
      files.push(dest);
      const problem = await checkSyntax(dest, x.after, ctx, w);
      lines.push(`${x.op === 'add' ? 'added' : x.to !== x.p ? `updated ${x.p} → moved to` : 'updated'} ${dest}${problem ? ` ⚠ syntax: ${problem}` : ''}${shellOnlyNote(dest)}`);
      diff = diff.concat([{ t: '…', s: dest }], cardDiff(x.before || '', x.after, 40));
    }
    const bad = lines.some((l) => l.includes('⚠ syntax'));
    return { ok: !bad, result: `Patch applied (${planned.length} file${planned.length === 1 ? '' : 's'}):\n${lines.join('\n')}${bad ? '\nThe files are saved as patched, but this step counts as FAILED until they parse: fix them with edit_file.' : ''}`, display: { path: files[0] || planned[0]?.p, files, diff: diff.slice(0, 120) } };
  }
  if (name === 'move_file') {
    const from = cleanPath(args.from);
    let to = cleanPath(args.to);
    if (!from || !to) throw new Error('from and to are required');
    const all = Object.keys(w.files);
    // a file moved "to" a folder goes into it, as with mv: to an existing folder, or to a name written with a trailing /
    if (w.files[from] && !w.files[to] && (/[\\/]\s*$/.test(String(args.to)) || all.some((p) => p.startsWith(to + '/')))) to = to + '/' + from.split('/').pop();
    if (from === to) throw new Error('from and to are the same');
    if (!w.files[from] && to.startsWith(from + '/')) throw new Error(`Cannot move the folder ${from} into itself (${to}).`);
    const moves = w.files[from] ? [[from, to]] : all.filter((p) => p.startsWith(from + '/')).map((p) => [p, to + p.slice(from.length)]);
    if (!moves.length) throw new Error(`Not found: ${from}. Use list_files or glob_files.`);
    const leaving = args.copy ? new Set() : new Set(moves.map(([src]) => src));
    for (const [, d] of moves) {
      const blocked = inTheWay(w, d, leaving);
      if (blocked) throw new Error(`Not moved: ${blocked}.`);
    }
    const clash = moves.filter(([, d]) => w.files[d]).map(([, d]) => d);
    if (clash.length && !args.overwrite) throw new Error(`${clash.slice(0, 3).join(', ')}${clash.length > 3 ? ' …' : ''} already exist${clash.length === 1 ? 's' : ''} – pass overwrite: true to replace`);
    for (const [src, dst] of moves) {
      const f = w.files[src];
      wsPut(w, dst, f.data, { by: 'the assistant', ...(typeof f.mode === 'number' ? { mode: f.mode } : f.exec ? { exec: true } : {}) }); // a 600 stays a 600
      if (!args.copy) wsDelete(w, src);
      markSeen(w, dst);
    }
    const what = moves.length === 1 ? `${from} → ${to}` : `${moves.length} files from ${from}/ to ${to}/`;
    return { ok: true, result: `${args.copy ? 'Copied' : 'Moved'} ${what}.`, display: { path: to, files: moves.map(([, d]) => d) } };
  }
  if (name === 'delete_file') {
    const p = cleanPath(args.path);
    if (!p) throw new Error('path is required');
    const list = w.files[p] ? [p] : Object.keys(w.files).filter((x) => x.startsWith(p + '/'));
    if (!list.length) throw new Error(`Not found: ${p}`);
    for (const x of list) wsDelete(w, x);
    return { ok: true, result: list.length === 1 ? `Deleted ${p}.` : `Deleted the folder ${p} (${list.length} files).`, display: { path: p, count: list.length } };
  }
  if (name === 'repo_map') {
    const dir = cleanPath(args.path || '');
    const list = wsList(w).filter(under(dir));
    const r = repoMap(list.map((f) => f.path), (p) => textOf(w, p), { maxFiles: Math.max(10, Math.min(1000, Number(args.max_files) || 200)) });
    return { ok: true, result: r.text, display: { path: dir || '/workspace', count: r.files } };
  }
  if (name === 'glob_files') {
    const dir = cleanPath(args.path || '');
    const { files: pool, skipped } = searchable(wsList(w).filter(under(dir)), dir, args.pattern);
    const hits = globFiles(pool, args.pattern);
    const shown = hits.slice(0, 300);
    const text = hits.length ? shown.map((f) => `${f.path}\t${f.size} bytes`).join('\n') + (hits.length > shown.length ? `\n… ${hits.length - shown.length} more – narrow the pattern` : '') : `No file matches ${args.pattern}${dir ? ' under ' + dir : ''}.`;
    // paths: the same files as a list, for run_script (the text ends with notes a script would take for file names)
    return { ok: true, result: text + skippedNote(skipped), paths: shown.map((f) => f.path), display: { path: String(args.pattern), count: hits.length } };
  }
  return null;
}

/** write_file, guarded and checked. */
export async function writeFileTool(args, ctx, w) {
  outsideWorkspace(args.path);
  const p = cleanPath(args.path);
  if (!p) throw new Error('path is required');
  const content = String(args.content ?? '');
  const existed = w.files[p];
  const before = existed && looksText(existed.data) ? bytesToText(existed.data) : null;
  const state = seenState(w, p);
  if (state === 'changed' && !args.overwrite && before !== content) {
    const by = existed.by && existed.by !== 'the assistant' ? existed.by : 'something else';
    throw new Error(`${p} was changed by ${by} since you last read or wrote it, so it was not overwritten (that would lose those changes). Read it again and use edit_file, or call write_file with overwrite: true if replacing it is really what you want.`);
  }
  if (!existed) {
    const blocked = inTheWay(w, p);
    if (blocked) throw new Error(`${p} was not written: ${blocked}.`);
  }
  wsPut(w, p, content, { by: 'the assistant' });
  markSeen(w, p);
  const problem = await checkSyntax(p, content, ctx, w);
  const note = state === 'unseen' && before != null && before !== content ? ` It replaced an existing file you had not read (${before.length} chars).` : '';
  // a file that does not parse is a failed step – but it is kept: resending the whole file to fix one line wastes a turn
  return {
    ok: !problem,
    result: `${problem ? 'Wrote, but it does not parse: ' : 'Wrote '}${p} (${content.length} chars).${note}${syntaxNote(problem)}${shellOnlyNote(p)}`,
    display: { path: p, files: [p], ...(before != null && before !== content ? { diff: cardDiff(before, content) } : {}), syntax: problem || undefined },
  };
}

/** read_file: by characters (offset/max_chars) or by lines (start_line/end_line, numbered). */
export function readFileTool(args, w, notText) {
  outsideWorkspace(args.path);
  const p = cleanPath(args.path);
  const f = w.files[p];
  if (!f) throw new Error(`File not found: ${p}. Use list_files or glob_files to see what exists.`);
  if (!looksText(f.data)) return notText(p, f);
  const text = bytesToText(f.data);
  markSeen(w, p);
  if (args.start_line != null || args.end_line != null) {
    const s = sliceLines(text, args.start_line, args.end_line);
    const more = s.to < s.total ? `\n… [lines ${s.to + 1}-${s.total} not shown; call read_file with start_line=${s.to + 1}]` : '';
    return { ok: true, result: `${p} lines ${s.from}-${s.to} of ${s.total}:\n${s.text}${more}`, display: { path: p, chars: text.length } };
  }
  const off = Math.max(0, Number(args.offset) || 0);
  const max = Math.max(200, Math.min(40000, Number(args.max_chars) || 12000));
  const chunk = text.slice(off, off + max);
  const more = off + max < text.length ? `\n… [${text.length - off - max} more chars; call read_file with offset=${off + max}, or start_line for numbered lines]` : '';
  return { ok: true, result: chunk + more, display: { path: p, chars: text.length } };
}
