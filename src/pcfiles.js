// Files on the user's PC (decision 223): folders a small script on the computer shares (scripts/pc-files.py), reached
// over the network with a secret. The assistant can look around, search, read, copy files into /workspace and – when
// the PC allows saving and this chat's mode does – save files back. Nothing is ever deleted on the PC.
import { httpRequest } from './api.js';
import { wsPut, looksText, bytesToText, cleanPath } from './sandbox.js';
import { sha256Hex, shortHash } from './hash.js';

const MAX_IMPORT_FILES = 300;
const MAX_IMPORT_BYTES = 80 * 1024 * 1024;
const MAX_WRITE_BYTES = 24 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
const fmtKB = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (b64) => {
  const s = atob(b64 || '');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/** The connections the assistant may use. */
export const pcList = (settings) => (settings?.pcFiles || []).filter((p) => p.enabled !== false && p.url && p.secret);

/** One request to a PC → its JSON answer; a refusal comes back as an Error with the PC's own words. */
export async function pcCall(pc, path, body, { timeoutMs = 30000, running = false } = {}) {
  const http = globalThis.__ocmPcHttp || httpRequest;
  let r;
  try {
    r = await http(pc.url.replace(/\/+$/, '') + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${pc.secret}`, 'Content-Type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
      timeoutMs,
    });
  } catch (e) {
    // a command that takes long is not a computer that went away (F11 in the agent's report)
    if (running && /timed out/i.test(String(e?.message || e))) throw new Error(`${pc.name} took longer than ${Math.round(timeoutMs / 1000)} s to answer about the command. It may still be running there – pc_shell "tasklist" or "ps" shows it; an up-to-date pc-files.py hands long commands back as jobs.`);
    throw new Error(`${pc.name} did not answer (${e?.message || e}). Is pc-files.py still running on the computer, and is the phone on the same network (or Tailscale)?`);
  }
  let j = null;
  try {
    j = JSON.parse(r.body || 'null');
  } catch {
    /* not ours */
  }
  if (r.status === 401) throw new Error(`${pc.name} refused the secret – enter the one pc-files.py printed (Settings › Connections › Files on my PC).`);
  if (r.status >= 400) throw new Error(j?.error ? `${pc.name}: ${j.error}` : `${pc.name} answered HTTP ${r.status}`);
  if (!j || typeof j !== 'object') throw new Error(`${pc.name} gave an answer that is not from pc-files.py – check the address.`);
  return j;
}

/** Settings › Test: what the PC shares. → { folders: [names], write, host } */
export async function pcHealth(pc) {
  const j = await pcCall(pc, '/health', undefined, { timeoutMs: 10000 });
  if (j.app !== 'pc-files') throw new Error('That address answers, but it is not pc-files.py.');
  return { folders: (j.folders || []).map((f) => String(f.name)), write: !!j.write, full: !!j.full, os: String(j.os || ''), host: String(j.host || '') };
}

/**
 * The QR code / link pc-files.py prints: chronicle://pc?u=<address>&s=<secret>&n=<computer name> → { url, secret, name },
 * or null when it is not one (decision 230).
 */
export function parsePairing(text) {
  let u;
  try {
    u = new URL(String(text || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'chronicle:' || (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase() !== 'pc') return null;
  const url = (u.searchParams.get('u') || '').replace(/\/+$/, '');
  const secret = u.searchParams.get('s') || '';
  if (!/^https?:\/\/[^\s/]+(:\d+)?$/.test(url) || !secret) return null;
  return { url, secret, name: (u.searchParams.get('n') || '').slice(0, 40) };
}

export function pcDefs(list) {
  const many = Array.isArray(list) && list.length > 1;
  const which = many ? { pc: { type: 'string', enum: list.map((p) => p.name), description: 'Which computer' } } : {};
  const fullOnes = Array.isArray(list) ? list.filter((p) => p.full) : [];
  const shell = fullOnes.length
    ? [
        fn(
          'pc_shell',
          `Run a command on the user's computer (full control${many ? `: ${fullOnes.map((p) => p.name).join(', ')}` : ''}), as the user, in their shell (${[...new Set(fullOnes.map((p) => (/windows/i.test(p.os || '') ? 'Windows cmd' : 'sh')))].join(' / ')}). Returns the exit code and output. In review mode the user is asked before each command; in read-only mode it is refused. Prefer pc_read / pc_search for looking; never run something destructive the user did not ask for.`,
          { ...which, command: { type: 'string' }, cwd: { type: 'string', description: 'Folder to run in (absolute; default the home folder)' }, timeout_s: { type: 'integer', description: 'How long it may run in all, default 600 (10 min), at most 21600. A command still running after about 20 s goes on as a job: you get its job id and the output so far; follow it with pc_job' }, confirm: { type: 'boolean', description: 'Only after a kill or delete was stopped because it would hit more than one process or file, and you mean all of them' } },
          ['command'],
        ),
        fn(
          'pc_job',
          "A pc_shell command that is still running on the user's computer: wait for it (up to 25 s a call), read its output so far, or kill it.",
          { ...which, job: { type: 'string', description: 'The job id pc_shell gave' }, action: { type: 'string', enum: ['wait', 'read', 'kill'] }, wait_s: { type: 'integer', description: 'With wait: up to 25' } },
          ['job'],
        ),
      ]
    : [];
  return [
    fn('pc_list', "List the folders the user shares from their computer, or what is inside one. Paths start with the shared folder's name, e.g. \"game/src\"; no path = the shared folders.", { ...which, path: { type: 'string' }, recursive: { type: 'boolean', description: 'Everything below' }, depth: { type: 'integer', description: 'How many levels down (2 = this folder and one below); implies recursive' }, max: { type: 'integer', description: 'At most this many entries, default 2000, up to 20000' } }),
    fn('pc_search', "Find files on the user's computer by name (a pattern like *.py or report*) and/or by text inside them (case-insensitive). Searches everything shared, or below path.", { ...which, path: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, max: { type: 'integer', description: 'Default 100' } }),
    fn('pc_read', "Read a text file on the user's computer, with line numbers (use pc_import for images, PDFs and other files). For a long file read it in parts with start_line.", { ...which, path: { type: 'string' }, start_line: { type: 'integer', description: 'First line to show (1-based), default 1' }, max_lines: { type: 'integer', description: 'Default 400' }, max_chars: { type: 'integer', description: 'Default 12000' } }, ['path']),
    fn('pc_import', "Copy a file or folder from the user's computer into /workspace, so read_file, view_images, run_python and the shell can use it. Returns the workspace paths.", { ...which, path: { type: 'string' }, to: { type: 'string', description: 'Workspace folder to copy into (default: the same path as on the PC)' } }, ['path']),
    fn('pc_write', "Save a file to the user's computer: content (text) or from_workspace (a file in /workspace). Only works when the computer allows saving; in review mode the user is asked first, in read-only mode it is refused. It never deletes anything.", { ...which, path: { type: 'string' }, content: { type: 'string' }, from_workspace: { type: 'string' }, append: { type: 'boolean', description: 'Add to the end of the file instead of replacing it' } }, ['path']),
    ...shell,
  ];
}

export function pcPrompt(list, mode = 'ask') {
  const pcs = Array.isArray(list) ? list : [];
  if (!pcs.length) return '';
  const desc = pcs.map((p) => `"${p.name}"${p.full ? ` (FULL CONTROL${p.os ? `, ${p.os}` : ''}: any file by absolute path, and pc_shell runs commands)` : p.folders?.length ? ` (shares ${p.folders.join(', ')}${p.write ? '; saving allowed' : '; read-only'})` : ''}`).join(', ');
  const how = mode === 'readonly' ? 'This chat is read-only: pc_write is refused.' : mode === 'auto' ? 'pc_write saves at once.' : 'pc_write asks the user before each save.';
  return `- Files on the user's computer: ${desc}. Use pc_list (no path = what is shared), pc_search, pc_read for text and pc_import to bring files into /workspace before working on them; pc_write saves results back. Paths start with the shared folder's name. ${how} Only the folders shown are reachable – if the user wants another one, they must share it on the computer.`;
}

const pick = (ctx, args) => {
  const pcs = pcList(ctx.settings);
  if (!pcs.length) throw new Error('No computer is connected. The user can add one in Settings › Connections › Files on my PC (it runs pc-files.py on the computer).');
  if (!args.pc) return pcs[0];
  const p = pcs.find((x) => x.name === args.pc) || pcs.find((x) => x.name.toLowerCase() === String(args.pc).toLowerCase());
  if (!p) throw new Error(`No computer called "${args.pc}" (connected: ${pcs.map((x) => x.name).join(', ')}).`);
  return p;
};
const isAbs = (s) => /^\//.test(s) || /^[A-Za-z]:\//.test(s);
const pcPath = (raw, pc) => {
  const s = String(raw ?? '').replace(/\\/g, '/');
  // full control: an absolute path (/home/you/x, C:/Users/you/x) is passed on as it is
  if (pc?.full && isAbs(s.trim())) return s.trim();
  if (s.split('/').includes('..')) throw new Error(`".." is not allowed in path (${raw}): paths start with a shared folder's name.`);
  return s.split('/').filter((x) => x && x !== '.').join('/');
};
const mode = (ctx) => ctx.phone?.mode?.() || 'ask';
/** A command that ends processes, deletes, or shuts the computer down: previewed and asked about (decision 233). */
export const DESTRUCTIVE = /\b(taskkill|stop-process|pkill|killall|kill|shutdown|restart-computer|format)\b|^\s*(rm|del|erase|rd|rmdir|remove-item|ri)\b|[;&|]\s*(rm|del|erase|rd|rmdir|remove-item)\b/i;
const clipOut = (x) => (x.length > 30000 ? '… (earlier output cut)\n' + x.slice(-30000) : x);
/** A /exec or /job answer as a tool result: finished, or still running as a job (never "the PC did not answer"). */
function shellResult(r, label, pc) {
  const out = [r.stdout && clipOut(r.stdout), r.stderr && `[stderr]\n${clipOut(r.stderr)}`].filter(Boolean).join('\n') || '(no output yet)';
  if (r.running) return { ok: true, result: `Still running after ${r.seconds ?? 20} s on ${pc.name} – job ${r.job}. It keeps going; follow it with pc_job (job "${r.job}", action wait / read / kill).\nOutput so far:\n${out}`, display: { path: label.slice(0, 80), output: out.slice(0, 6000) }, meta: { surface: 'pc' } };
  const head = r.killed ? 'Killed.' : r.timed_out ? 'Stopped: it ran past its timeout.' : `Exit code ${r.exit}.`;
  return { ok: !r.timed_out && !r.killed && r.exit === 0, result: `${head} (in ${r.cwd})\n${out}`, display: { path: label.slice(0, 80), output: out.slice(0, 6000) }, meta: { surface: 'pc' } };
}

/** A whole file from the PC, in pieces. */
export async function pcReadFile(pc, path, max = MAX_IMPORT_BYTES) {
  const parts = [];
  let got = 0;
  for (;;) {
    const j = await pcCall(pc, '/read', { path, offset: got, length: CHUNK }, { timeoutMs: 60000 });
    if (j.size > max) throw new Error(`${path} is ${fmtKB(j.size)} – too big to copy (limit ${fmtKB(max)}).`);
    const b = fromB64(j.data);
    parts.push(b);
    got += b.length;
    if (j.eof || !b.length) break;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

export async function runPcTool(name, args, ctx) {
  const pc = pick(ctx, args);
  switch (name) {
    case 'pc_list': {
      const path = pcPath(args.path, pc);
      const max = Math.max(1, Math.min(20000, Number(args.max) || 2000));
      const j = await pcCall(pc, '/list', { path, recursive: !!args.recursive, depth: Math.max(0, Number(args.depth) || 0), max }, { timeoutMs: 90000 });
      const es = j.entries || [];
      const text = es.length ? es.map((e) => (e.dir ? `${e.path}/` : `${e.path}\t${fmtKB(e.size)}`)).join('\n') + (j.cut ? `\n… (cut at ${es.length} entries – list a sub-folder, use depth, or raise max)` : '') : `Nothing in ${path || 'the shared folders'}.`;
      return { ok: true, result: text, display: { path: path || pc.name, count: es.length }, meta: { surface: 'pc' } };
    }
    case 'pc_search': {
      const j = await pcCall(pc, '/search', { path: pcPath(args.path, pc), name: args.name || '', text: args.text || '', max: args.max || 100 }, { timeoutMs: 90000 });
      const ms = j.matches || [];
      const text = ms.length ? ms.map((m) => (m.line ? `${m.path}:${m.line}: ${m.text}` : m.path)).join('\n') + (j.cut ? '\n… (more matches – narrow the search)' : '') : 'Nothing found.';
      return { ok: true, result: text, display: { path: args.text || args.name || '', count: ms.length }, meta: { surface: 'pc' } };
    }
    case 'pc_read': {
      const p = pcPath(args.path, pc);
      const j = await pcCall(pc, '/read', { path: p, offset: 0, length: 4 * 1024 * 1024 });
      const bytes = fromB64(j.data);
      if (!looksText(bytes)) return { ok: true, result: `${p} is not a text file (${fmtKB(j.size)}). Use pc_import to copy it into the workspace.`, display: { path: p }, meta: { surface: 'pc' } };
      const lines = bytesToText(bytes).split('\n');
      if (!j.eof) lines.pop(); // the last line may be cut in the middle
      const from = Math.max(1, Number(args.start_line) || 1);
      const want = Math.max(1, Math.min(5000, Number(args.max_lines) || 400));
      const maxChars = Math.max(200, Math.min(40000, Number(args.max_chars) || 12000));
      const out = [];
      let used = 0;
      let n = from;
      for (; n <= lines.length && n < from + want; n++) {
        const row = `${String(n).padStart(5)}\t${lines[n - 1]}`;
        if (used + row.length > maxChars && out.length) break;
        out.push(row);
        used += row.length + 1;
      }
      const left = n <= lines.length || !j.eof;
      const tail = left ? `\n… [more after line ${n - 1}${j.eof ? ` of ${lines.length}` : ''} – pc_read with start_line ${n}${j.eof ? '' : ', or pc_import it'}]` : '';
      return { ok: true, result: (out.join('\n') || `(${p} has no line ${from})`) + tail, display: { path: p, chars: used }, meta: { surface: 'pc', bytes: bytes.length } };
    }
    case 'pc_import': {
      const src = pcPath(args.path, pc);
      if (!src) throw new Error('path is required (a file or folder, starting with the shared folder\'s name)');
      const st = await pcCall(pc, '/stat', { path: src });
      if (!st.exists) throw new Error(`Not found on ${pc.name}: ${src}`);
      const to = cleanPath(args.to || '');
      let files;
      if (st.dir) {
        const j = await pcCall(pc, '/list', { path: src, recursive: true }, { timeoutMs: 60000 });
        if (j.cut) throw new Error(`${src} has more than 2000 entries – import a sub-folder.`);
        files = (j.entries || []).filter((e) => !e.dir);
      } else files = [{ path: src, size: st.size }];
      if (files.length > MAX_IMPORT_FILES) throw new Error(`That folder has ${files.length} files – import a sub-folder or single files (limit ${MAX_IMPORT_FILES}).`);
      const total = files.reduce((n, e) => n + (e.size || 0), 0);
      if (total > MAX_IMPORT_BYTES) throw new Error(`That is ${fmtKB(total)} in total – too much to copy at once (limit ${fmtKB(MAX_IMPORT_BYTES)}).`);
      const done = [];
      for (const e of files) {
        ctx.onStatus?.(`copying ${e.path.split('/').pop()} from ${pc.name}… (${done.length + 1}/${files.length})`);
        const bytes = await pcReadFile(pc, e.path);
        const rel = st.dir ? e.path.slice(src.length).replace(/^\//, '') : e.path.split('/').pop();
        const dest = st.dir ? [to || src, rel].filter(Boolean).join('/') : to ? (to.split('/').pop().includes('.') ? to : `${to}/${rel}`) : e.path;
        done.push(wsPut(ctx.workspace, dest, bytes, { by: pc.name }));
      }
      const show = done.slice(0, 40).join('\n');
      return { ok: true, result: `Copied ${done.length} file${done.length === 1 ? '' : 's'} from ${pc.name} into /workspace:\n${show}${done.length > 40 ? `\n… and ${done.length - 40} more (use list_files)` : ''}`, display: { files: done.slice(0, 20), count: done.length }, meta: { surface: 'pc', bytes: total } };
    }
    case 'pc_write': {
      const p = pcPath(args.path, pc);
      if (!p.includes('/')) throw new Error(`path must be inside a shared folder, e.g. ${(pc.folders || ['Documents'])[0]}/${p || 'notes.txt'}`);
      let bytes;
      if (args.from_workspace) {
        const wp = cleanPath(args.from_workspace);
        const wf = ctx.workspace?.files?.[wp];
        if (!wf) throw new Error(`Not in the workspace: ${wp}`);
        bytes = wf.data;
      } else if (args.content !== undefined) bytes = new TextEncoder().encode(String(args.content));
      else throw new Error('Give content or from_workspace.');
      if (bytes.length > MAX_WRITE_BYTES) throw new Error(`That is ${fmtKB(bytes.length)} – too big to save in one go (limit ${fmtKB(MAX_WRITE_BYTES)}).`);
      const m = mode(ctx);
      if (m === 'readonly') return { ok: false, result: 'This chat is read-only, so nothing was saved on the computer. Keep the file in /workspace and tell the user.', display: { path: p, error: 'read-only' }, meta: { surface: 'pc' } };
      if (pc.write === false) return { ok: false, result: `${pc.name} shares its folders read-only, so nothing was saved. The user can restart pc-files.py with --write to allow saving.`, display: { path: p, error: 'read-only PC' }, meta: { surface: 'pc' } };
      const st = await pcCall(pc, '/stat', { path: p });
      if (st.dir) throw new Error(`${p} is a folder – give a file name inside it.`);
      if (m === 'ask') {
        if (!ctx.ask) return { ok: false, result: "Saving on the computer needs the user's OK, which is not available here.", display: { path: p, error: 'unavailable' }, meta: { surface: 'pc' } };
        ctx.onStatus?.('waiting for your OK…');
        const yes = args.append ? 'Add it' : st.exists ? 'Replace it' : 'Save it';
        const ans = await ctx.ask(`${args.append ? `Add ${fmtKB(bytes.length)} to the end of` : st.exists ? 'Replace' : 'Save'} ${p} on ${pc.name}${args.append ? '' : ` (${fmtKB(bytes.length)})`}?`, [yes, 'Not now'], ctx.signal);
        if (ans !== yes) return { ok: false, result: `The user said no (${ans}). Nothing was saved on the computer.`, display: { path: p, error: 'declined' }, meta: { surface: 'pc' } };
      }
      let w;
      try {
        w = await pcCall(pc, '/write', { path: p, data: toB64(bytes), mkdirs: true, append: !!args.append }, { timeoutMs: 120000 });
      } catch (e) {
        // a PC that was not checked since it was started read-only says so itself
        if (/shares its folders read-only/.test(e.message)) return { ok: false, result: `${e.message}. Nothing was saved.`, display: { path: p, error: 'read-only PC' }, meta: { surface: 'pc' } };
        throw e;
      }
      // proof: read it back and compare
      let proof = 'size ' + (w.size === bytes.length || args.append ? 'matches' : 'DIFFERS');
      let ok = args.append ? w.size >= bytes.length : w.size === bytes.length;
      if (ok && !args.append && bytes.length <= 8 * 1024 * 1024) {
        const back = await pcReadFile(pc, p, 8 * 1024 * 1024).catch(() => null);
        if (back) {
          const [a, b] = await Promise.all([sha256Hex(back), sha256Hex(bytes)]);
          ok = a === b;
          proof = 'sha256:' + shortHash(a) + (ok ? ' read-back' : ' READ-BACK DIFFERS');
        }
      }
      return ok
        ? { ok: true, result: args.append ? `Added ${fmtKB(bytes.length)} to the end of ${p} on ${pc.name} (now ${fmtKB(w.size)}).` : `${st.exists ? 'Replaced' : 'Saved'} ${p} on ${pc.name} (${fmtKB(bytes.length)}).`, display: { path: p }, meta: { surface: 'pc', bytes: bytes.length, proof } }
        : { ok: false, result: `The file was written but does not read back the same – treat ${p} as NOT saved.`, display: { path: p, error: 'read-back differs' }, meta: { surface: 'pc', bytes: bytes.length, proof } };
    }
    case 'pc_shell': {
      const command = String(args.command || '').trim();
      if (!command) throw new Error('command is required');
      if (!pc.full) return { ok: false, result: `${pc.name} does not allow running commands (pc-files.py was not started with --full).`, display: { error: 'not full control' }, meta: { surface: 'pc' } };
      const m = mode(ctx);
      if (m === 'readonly') return { ok: false, result: 'This chat is read-only, so no command was run on the computer.', display: { error: 'read-only' }, meta: { surface: 'pc' } };
      // a kill or delete: what it would hit, first (decision 233) – "two Notepad windows, which one?"
      let hits = '';
      if (DESTRUCTIVE.test(command)) {
        const pv = await pcCall(pc, '/preview', { command, cwd: args.cwd || '' }).catch(() => null); // an older pc-files.py has no preview
        const procs = pv?.processes || [];
        const files = pv?.files || [];
        hits = [...procs.map((x) => `process ${x.name} (pid ${x.pid})${x.title ? ` – “${x.title}”` : ''}`), ...files.map((f) => (f.dir ? `folder ${f.path} (${f.items} item${f.items === 1 ? '' : 's'} inside)` : `file ${f.path} (${fmtKB(f.size)})`))].join('\n');
        if (procs.length + files.length > 1 && !args.confirm)
          return { ok: false, result: `Not run: this would hit ${procs.length + files.length} things on ${pc.name}:\n${hits}\n\nIf that is not exactly what you mean, narrow the command (a process by its pid – taskkill /PID 1234 – or the one file). If you do mean all of them, call pc_shell again with confirm: true.`, display: { error: `would hit ${procs.length + files.length}`, path: command.slice(0, 60) }, meta: { surface: 'pc' } };
      }
      // Review asks before every command; Auto asks before a kill or delete too; Bypass asks nothing
      if (m === 'ask' || (DESTRUCTIVE.test(command) && !ctx.phone?.bypass?.())) {
        if (!ctx.ask) return { ok: false, result: "Running this on the computer needs the user's OK, which is not available here.", display: { error: 'unavailable' }, meta: { surface: 'pc' } };
        ctx.onStatus?.('waiting for your OK…');
        const yes = 'Run it';
        const ans = await ctx.ask(`Run on ${pc.name}${args.cwd ? ` (in ${args.cwd})` : ''}:\n\n${command}${hits ? `\n\nThis will hit:\n${hits}` : ''}`, [yes, 'Not now'], ctx.signal);
        if (ans !== yes) return { ok: false, result: `The user said no (${ans}). Nothing was run.`, display: { error: 'declined', path: command.slice(0, 60) }, meta: { surface: 'pc' } };
      }
      ctx.onStatus?.(`running on ${pc.name}…`);
      const t = Math.max(1, Math.min(21600, Number(args.timeout_s) || 600));
      const r = await pcCall(pc, '/exec', { command, cwd: args.cwd || '', timeout: t, wait: globalThis.__ocmPcWait ?? 20 }, { timeoutMs: 60000, running: true });
      return shellResult(r, command, pc);
    }
    case 'pc_job': {
      const job = String(args.job || '').trim();
      if (!job) throw new Error('job is required (the id pc_shell gave)');
      const action = args.action || 'wait';
      const r = await pcCall(pc, '/job', { job, kill: action === 'kill', wait: action === 'wait' ? Math.max(1, Math.min(25, Number(args.wait_s) || 25)) : 0 }, { timeoutMs: 60000, running: true });
      return shellResult(r, `job ${job}`, pc);
    }
    default:
      return null;
  }
}
