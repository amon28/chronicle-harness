// A safety net for shell commands the assistant runs: a command that could wipe something it cannot get back (the
// user's phone files, everything outside the workspace, git history) is shown to the user first, even in ⚡ Auto.
// The command is parsed the way a shell would split it (; && || | &, quotes, $( ) and backticks, sudo/env/command
// prefixes, sh -c "…", heredoc bodies), then each simple command is matched against one table of rules (RULES).
// Pure logic: engine.js asks the user when shellDanger() returns a reason. Hooks and !commands are the user's own
// and never come through here.

import { isClaudePrivate } from './claudesecrets.js';

/** Where the shell keeps the chat's files, and the folders that hold the user's own phone files. */
export const WORKSPACE = '/workspace';
const PHONE_ROOTS = ['/phone', '/sdcard', '/storage', '/mnt/sdcard'];
const SCRATCH = ['/tmp']; // a path below these may be removed freely (not the folder itself)

// ---------- lexer ----------
const OPS = ['&&', '||', '|&', ';;', ';', '|', '&', '\n', '(', ')'];

/**
 * Split a command line into words and operators. Words carry `dyn` (a $variable or $(…) the guard cannot know before it
 * runs) and `glob` (an unquoted * ? or [). Command substitutions are returned in `subs` to be checked as commands too.
 * → { tokens: [{ t: 'w', v, dyn, glob } | { t: 'op', v } | { t: 'redir', v, target }], subs: [string] }
 */
export function lex(src) {
  const s = String(src || '');
  const tokens = [];
  const subs = [];
  const heredocs = []; // delimiters waiting for the next newline
  let i = 0;
  let word = null;
  const startWord = () => (word ||= { t: 'w', v: '', dyn: false, glob: false, quoted: false });
  const endWord = () => {
    if (word) tokens.push(word);
    word = null;
  };
  // the matching ) of a $( at i (i points just after "$("), skipping quotes
  const closeParen = (j) => {
    let depth = 1;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') j += 2;
      else if (c === "'") j = s.indexOf("'", j + 1) < 0 ? s.length : s.indexOf("'", j + 1) + 1;
      else if (c === '"') {
        j++;
        while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
        j++;
      } else if (c === '(') (depth++, j++);
      else if (c === ')') {
        if (--depth === 0) return j;
        j++;
      } else j++;
    }
    return s.length;
  };
  const dollar = () => {
    // at s[i] === '$'
    startWord();
    if (s[i + 1] === '(') {
      const end = closeParen(i + 2);
      if (s[i + 2] !== '(') subs.push(s.slice(i + 2, end)); // $(( arithmetic )) is not a command
      word.v += '$(…)';
      word.dyn = true;
      i = end + 1;
      return;
    }
    if (/[A-Za-z_{0-9@*#?$!-]/.test(s[i + 1] || '')) {
      word.dyn = true;
      // keep the name, so ${HOME} and $HOME can be resolved
      const m = /^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(s.slice(i));
      word.v += m ? m[0] : '$';
      i += m ? m[0].length : 1;
      return;
    }
    word.v += '$';
    i++;
  };
  const backtick = () => {
    const end = s.indexOf('`', i + 1);
    const stop = end < 0 ? s.length : end;
    subs.push(s.slice(i + 1, stop));
    startWord();
    word.v += '$(…)';
    word.dyn = true;
    i = stop + 1;
  };
  const readHeredocBodies = () => {
    // i is just after a newline: skip each pending heredoc's body up to its delimiter line
    while (heredocs.length) {
      const { delim, strip } = heredocs.shift();
      for (;;) {
        if (i >= s.length) return;
        const nl = s.indexOf('\n', i);
        const line = s.slice(i, nl < 0 ? s.length : nl);
        i = nl < 0 ? s.length : nl + 1;
        if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
      }
    }
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\n') {
        i += 2; // a line continuation
        continue;
      }
      startWord();
      word.v += s[i + 1] ?? '';
      word.quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      startWord();
      word.quoted = true;
      const end = s.indexOf("'", i + 1);
      word.v += s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '"') {
      startWord();
      word.quoted = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && /["\\$`\n]/.test(s[i + 1] || '')) {
          word.v += s[i + 1];
          i += 2;
        } else if (s[i] === '$') dollar();
        else if (s[i] === '`') backtick();
        else word.v += s[i++];
      }
      i++;
      continue;
    }
    if (c === '$') {
      dollar();
      continue;
    }
    if (c === '`') {
      backtick();
      continue;
    }
    if (c === '#' && !word) {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    // redirections: [n]> [n]>> >| &> &>> < << <<- <<< >&n
    const red = /^(\d*)(>>|>\||>&|>|&>>|&>|<<<|<<-|<<|<&|<>|<)/.exec(s.slice(i));
    if (red && (!word || /^\d+$/.test(word.v) || red[1] === '')) {
      endWord();
      const op = red[2];
      i += red[0].length;
      while (s[i] === ' ' || s[i] === '\t') i++;
      // the target word (quotes and $ only: enough to know where it points)
      let target = '';
      let dyn = false;
      // read one word with the same rules (simplified: quotes and $)
      while (i < s.length && !/[\s;&|()<>]/.test(s[i])) {
        if (s[i] === "'") {
          const end = s.indexOf("'", i + 1);
          target += s.slice(i + 1, end < 0 ? s.length : end);
          i = end < 0 ? s.length : end + 1;
        } else if (s[i] === '"') {
          const end = s.indexOf('"', i + 1);
          const inner = s.slice(i + 1, end < 0 ? s.length : end);
          if (inner.includes('$')) dyn = true;
          target += inner;
          i = end < 0 ? s.length : end + 1;
        } else {
          if (s[i] === '$' || s[i] === '`') dyn = true;
          target += s[i++];
        }
      }
      if (op === '<<' || op === '<<-') heredocs.push({ delim: target, strip: op === '<<-' });
      else if (!(op === '>&' && /^\d+$|^-$/.test(target)) && op !== '<&') tokens.push({ t: 'redir', v: op, target, dyn });
      continue;
    }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (op) {
      endWord();
      tokens.push({ t: 'op', v: op });
      i += op.length;
      if (op === '\n' && heredocs.length) readHeredocBodies();
      continue;
    }
    startWord();
    if (c === '*' || c === '?' || c === '[') word.glob = true;
    word.v += c;
    i++;
  }
  endWord();
  return { tokens, subs };
}

// ---------- simple commands ----------
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'case', 'esac', '!', '{', '}', 'time']);
// prefixes that run the rest as a command; the number is how many of their own options take a value
const WRAPPERS = {
  sudo: /^-(u|g|h|p|C|D|r|t|U)$/,
  doas: /^-(u|C)$/,
  env: /^-(u|C|S)$/,
  command: null,
  builtin: null,
  exec: /^-a$/,
  nohup: null,
  nice: /^-n$/,
  ionice: /^-(c|n|p)$/,
  timeout: /^-(s|k)$/,
  stdbuf: /^-(i|o|e)$/,
  chroot: null,
  busybox: null,
  xargs: /^-(I|L|n|P|d|E|s|a)$/,
  watch: /^-(n|d)$/,
  proot: null,
  sshpass: /^-(p|f|d|P)$/,
};
const base = (w) => String(w || '').split('/').pop();

/** The words of one simple command with its wrappers (sudo, env X=1, timeout 5…) taken off. → { argv, via } */
export function unwrap(words) {
  let w = words.slice();
  const via = [];
  for (let guard = 0; guard < 12 && w.length; guard++) {
    while (w.length && KEYWORDS.has(w[0].v)) w.shift();
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0].v) && !w[0].quoted) w.shift(); // VAR=value before a command
    if (!w.length) break;
    const name = base(w[0].v);
    if (!(name in WRAPPERS)) break;
    via.push(name);
    w.shift();
    const takesValue = WRAPPERS[name];
    // timeout DURATION and nice/ionice values: skip the wrapper's own options and arguments
    while (w.length && w[0].v.startsWith('-') && w[0].v !== '-') {
      const o = w.shift().v;
      if (o === '--') break;
      if (takesValue?.test(o) && w.length) w.shift();
    }
    if (name === 'env') while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0].v)) w.shift();
    if (name === 'timeout' && w.length && /^\d/.test(w[0].v)) w.shift();
    if (name === 'busybox' && w.length && w[0].v.startsWith('-')) w.shift();
  }
  return { argv: w, via };
}

const DEPTH = 4;
// ssh's own options that take a value (ssh -p 22 -i key host cmd)
const SSH_VALUE = /^-[BbcDEeFIiJLlmOoPpQRSWw]$/;
/** ssh [options] host [command…] → { host, payload } (payload '' for a login); null when it is not that. */
export function sshPayload(args) {
  let k = 0;
  while (k < args.length && args[k].v.startsWith('-') && args[k].v !== '-') {
    if (args[k].v === '--') {
      k++;
      break;
    }
    k += SSH_VALUE.test(args[k].v) ? 2 : 1;
  }
  const host = args[k];
  if (!host) return null;
  // the remote shell gets the words joined by spaces and splits them again, as ssh itself does
  return { host: host.v, payload: args.slice(k + 1).map((a) => a.v).join(' ') };
}
/** ansible <hosts> [-m shell|command|raw] -a "<command>" → the command; '' for another module or none. */
function ansiblePayload(args) {
  let mod = 'command';
  let a = '';
  for (let k = 0; k < args.length; k++) {
    const v = args[k].v;
    if (v === '-m' || v === '--module-name') mod = args[++k]?.v || '';
    else if (v.startsWith('--module-name=')) mod = v.split('=')[1];
    else if (v === '-a' || v === '--args') a = args[++k]?.v || '';
    else if (v.startsWith('--args=')) a = v.slice(7);
  }
  return /^(ansible\.builtin\.)?(shell|command|raw)$/.test(mod) ? a : '';
}

/**
 * Every simple command in a command line, with the directory it would run in when the line itself says so (cd /x &&).
 * Commands inside $( ), backticks and sh -c / bash -c / eval strings are included, and what ssh host "…" and
 * ansible … -a "…" run on another computer, marked `remote` (decision 274).
 * → [{ name, args: [word], redirects: [{ op, target, dyn }], cwd, via, pipeFrom, remote }]
 */
export function commands(src, { cwd = WORKSPACE, depth = 0, remote = '' } = {}) {
  const { tokens, subs } = lex(src);
  const out = [];
  let cur = { words: [], redirects: [] };
  let dir = cwd;
  let prev = null; // the command before a | in this pipeline
  const flush = (op) => {
    const { argv, via } = unwrap(cur.words);
    const entry = argv.length || cur.redirects.length ? { name: argv.length ? base(argv[0].v) : '', args: argv.slice(1), redirects: cur.redirects, cwd: dir, via, pipeFrom: prev, ...(remote ? { remote } : {}) } : null;
    if (entry) {
      out.push(entry);
      // cd changes where the commands after it run (an unknown target makes the directory unknown)
      if (entry.name === 'cd' || entry.name === 'pushd') {
        const t = entry.args.find((a) => !a.v.startsWith('-') || a.v === '-');
        dir = !t ? '/root' : t.v === '-' || t.dyn ? null : resolvePath(dir, t.v);
      }
      // sh -c "…", bash -c '…', eval "…": the string is a command line of its own
      if (depth < DEPTH && ['sh', 'bash', 'ash', 'dash', 'zsh', 'ksh'].includes(entry.name)) {
        const k = entry.args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a.v));
        if (k >= 0 && entry.args[k + 1]) out.push(...commands(entry.args[k + 1].v, { cwd: dir, depth: depth + 1, remote }));
      }
      if (depth < DEPTH && entry.name === 'eval' && entry.args.length) out.push(...commands(entry.args.map((a) => a.v).join(' '), { cwd: dir, depth: depth + 1, remote }));
      // ssh nas "rm -rf /volume1/backup", ansible all -a "…": the same rules on the other computer, where the folder it
      // starts in is not known (its home) and nothing is the workspace (decision 274)
      if (depth < DEPTH && entry.name === 'ssh') {
        const s = sshPayload(entry.args);
        if (s?.payload) out.push(...commands(s.payload, { cwd: null, depth: depth + 1, remote: s.host }));
      }
      if (depth < DEPTH && entry.name === 'ansible') {
        const a = ansiblePayload(entry.args);
        if (a) out.push(...commands(a, { cwd: null, depth: depth + 1, remote: entry.args.find((x) => !x.v.startsWith('-'))?.v || 'the ansible hosts' }));
      }
      // xargs CMD: CMD runs with what comes in on stdin as more arguments
      if (entry.via.includes('xargs') && entry.name) entry.fromStdin = true;
    }
    prev = op === '|' || op === '|&' ? entry : null;
    cur = { words: [], redirects: [] };
  };
  for (const t of tokens) {
    if (t.t === 'w') cur.words.push(t);
    else if (t.t === 'redir') cur.redirects.push(t);
    else flush(t.v);
  }
  flush('');
  if (depth < DEPTH) for (const sub of subs) out.push(...commands(sub, { cwd: dir, depth: depth + 1, remote }));
  return out;
}

// ---------- paths ----------
/** An absolute, normalised path; null when it cannot be known (relative to an unknown directory). */
export function resolvePath(cwd, p) {
  let s = String(p ?? '');
  if (s === '~' || s.startsWith('~/')) s = '/root' + s.slice(1);
  else if (/^\$\{?HOME\}?(\/|$)/.test(s)) s = s.replace(/^\$\{?HOME\}?/, '/root');
  if (!s.startsWith('/')) {
    if (cwd == null) return null;
    s = cwd + '/' + s;
  }
  const parts = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return '/' + parts.join('/');
}
const under = (p, root) => p === root || p.startsWith(root + '/');
export const onPhone = (p) => !!p && PHONE_ROOTS.some((r) => under(p, r));
const knownVar = (w) => /^\$\{?HOME\}?(\/|$)/.test(w.v) && !/\$(?!\{?HOME\b)/.test(w.v.replace(/^\$\{?HOME\}?/, ''));

// folders a build or an install makes again: removing one anywhere but on the phone is not asked about – rm -rf
// node_modules in /root/proj asked because it was "outside the workspace" (decision 274)
export const REBUILDABLE = new Set(['node_modules', 'dist', 'build', '.next', '.cache', 'coverage', 'target', '__pycache__']);
/** The path names a rebuildable folder by its own last name (no .., the name itself not a glob or a variable). */
function rebuildable(w) {
  const segs = String(w.v || '').split('/').filter(Boolean);
  return segs.length > 0 && REBUILDABLE.has(segs.at(-1)) && !segs.includes('..');
}

/** Why removing this path (recursively) needs the user's OK, or '' when it is fine. `remote`: on that computer. */
function removeRisk(cwd, w, remote = '') {
  if (rebuildable(w) && (remote || !onPhone(resolvePath(cwd, w.v)))) return '';
  if (remote) return `it deletes ${w.v} on ${remote}`;
  if (w.dyn && !knownVar(w)) return `the path "${w.v}" is only known when it runs (a variable or a command)`;
  const p = resolvePath(cwd, w.v);
  if (p == null) return `"${w.v}" is relative to a folder that is not known before it runs`;
  if (onPhone(p)) return `it deletes files on your phone (${p})`;
  const top = p.replace(/\/[^/]*$/, '') || '/';
  const leaf = p.split('/').pop();
  if (p === WORKSPACE || (top === WORKSPACE && w.glob && /^[.*]*\*[.*]*$/.test(leaf))) return 'it deletes the whole workspace';
  if (under(p, WORKSPACE)) return '';
  if (SCRATCH.some((r) => p.startsWith(r + '/')) && !(w.glob && /^\*+$/.test(leaf) && SCRATCH.includes(top))) return '';
  return `it deletes ${p}, outside the workspace`;
}

const shortFlags = (args) => args.filter((a) => /^-[A-Za-z]+$/.test(a.v)).map((a) => a.v.slice(1)).join('');
const hasLong = (args, ...names) => args.some((a) => names.some((n) => a.v === n || a.v.startsWith(n + '=')));
const operands = (args) => {
  const out = [];
  let opts = true;
  for (const a of args) {
    if (opts && a.v === '--') {
      opts = false;
      continue;
    }
    if (opts && a.v.startsWith('-') && a.v !== '-') continue;
    out.push(a);
  }
  return out;
};
/** git's subcommand and its arguments, past global options (-C dir, -c k=v, --git-dir=…). */
function gitSub(args) {
  let k = 0;
  while (k < args.length && args[k].v.startsWith('-')) k += /^-(C|c)$|^--(git-dir|work-tree|namespace)$/.test(args[k].v) ? 2 : 1;
  return { sub: args[k]?.v || '', rest: args.slice(k + 1) };
}

// ---------- the rules ----------
/**
 * One table: each rule looks at one simple command and returns why it needs the user's OK, or ''.
 * c = { name, args, redirects, cwd, via, pipeFrom, fromStdin }
 */
export const RULES = [
  {
    id: 'rm-recursive',
    what: 'rm -r / -rf outside the workspace, of the workspace itself, or of anything on the phone',
    test(c) {
      if (c.name !== 'rm') return '';
      const flags = shortFlags(c.args);
      const recursive = /[rR]/.test(flags) || hasLong(c.args, '--recursive');
      let targets = operands(c.args);
      // find … | xargs rm -rf: the paths find searches are what gets removed
      if (!targets.length && c.fromStdin) {
        if (c.pipeFrom?.name === 'find') targets = findPaths(c.pipeFrom).map((w) => ({ ...w, v: w.v.replace(/\/+$/, '') + '/found' })); // what is found inside, not the folder
        else if (recursive) return 'rm -r gets its paths from the input, so what it deletes is not known before it runs';
      }
      for (const t of targets) {
        const risk = removeRisk(c.cwd, t, c.remote);
        if (!risk) continue;
        // a single file outside the workspace is fine; anything on the phone is not
        if (recursive || (!c.remote && onPhone(resolvePath(c.cwd, t.v)))) return `rm${recursive ? ' -r' : ''}: ${risk}`;
      }
      return '';
    },
  },
  {
    id: 'find-delete',
    what: 'find … -delete (or -exec rm) on the phone',
    test(c) {
      if (c.name !== 'find') return '';
      const deletes = c.args.some((a) => a.v === '-delete') || c.args.some((a, k) => /^-exec(dir)?$/.test(a.v) && base(c.args[k + 1]?.v) === 'rm');
      if (!deletes) return '';
      if (c.remote) return `find -delete removes files on ${c.remote}`;
      const paths = findPaths(c);
      const p = paths.map((w) => resolvePath(c.cwd, w.v)).find((x) => x == null || onPhone(x));
      if (p === undefined) return '';
      return p == null ? 'find -delete in a folder that is not known before it runs' : `find -delete removes files on your phone (${p})`;
    },
  },
  {
    id: 'git',
    what: 'git reset --hard, push --force, clean -f, checkout -- ., branch -D',
    test(c) {
      if (c.name !== 'git') return '';
      const { sub, rest } = gitSub(c.args);
      const flags = shortFlags(rest);
      if (sub === 'reset' && hasLong(rest, '--hard')) return 'git reset --hard throws away uncommitted changes';
      if (sub === 'push' && (hasLong(rest, '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete') || /f/.test(flags) || /d/.test(flags) || operands(rest).some((a) => a.v.startsWith('+') || /^:/.test(a.v)))) return 'git push with --force (or a delete) rewrites or removes history on the remote';
      if (sub === 'clean' && (/f/.test(flags) || hasLong(rest, '--force'))) return 'git clean -f deletes files git does not track';
      if (sub === 'checkout' && rest.some((a, k) => (a.v === '--' && rest.slice(k + 1).some((b) => b.v === '.' || /^[.*]+$/.test(b.v))) || (a.v === '.' && !rest.some((b) => b.v === '--')))) return 'git checkout . throws away uncommitted changes';
      if (sub === 'restore' && operands(rest).some((a) => a.v === '.') && !hasLong(rest, '--staged')) return 'git restore . throws away uncommitted changes';
      if (sub === 'branch' && (/D/.test(flags) || (hasLong(rest, '--delete') && (hasLong(rest, '--force') || /f/.test(flags))))) return 'git branch -D deletes a branch even when it is not merged';
      if (sub === 'stash' && ['clear', 'drop'].includes(rest[0]?.v)) return `git stash ${rest[0].v} deletes stashed work`;
      return '';
    },
  },
  {
    id: 'disk',
    what: 'dd of=, mkfs, shred',
    test(c) {
      if (c.name === 'dd' && c.args.some((a) => a.v.startsWith('of='))) return 'dd of= writes over a file or a device';
      if (c.name === 'mkfs' || c.name.startsWith('mkfs.') || c.name === 'mke2fs' || c.name === 'wipefs') return `${c.name} formats a disk`;
      if (c.name === 'shred') return 'shred destroys files for good';
      return '';
    },
  },
  {
    id: 'chmod-000',
    what: 'chmod -R 000',
    test(c) {
      if (c.name !== 'chmod' && c.name !== 'chown') return '';
      const recursive = /R/.test(shortFlags(c.args)) || hasLong(c.args, '--recursive');
      if (!recursive || c.name !== 'chmod') return '';
      const mode = operands(c.args)[0]?.v || '';
      return /^0+$/.test(mode) || /^[ugoa]*=$/.test(mode) || /^[ugoa]*-rwx$/.test(mode) ? 'chmod -R 000 locks every file in it' : '';
    },
  },
  {
    id: 'git-objects',
    what: 'deleting inside .git (objects, packs, refs) – files there can look like leftovers and are not',
    test(c) {
      if (c.name !== 'rm' && c.name !== 'shred' && c.name !== 'unlink' && !(c.name === 'find' && c.args.some((a) => a.v === '-delete'))) return '';
      const hit = [...operands(c.args), ...(c.name === 'find' ? findPaths(c) : [])].find((a) => /(^|\/)\.git\/(objects|refs)(\/|$)|(^|\/)\.git\/(packed-refs|index|HEAD)$/.test(a.v) || /\.l2s\./.test(a.v));
      return hit ? `${c.name} deletes inside git's own database (${hit.v}); a pack that looks like a leftover can be the real one – use git gc / git prune instead` : '';
    },
  },
  {
    id: 'credentials',
    what: "making or handing out long-lived credentials: ssh-keygen, ssh-add, gh ssh-key / auth token / auth login, keys written into ~/.ssh, reading or copying Claude Code's sign-in (~/.claude/.credentials.json, ~/.claude.json)",
    test(c) {
      const sub = c.args[0]?.v || '';
      // ssh-keygen only makes a key with neither of its looking/editing modes (-l fingerprint, -F/-R known hosts,
      // -y public half, -p passphrase, -E hash, combined like -lf)
      if (c.name === 'ssh-keygen' && !/[lFRyEpe]/.test(shortFlags(c.args))) return 'ssh-keygen makes a key that reaches everything you can push to and never expires, in a shell every chat shares';
      if (c.name === 'ssh-add') return 'ssh-add loads a key into an agent every command can use';
      const claude = touchesClaudeSignIn(c);
      if (claude) return claude;
      // the app's stored sign-in and SSH key: only git may use them, nothing reads or copies them
      if ([...c.args, ...c.redirects.map((r) => ({ v: r.target || '' }))].some((a) => /\.config\/chronicle\/(ssh|gh-token)/.test(String(a.v)))) return 'it touches the GitHub sign-in or SSH key the app keeps for git';
      const secret = touchesSecretFile(c);
      if (secret) return secret;
      if (c.name === 'gh' && sub === 'ssh-key' && ['add', 'delete'].includes(c.args[1]?.v)) return `gh ssh-key ${c.args[1].v} changes the SSH keys on your GitHub account`;
      if (c.name === 'gh' && sub === 'auth' && ['token', 'login', 'refresh'].includes(c.args[1]?.v)) return `gh auth ${c.args[1].v} prints or replaces the GitHub sign-in`;
      if (c.name === 'gh' && sub === 'auth' && c.args[1]?.v === 'status' && (hasLong(c.args, '--show-token') || /t/.test(shortFlags(c.args.slice(2))))) return 'gh auth status --show-token prints the GitHub sign-in';
      // git credential fill prints the stored token; approve / reject change what is stored (decision 274)
      const gs = c.name === 'git' ? gitSub(c.args).sub : '';
      if (gs === 'credential' || gs === 'credential-store' || gs === 'credential-cache') return `git ${gs} hands out or changes the stored GitHub sign-in`;
      if (c.name === 'gh' && sub === 'api' && c.args.some((a) => /(^|\/)(user\/keys|keys)(\b|$)|deploy_keys|authorizations/.test(a.v))) return 'gh api on keys or authorizations adds or changes credentials on your GitHub account';
      if (c.name === 'git' && c.args.some((a) => /^credential\.helper=?/.test(a.v) || a.v === 'credential.helper') && c.args.some((a) => /store/.test(a.v))) return 'git credential store writes a token to a plain file';
      for (const r of c.redirects) {
        const p = r.dyn ? null : resolvePath(c.cwd, r.target);
        if (p && /(^|\/)\.ssh(\/|$)/.test(p)) return `the redirect writes into ${p} (SSH keys and trusted keys)`;
      }
      if ((c.name === 'cp' || c.name === 'mv' || c.name === 'tee') && operands(c.args).some((a) => /(^|\/)\.ssh(\/|$)/.test(a.v))) return `${c.name} puts a file into ~/.ssh`;
      return '';
    },
  },
  {
    id: 'phone-overwrite',
    what: '> /phone/… (overwriting), mv/cp onto the phone, tee onto the phone',
    test(c) {
      if (c.remote) return ''; // a /phone on another computer is not the phone
      for (const r of c.redirects) {
        if (!/^(>|>\||&>)$/.test(r.v)) continue;
        const p = r.dyn ? null : resolvePath(c.cwd, r.target);
        if (onPhone(p)) return `the > redirect overwrites ${p} on your phone`;
      }
      if (c.name === 'mv' || c.name === 'cp' || c.name === 'rsync' || c.name === 'install') {
        const ops = operands(c.args);
        const tIdx = c.args.findIndex((a) => a.v === '-t' || a.v.startsWith('--target-directory'));
        const dest = tIdx >= 0 ? (c.args[tIdx].v.includes('=') ? { v: c.args[tIdx].v.split('=')[1] } : c.args[tIdx + 1]) : ops.length > 1 ? ops.at(-1) : null;
        const p = dest && !dest.dyn ? resolvePath(c.cwd, dest.v) : null;
        if (onPhone(p)) return `${c.name} writes onto your phone (${p}) and may replace files there`;
        if (c.name === 'mv') {
          const src = ops.slice(0, tIdx >= 0 ? undefined : -1).map((a) => resolvePath(c.cwd, a.v)).find(onPhone);
          if (src) return `mv takes ${src} off your phone`;
        }
      }
      if (c.name === 'tee' && !/a/.test(shortFlags(c.args)) && !hasLong(c.args, '--append')) {
        const p = operands(c.args).map((a) => resolvePath(c.cwd, a.v)).find(onPhone);
        if (p) return `tee overwrites ${p} on your phone`;
      }
      return '';
    },
  },
];

// ---------- Claude Code's sign-in (claudesecrets.js, docs/DECISIONS.md 163) ----------
// Claude Code, which the user installed and signed in to in this Linux, keeps its own sign-in in ~/.claude/.credentials.json
// (and account details in ~/.claude.json): only Claude Code may use them. No command of an assistant reads, copies or
// prints them – looking at whether they exist (ls, test, stat) is fine.
const CLAUDE_TARGETS = ['/root/.claude/.credentials.json', '/root/.claude.json', '/root/.claude.json.backup', '/root/.claude/backups'];
const LOOK_ONLY = new Set(['ls', 'test', '[', 'stat', 'du', 'claude', 'cd', 'pushd', 'mkdir']);
const TAKES_FOLDERS = new Set(['cp', 'mv', 'rsync', 'scp', 'tar', 'zip', '7z', 'rclone', 'grep', 'egrep', 'rg', 'ag', 'find', 'curl', 'wget', 'base64', 'cat']);
/** A shell glob as a regex for whole paths: * and ? stay inside one folder and do not match a leading dot. */
function globRe(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    const seg = i === 0 || p[i - 1] === '/';
    if (ch === '*') re += seg ? '(?!\\.)[^/]*' : '[^/]*';
    else if (ch === '?') re += seg ? '[^/.]' : '[^/]';
    else if (ch === '[') {
      const end = p.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        re += '[' + p.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
function touchesClaudeSignIn(c) {
  if (c.name === 'claude' && c.args[0]?.v === 'setup-token') return 'claude setup-token prints a long-lived Claude sign-in token';
  if (LOOK_ONLY.has(c.name)) return '';
  if ([...c.args, ...c.redirects.map((r) => ({ v: r.target || '' }))].some((a) => /CLAUDE_CODE_OAUTH_TOKEN|sk-ant-o[ar]t/.test(String(a.v)))) return "it handles Claude Code's sign-in token";
  // --file=PATH, curl's -F f=@PATH and -d @PATH: the path is what counts
  const words = [...c.args.map((a) => ({ ...a, v: a.v.replace(/^--?[\w-]+=/, '').replace(/^[\w-]*=?@/, '') })), ...c.redirects.map((r) => ({ v: r.target || '', dyn: r.dyn }))];
  for (const w of words) {
    if (!w.v || w.v.startsWith('-')) continue;
    const p = resolvePath(c.cwd, w.v);
    if (!p) continue;
    const hit = w.glob ? CLAUDE_TARGETS.some((t) => globRe(p).test(t)) : isClaudePrivate(p);
    if (hit) return `it reads or copies Claude Code's own sign-in (${w.v}) – only Claude Code may use it`;
    if (TAKES_FOLDERS.has(c.name) && (p === '/root/.claude' || p === '/root' || (w.glob && globRe(p).test('/root/.claude')))) return `${c.name} on ${w.v} would take Claude Code's sign-in with it`;
  }
  return '';
}

// ---------- the app's GitHub sign-in and SSH keys (decision 274) ----------
// The app keeps the GitHub token in ~/.config/chronicle/gh-token (gh's copy in ~/.config/gh/hosts.yml) and the SSH key
// in ~/.config/chronicle/ssh; the user's own keys are in ~/.ssh. Only the literal path ".config/chronicle/(ssh|gh-token)"
// was caught: cd into the folder and cat gh-token, a glob (chron*/gh-tok*), grep -r over ~/.config, gh's hosts.yml and
// git credential fill all printed the token. Now a word is resolved against the folder the line cd'd into, a glob is
// matched against the files it could hit, and tools that take whole folders (cp -r, tar, grep -r, scp -r…) ask on a
// folder that holds them. A private key (id_rsa, id_ed25519… – not .pub) asks wherever it is.
const SECRET_FILES = ['/root/.config/chronicle/gh-token', '/root/.config/chronicle/ssh/id_ed25519', '/root/.config/chronicle/ssh/id_rsa', '/root/.config/gh/hosts.yml', '/root/.git-credentials', '/root/.ssh/id_rsa', '/root/.ssh/id_ed25519', '/root/.ssh/id_ecdsa', '/root/.ssh/id_dsa', '/root/.ssh/id_ed25519_sk', '/root/.ssh/id_ecdsa_sk'];
const SECRET_DIRS = ['/root/.config/chronicle', '/root/.config/gh'];
const HOLDS_SECRETS = ['/', '/root', '/root/.config', '/root/.config/chronicle', '/root/.config/chronicle/ssh', '/root/.config/gh', '/root/.ssh'];
const KEY_NAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'id_ed25519_sk', 'id_ecdsa_sk'];
// ssh and friends use a key with -i / -o IdentityFile=…: that is using it, not handing it out
const USES_KEYS = new Set(['ssh', 'scp', 'sftp', 'ssh-copy-id', 'rsync', 'sshfs', 'autossh', 'mosh']);
const isSecretPath = (p) => SECRET_FILES.includes(p) || SECRET_DIRS.some((d) => p.startsWith(d + '/')) || KEY_NAMES.includes(p.split('/').pop());
/** A command that takes whole folders (cp -r, tar, grep -r, scp -r, rsync, zip, find -exec). */
function takesWholeFolders(c) {
  const flags = shortFlags(c.args);
  if (['tar', 'zip', '7z', 'rsync', 'rclone', 'rg', 'ag', 'ack', 'mv'].includes(c.name)) return true;
  if (c.name === 'cp' || c.name === 'scp') return /[rRa]/.test(flags) || hasLong(c.args, '--recursive', '--archive');
  if (['grep', 'egrep', 'fgrep'].includes(c.name)) return /[rR]/.test(flags) || hasLong(c.args, '--recursive', '--dereference-recursive', '--directories=recurse');
  if (c.name === 'find') return c.args.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a.v));
  return false;
}
function touchesSecretFile(c) {
  if (LOOK_ONLY.has(c.name) || c.name === 'ssh-keygen' || c.name === 'ssh-add') return ''; // looking, or a rule of their own
  const uses = USES_KEYS.has(c.name);
  const words = [];
  c.args.forEach((a, k) => {
    if (uses && (/^-[io]./.test(a.v) || ['-i', '-o', '-e'].includes(c.args[k - 1]?.v))) return; // the key it logs in with
    words.push({ ...a, v: a.v.replace(/^--?[\w-]+=/, '').replace(/^[\w-]*=?@/, '') });
  });
  for (const r of c.redirects) words.push({ v: r.target || '', dyn: r.dyn });
  const whole = takesWholeFolders(c);
  for (const w of words) {
    // host:path is on the other computer (scp ~/.ssh/id_rsa host: still names the local key)
    if (!w.v || w.v.startsWith('-') || (/^[\w.-]+(@[\w.-]+)?:/.test(w.v) && !w.v.startsWith('/'))) continue;
    const p = resolvePath(c.cwd, w.v);
    if (!p) continue;
    const leaf = p.split('/').pop();
    if (w.glob) {
      const re = globRe(p);
      const leafRe = globRe(leaf);
      if (SECRET_FILES.some((t) => re.test(t)) || (/id_/.test(leaf) && KEY_NAMES.some((n) => leafRe.test(n)))) return `${c.name} ${w.v} can match the GitHub sign-in or an SSH private key`;
      if (whole && HOLDS_SECRETS.some((d) => re.test(d))) return `${c.name} on ${w.v} would take the GitHub sign-in or SSH keys with it`;
      continue;
    }
    if (isSecretPath(p)) return `it reads or copies ${KEY_NAMES.includes(leaf) ? 'an SSH private key' : 'the GitHub sign-in the app keeps for git'} (${w.v})`;
    if (whole && HOLDS_SECRETS.includes(p)) return `${c.name} on ${w.v} would take the GitHub sign-in or SSH keys with it`;
  }
  return '';
}

/** The starting points of a find command (the words before its first expression). */
function findPaths(c) {
  const out = [];
  for (const a of c.args) {
    if (/^[-(!]/.test(a.v) && !/^-[HLP]$/.test(a.v)) break;
    if (/^-[HLP]$/.test(a.v)) continue;
    out.push(a);
  }
  return out.length ? out : [{ v: '.', dyn: false, glob: false }];
}

/**
 * Does this command need the user's OK first? → null, or { reason, rule, command } for the first match.
 * `cwd` is where the shell is assumed to start: the workspace unless the caller knows better (the chat's shell keeps
 * the folder an earlier command cd'd into, and starts in /root) – pass it when known, or null for "not known", which
 * makes a relative rm -r ask (decision 274). A `cd` in the line itself is followed.
 */
export function shellDanger(cmd, { cwd = WORKSPACE, askPush = false } = {}) {
  let list;
  try {
    list = commands(cmd, { cwd });
  } catch {
    return null; // a line the parser cannot read is not worse than before
  }
  for (const c of list) {
    // the SSH key is on and the user asked to confirm every push with it
    if (askPush && c.name === 'git' && gitSub(c.args).sub === 'push') return { reason: 'a push while the SSH key is switched on (you asked to confirm every push)', rule: 'ssh-push', command: [c.name, ...c.args.map((a) => a.v)].join(' ').slice(0, 200) };
    for (const r of RULES) {
      const reason = r.test(c);
      if (reason) return { reason, rule: r.id, command: [c.name, ...c.args.map((a) => a.v)].join(' ').slice(0, 200) };
    }
  }
  return null;
}

// ---------- for the "done" check ----------
// commands that only put files in place (or look at the folder): running one of these is not checking the work
const ONLY_FILES = new Set(['cat', 'echo', 'printf', 'tee', 'cp', 'mv', 'mkdir', 'touch', 'rm', 'rmdir', 'ln', 'chmod', 'chown', 'cd', 'pushd', 'popd', 'pwd', 'ls', 'true', ':', 'export', 'unset', 'set', 'tar', 'unzip', 'gzip', 'gunzip', 'wget', 'base64', 'dos2unix', '']);
const GIT_ONLY_FILES = new Set(['add', 'commit', 'mv', 'rm', 'status', 'diff', 'log', 'init', 'checkout', 'switch', 'restore', 'stash', 'show', 'branch', 'tag', 'config']);
/** Does this shell command run anything beyond writing, moving or listing files (a script, tests, a build, a server)? */
export function shellChecks(cmd) {
  let list;
  try {
    list = commands(cmd);
  } catch {
    return true;
  }
  return list.some((c) => {
    if (['sh', 'bash', 'ash', 'dash', 'zsh', 'ksh', 'eval'].includes(c.name) && (c.name === 'eval' || c.args.some((a) => /^-[a-z]*c[a-z]*$/.test(a.v)))) return false; // its own commands are in the list
    if (c.name === 'sed') return !/i/.test(shortFlags(c.args)) && !hasLong(c.args, '--in-place');
    if (c.name === 'git') return !GIT_ONLY_FILES.has(gitSub(c.args).sub);
    if (c.name === 'apk' || c.name === 'pip' || c.name === 'pip3') return false; // installing is not checking
    return !ONLY_FILES.has(c.name);
  });
}
