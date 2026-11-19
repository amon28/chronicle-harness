// 🐧 Linux files: a read-only look at the shell's own disk, outside /workspace (a repo cloned into /root, /tmp…).
//
// Listing goes through the shell (its own shell id, so a long command in a chat does not block it): only the shell
// sees the tree as Linux does – symbolic links resolved inside the root filesystem, not on Android's disk, where a
// relative link could lead into the hidden folder and an absolute one to the phone's own /usr. One command per folder,
// never the whole tree. File bytes are read straight from the root filesystem on the app's disk when the shell's
// realpath says where the file really is (no base64 through the shell), else in 1 MiB pieces through the shell.
//
// Paths never go into a command as text: every command carries the path base64-encoded and decodes it itself, so
// spaces, quotes, $, `, newlines and unicode in names cannot change what runs.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { killShell, runShell, canUseShell, shellStatus } from './shell.js';
import { scrubToken } from './github.js';
import { isClaudePrivate, hasClaudeToken } from './claudesecrets.js';

/** The GitHub token and the SSH key live here (github.js): never listed, never opened, never copied. */
export const HIDDEN = '/root/.config/chronicle';
/** The Linux home the hidden folder is in: Claude Code's sign-in files under it are private too (claudesecrets.js). */
const homeOf = (hidden) => String(hidden).replace(/\/\.config\/chronicle$/, '') || '/root';
export const SHELL_ID = 'files-browser';
const SIZE_SHELL = 'files-sizes'; // folder sizes are counted here, not in the browser's own shell
export const LIST_CAP = 500; // rows shown per folder
const STAT_CAP = 20000; // lines the shell sends back for one folder at most
export const VIEW_MAX = 2 * 1024 * 1024; // text shown in the viewer
export const READ_MAX = 32 * 1024 * 1024; // a file read for saving or copying
export const COPY_MAX_FILES = 300;
export const COPY_MAX_BYTES = 25 * 1024 * 1024;
const CHUNK = 1024 * 1024;
/** Folders shown with their size, opened only when asked (thousands of files of tools' own data). */
export const HEAVY = new Set(['.git', 'node_modules']);
/** File names that are private keys by convention (the content check catches the rest). */
export const KEY_NAME = /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i;

export const linuxReady = async () => canUseShell() && !!(await shellStatus())?.installed;

/** An absolute, normalised path: ~ is /root, '.' and '..' are resolved (never above /), slashes collapsed. */
export function normPath(input, cwd = '/root') {
  let s = String(input ?? '').trim();
  if (s === '~' || s.startsWith('~/')) s = '/root' + s.slice(1);
  if (!s.startsWith('/')) s = (cwd || '/root') + '/' + s;
  const out = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

/** Is this (normalised) path the hidden folder or inside it – or one of Claude Code's sign-in files? */
export const isHidden = (p, hidden = HIDDEN) => {
  const n = normPath(p, '/');
  return n === hidden || n.startsWith(hidden + '/') || isClaudePrivate(n, homeOf(hidden));
};
export const parentOf = (p) => normPath(p + '/..', '/');
export const joinPath = (dir, name) => (dir === '/' ? '/' + name : dir + '/' + name);

// ---------- the commands ----------
const enc = new TextEncoder();
const b64 = (s) => {
  const bytes = typeof s === 'string' ? enc.encode(s) : s;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const unB64 = (s) => {
  const bin = atob(String(s || '').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
/** The first line names the operation (and the path, encoded): tests' stand-in shells read it. */
const head = (op, path, extra = '') => `# ocm-files ${op} ${b64(path)}${extra ? ' ' + extra : ''}`;
// decode the path inside the shell; the x keeps a trailing newline in a name (command substitution drops them)
const decode = (path) => `p=$(printf '%s' '${b64(path)}' | base64 -d; printf x); p=\${p%x}`;
// the real path (links resolved by Linux), refused when it is, or is in, the hidden folder – or is Claude Code's sign-in
const resolve = (hidden) =>
  [
    `H='${hidden.replace(/'/g, '')}'`,
    `C='${homeOf(hidden).replace(/'/g, '')}'`,
    'r=$(realpath "$p" 2>/dev/null) || { echo "@@ERR missing"; exit 0; }',
    '[ -e "$r" ] || { echo "@@ERR missing"; exit 0; }',
    'case "$r/" in "$H"/*) echo "@@ERR hidden"; exit 0;; esac',
    'case "$r" in "$C/.claude/.credentials.json"|"$C/.claude/backups"|"$C/.claude/backups/"*|"$C/.claude.json"|"$C/.claude.json."*) echo "@@ERR hidden"; exit 0;; esac',
    'echo "@@REAL"',
    "printf '%s\\n' \"$r\"",
  ].join('\n');

/** One folder: every entry's raw mode, size, time and name; which links lead to folders; item counts of the folders. */
export function listCmd(path, { hidden = HIDDEN } = {}) {
  return [
    head('list', path),
    '(',
    decode(path),
    resolve(hidden),
    '[ -d "$r" ] || { echo "@@ERR notdir"; exit 0; }',
    'cd "$r" 2>/dev/null || { echo "@@ERR denied"; exit 0; }',
    'echo "@@STAT"',
    `stat -c '%f|%s|%Y|%n' -- * .[!.]* ..?* 2>/dev/null | head -n ${STAT_CAP}`,
    'echo "@@LINKDIRS"',
    'for f in * .[!.]* ..?*; do if [ -L "$f" ] && [ -d "$f" ]; then printf \'%s\\n\' "$f"; fi; done',
    'echo "@@COUNT"',
    // counted with the shell's own glob and test (no process per folder)
    'for d in */ .[!.]*/ ..?*/; do [ -d "$d" ] || continue; [ -L "${d%/}" ] && continue; case "$d" in .git/|node_modules/) continue;; esac; n=0; for x in "$d"* "$d".[!.]* "$d"..?*; do if [ -e "$x" ] || [ -L "$x" ]; then n=$((n+1)); fi; done; printf \'%s|%s\\n\' "$n" "${d%/}"; done',
    'echo "@@END"',
    ')',
  ].join('\n');
}

/** What a path is (file, folder), its size and time, and – for a file – one 1 MiB piece of it as base64. */
export function readCmd(path, { chunk = 0, bytes = true, hidden = HIDDEN } = {}) {
  return [
    head('read', path, String(bytes ? chunk : -1)),
    '(',
    decode(path),
    resolve(hidden),
    'if [ -d "$r" ]; then echo "@@DIR"; exit 0; fi',
    '[ -f "$r" ] || { echo "@@ERR notfile"; exit 0; }',
    '[ -r "$r" ] || { echo "@@ERR denied"; exit 0; }',
    'echo "@@SIZE"',
    'stat -L -c \'%s|%Y\' "$r"',
    ...(bytes ? ['echo "@@B64"', `dd if="$r" bs=${CHUNK} skip=${Math.max(0, chunk | 0)} count=1 2>/dev/null | base64`] : []),
    'echo "@@END"',
    ')',
  ].join('\n');
}

/** Sizes of folders (du -sk), for .git and node_modules rows. */
export function sizeCmd(path, names, { hidden = HIDDEN } = {}) {
  const list = names.map((n) => `"$(printf '%s' '${b64(n)}' | base64 -d)"`).join(' ');
  return [head('du', path, names.map((n) => b64(n)).join(',')), '(', decode(path), resolve(hidden), 'cd "$r" 2>/dev/null || { echo "@@ERR denied"; exit 0; }', 'echo "@@DU"', `du -sk -- ${list} 2>/dev/null`, 'echo "@@END"', ')'].join('\n');
}

/** Every file under a folder (size and path), leaving out the hidden folder, .git and node_modules, which are named. */
export function treeCmd(path, { hidden = HIDDEN, cap = COPY_MAX_FILES * 4 } = {}) {
  return [
    head('tree', path),
    '(',
    decode(path),
    resolve(hidden),
    '[ -d "$r" ] || { echo "@@ERR notdir"; exit 0; }',
    'echo "@@FILES"',
    `find "$r" \\( -path "$H" -o -path "$C/.claude/.credentials.json" -o -path "$C/.claude/backups" -o -path "$C/.claude.json" -o -path "$C/.claude.json.*" -o -type d \\( -name .git -o -name node_modules \\) \\) -prune -o -type f -print0 2>/dev/null | xargs -0 -r stat -c '%s|%n' 2>/dev/null | head -n ${cap + 1}`,
    'echo "@@SKIPPED"',
    'find "$r" -path "$H" -prune -o -type d \\( -name .git -o -name node_modules \\) -prune -print 2>/dev/null | head -n 50',
    'echo "@@END"',
    ')',
  ].join('\n');
}

// ---------- reading the answers ----------
/** Sections of an answer: { REAL: [...lines], STAT: [...], ... }; @@ERR becomes .error. */
export function sections(output) {
  const out = {};
  let cur = null;
  for (const line of String(output || '').split('\n')) {
    const m = /^@@([A-Z0-9]+)(?: (.*))?$/.exec(line);
    if (m) {
      if (m[1] === 'ERR') out.error = m[2] || 'error';
      cur = m[1];
      out[cur] ||= [];
      continue;
    }
    if (cur) out[cur].push(line);
  }
  return out;
}

/**
 * Lines "a|b|c|rest" where rest may itself hold a newline (a file name can): a line that does not start the way
 * a record does belongs to the name above it.
 */
function records(lines, re) {
  const out = [];
  for (const line of lines || []) {
    const m = re.exec(line);
    if (m) out.push(m.slice(1));
    else if (out.length && line !== '') out[out.length - 1][out[out.length - 1].length - 1] += '\n' + line;
  }
  return out;
}

const kindOf = (hex) => {
  const mode = parseInt(hex, 16) & 0o170000;
  return mode === 0o040000 ? 'dir' : mode === 0o120000 ? 'link' : 'file';
};

/** A folder's answer -> { real, entries, total, more, error }. Folders first, then by name; at most cap rows. */
export function parseList(output, { cap = LIST_CAP, hidden = HIDDEN } = {}) {
  const s = sections(output);
  if (s.error) return { error: s.error };
  if (!s.STAT) return { error: 'no answer' };
  const real = (s.REAL || []).join('\n') || '/';
  const linkDirs = new Set(s.LINKDIRS || []);
  const counts = new Map(records(s.COUNT, /^(\d+)\|(.*)$/).map(([n, name]) => [name, Number(n)]));
  const entries = [];
  for (const [hex, size, mtime, name] of records(s.STAT, /^([0-9a-fA-F]+)\|(\d+)\|(\d+)\|(.*)$/)) {
    if (!name || name === '.' || name === '..' || name.includes('/')) continue;
    const path = joinPath(real, name);
    if (isHidden(path, hidden)) continue; // ~/.config/chronicle: not even its name
    const kind = kindOf(hex);
    const e = { name, path, kind, isDir: kind === 'dir' || (kind === 'link' && linkDirs.has(name)), size: Number(size), mtime: Number(mtime) * 1000 };
    if (counts.has(name)) e.count = counts.get(name);
    if (HEAVY.has(name) && e.isDir) e.heavy = true;
    entries.push(e);
  }
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  return { real, all: entries, entries: entries.slice(0, cap), total: entries.length, more: Math.max(0, entries.length - cap) };
}

/** A read's answer -> { error } | { dir: true, real } | { real, size, mtime, bytes? }. */
export function parseRead(output) {
  const s = sections(output);
  if (s.error) return { error: s.error };
  const real = (s.REAL || []).join('\n');
  if (s.DIR) return { dir: true, real };
  const [size, mtime] = String((s.SIZE || [])[0] || '').split('|').map(Number);
  if (!s.SIZE || !Number.isFinite(size)) return { error: 'no answer' };
  const out = { real, size, mtime: (mtime || 0) * 1000 };
  if (s.B64) out.bytes = unB64(s.B64.join(''));
  return out;
}

export function parseTree(output, { hidden = HIDDEN } = {}) {
  const s = sections(output);
  if (s.error) return { error: s.error };
  const real = (s.REAL || []).join('\n');
  const pre = real === '/' ? '/' : real + '/';
  const files = [];
  for (const [size, full] of records(s.FILES, /^(\d+)\|(\/.*)$/)) {
    if (!full.startsWith(pre) || isHidden(full, hidden)) continue;
    const rel = full.slice(pre.length);
    if (rel.split('/').some((x) => HEAVY.has(x))) continue;
    files.push({ path: full, rel, size: Number(size) });
  }
  const skipped = (s.SKIPPED || []).filter(Boolean).map((p) => (p.startsWith(pre) ? p.slice(pre.length) : p));
  return { real, files, skipped };
}

export function parseSizes(output) {
  const s = sections(output);
  if (s.error) return {};
  return Object.fromEntries(records(s.DU, /^(\d+)\s+(.*)$/).map(([kb, name]) => [name, Number(kb) * 1024]));
}

/**
 * Why a file must not be shown, saved or copied ('' when it may): a private key (whatever its name), or text
 * that carries the GitHub token (gh's hosts.yml, a remote URL with the token in it).
 */
export function secretReason(bytes) {
  if (!bytes?.byteLength) return '';
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.byteLength > 4 * 1024 * 1024 ? bytes.subarray(0, 4 * 1024 * 1024) : bytes);
  if (/^\s*-----BEGIN[^\n]*PRIVATE KEY/.test(text) || /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text) || /^PuTTY-User-Key-File-/.test(text)) return 'private key – not shown';
  if (scrubToken(text) !== text) return 'holds your GitHub token – not shown';
  if (hasClaudeToken(text)) return 'holds a Claude Code sign-in – not shown';
  return '';
}

// ---------- running them ----------
let queue = Promise.resolve();
/** One command at a time in the browser's shell (the shell answers one command per id). */
function run(cmd, timeoutMs = 30000) {
  const p = queue.then(() => runShell(cmd, { id: SHELL_ID, timeoutMs }));
  queue = p.catch(() => {});
  return p.then((r) => {
    if (r?.timedOut) throw new Error('The shell took too long to answer – try again');
    return String(r?.output ?? '');
  });
}

const MESSAGES = { hidden: "That is private to the app (your GitHub sign-in and SSH key) or to Claude Code (its own sign-in) – it is not shown here.", missing: 'That path does not exist.', notdir: 'That is not a folder.', notfile: 'That is not a regular file.', denied: 'That cannot be read.' };
export const errorText = (code) => MESSAGES[code] || 'Could not read it (' + code + ')';

/** List one folder. -> parseList(...) */
export async function listDir(path) {
  const p = normPath(path);
  if (isHidden(p)) return { error: 'hidden' };
  return parseList(await run(listCmd(p)));
}

/**
 * The sizes of folders (du). In a shell of its own (decision 193): counting a big tree takes a while, and in the browser's
 * shell it held up the next folder being opened. A newer count stops the one before it (the folder changed).
 */
let sizing = 0;
let counting = false; // a count is running in its shell now
export async function folderSizes(path, names) {
  if (!names.length) return {};
  const mine = ++sizing;
  if (counting) await killShell(SIZE_SHELL)?.catch?.(() => {}); // the folder shown before: its count is not wanted any more
  if (mine !== sizing) return {};
  counting = true;
  const r = await runShell(sizeCmd(normPath(path), names), { id: SIZE_SHELL, timeoutMs: 60000 }).catch(() => null);
  if (mine === sizing) counting = false;
  return mine === sizing && r && !r.timedOut ? parseSizes(String(r.output ?? '')) : {};
}

/** Where a path really is and what it is, without its bytes. */
export async function statPath(path) {
  const p = normPath(path);
  if (isHidden(p)) return { error: 'hidden' };
  const r = parseRead(await run(readCmd(p, { bytes: false })));
  if (!r.error && isHidden(r.real)) return { error: 'hidden' };
  return r;
}

const DIRECT = /^\/(root|tmp|home|etc|usr|opt|srv|var)\//; // inside the root filesystem itself (not /proc, /sdcard, a bind)
async function directRead(real, size) {
  if (globalThis.__ocmShell || !Capacitor.isNativePlatform() || !DIRECT.test(real) || typeof fetch !== 'function') return null;
  try {
    const { uri } = await Filesystem.getUri({ path: 'linux/rootfs' + real, directory: Directory.Data });
    const res = await fetch(Capacitor.convertFileSrc(uri), { cache: 'no-store' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength === size ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * A whole file: { real, size, mtime, bytes } or { error } ('hidden', 'toobig', 'secret' with .reason …).
 * Private keys and token files are refused here, so no caller can show, save or copy one.
 */
export async function readLinuxFile(path, { max = READ_MAX, onProgress } = {}) {
  const st = await statPath(path);
  if (st.error || st.dir) return st.dir ? { error: 'notfile' } : st;
  if (st.size > max) return { ...st, error: 'toobig' };
  let bytes = await directRead(st.real, st.size);
  if (!bytes) {
    const parts = [];
    let got = 0;
    for (let i = 0; got < st.size || i === 0; i++) {
      const r = parseRead(await run(readCmd(st.real, { chunk: i }), 60000));
      if (r.error) return r;
      if (!r.bytes?.byteLength) break;
      parts.push(r.bytes);
      got += r.bytes.byteLength;
      onProgress?.(got, st.size);
      if (r.bytes.byteLength < CHUNK) break;
    }
    bytes = new Uint8Array(got);
    let off = 0;
    for (const b of parts) {
      bytes.set(b, off);
      off += b.byteLength;
    }
  }
  const reason = secretReason(bytes);
  if (reason) return { ...st, error: 'secret', reason };
  return { ...st, bytes };
}

/** The files a folder copy would take, within the caps. -> { real, files, skipped, more, bytes, tooBig } */
export async function planFolderCopy(path, { maxFiles = COPY_MAX_FILES, maxBytes = COPY_MAX_BYTES } = {}) {
  const p = normPath(path);
  if (isHidden(p)) return { error: 'hidden' };
  const t = parseTree(await run(treeCmd(p, { cap: maxFiles * 4 }), 120000));
  if (t.error) return t;
  const take = [];
  let bytes = 0;
  let tooBig = 0;
  for (const f of t.files) {
    if (take.length >= maxFiles) break;
    if (bytes + f.size > maxBytes) {
      tooBig++;
      continue;
    }
    take.push(f);
    bytes += f.size;
  }
  return { real: t.real, files: take, skipped: t.skipped, more: t.files.length - take.length - tooBig, tooBig, bytes, seen: t.files.length };
}

/**
 * Which of the picked phone-folder files ({ path, size }) a copy into the chat takes: within the same caps as a Linux
 * folder copy, leaving out git data and packages. -> { files, skipped (the left-out folders), more, bytes }
 */
export function planPickedCopy(sel, { maxFiles = COPY_MAX_FILES, maxBytes = COPY_MAX_BYTES } = {}) {
  const skipped = new Set();
  const files = [];
  let bytes = 0;
  let more = 0;
  for (const x of sel) {
    const heavy = x.path.split('/').slice(0, -1).find((seg) => seg === '.git' || seg === 'node_modules');
    if (heavy) {
      skipped.add(x.path.slice(0, x.path.indexOf(heavy) + heavy.length));
      continue;
    }
    if (files.length >= maxFiles || bytes + x.size > maxBytes) {
      more++;
      continue;
    }
    files.push(x);
    bytes += x.size;
  }
  return { files, skipped: [...skipped], more, bytes };
}
