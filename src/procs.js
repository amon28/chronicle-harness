// Processes a chat's shell left running: started with `cmd &` or `nohup … &`, they outlive the tool call (a recording,
// a server, a download). Every chat shell is started with OCM_SHELL=<its id> in its environment (ShellPlugin), and a
// process inherits it, so they can be found by it in /proc. Shown as chips by the message box (jobs-ui.js).
// The scripts run in a shell of their own and take the chat's shell id base64-encoded (never as command text).

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(String(s))));
const decodeId = (id) => `S=$(printf '%s' '${b64(id)}' | base64 -d)`;

/**
 * Every process whose OCM_SHELL is the chat's shell (or its second shell, `:aux`), as
 * `pid<TAB>ppid<TAB>seconds running<TAB>command line`. The shell itself (its parent is not tagged) is marked `shell`.
 */
export function listCmd(shellId) {
  return [
    decodeId(shellId),
    // seconds since boot (may be unreadable on a phone: then each process's own /proc folder date is used)
    "up=$(cut -d' ' -f1 /proc/uptime 2>/dev/null); up=${up%.*}",
    'now=$(date +%s)',
    'hz=$(getconf CLK_TCK 2>/dev/null || echo 100)',
    'tagged() { tr "\\0" "\\n" 2>/dev/null < "/proc/$1/environ" | grep -qxF -e "OCM_SHELL=$S" -e "OCM_SHELL=$S:aux"; }',
    'for d in /proc/[0-9]*; do',
    '  p=${d#/proc/}',
    '  tagged "$p" || continue',
    "  st=$(cat \"$d/stat\" 2>/dev/null) || continue",
    '  rest=${st##*) }', // after the command name, which may hold spaces and brackets
    '  set -- $rest',
    '  pp=$2; start=${20}',
    '  if [ -n "$up" ]; then age=$(( up - start / hz )); else t=$(stat -c %Y "$d" 2>/dev/null || echo "$now"); age=$(( now - t )); fi',
    '  kind=proc; tagged "$pp" || kind=shell',
    "  cmd=$(tr '\\0' ' ' 2>/dev/null < \"$d/cmdline\" | cut -c1-300)",
    '  printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$p" "$pp" "$age" "$kind" "$cmd"',
    'done',
    'echo "@@END"',
  ].join('\n');
}

const BARE_SHELL = /^-?(\/usr)?(\/bin\/)?(sh|ash|bash|dash|busybox sh)( -[a-z]+)*$/;
export const MIN_AGE = 5; // seconds

/**
 * The lines of listCmd → the processes worth showing: the ones the shell started and left running (direct children
 * of the chat's shell), each with how many processes it has under it. → [{ pid, cmd, age, kids }]
 */
export function parseProcs(out, { minAge = MIN_AGE } = {}) {
  const rows = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^(\d+)\t(\d+)\t(-?\d+)\t(shell|proc)\t(.*)$/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], age: Math.max(0, +m[3]), kind: m[4], cmd: m[5].trim() });
  }
  const shells = new Set(rows.filter((r) => r.kind === 'shell').map((r) => r.pid));
  const byParent = new Map();
  for (const r of rows) byParent.set(r.ppid, [...(byParent.get(r.ppid) || []), r]);
  const under = (pid) => (byParent.get(pid) || []).reduce((n, c) => n + 1 + under(c.pid), 0);
  return rows
    // a bare shell (/bin/sh with nothing after it) is the app's own helper (a second shell, a pipe), not something the
    // assistant left running; and a process a few seconds old is usually the end of a command that is finishing
    .filter((r) => r.kind === 'proc' && shells.has(r.ppid) && r.cmd && !BARE_SHELL.test(r.cmd) && r.age >= minAge)
    .map((r) => ({ pid: r.pid, cmd: r.cmd, age: r.age, kids: under(r.pid) }))
    .sort((a, b) => a.pid - b.pid);
}

/**
 * Before a chat shell is dropped (a timeout, a cancel, a restart): stop what runs in it. Killing proot alone leaves its
 * processes running, detached (bug D: `sleep 90; echo finished >> f` still wrote after the job said done). Stops every
 * process tagged exactly with this shell's id – its `:aux` shell is a shell of its own – that started in the last
 * `sinceS` seconds (all of them when sinceS is null), and the shell itself (the tagged child of the app). A server
 * started earlier with `cmd &` is left alone, also once its shell has exited and it was reparented to init (bug E).
 * Ages are counted from this script's own start tick, so a faked /proc/uptime does not matter.
 * Prints `@@REAPED <n>`.
 */
const markFile = (v) => `"/tmp/.ocm-start-$(printf '%s' "${v}" | tr -c 'A-Za-z0-9' _)"`;
/**
 * Put in front of every command a chat shell runs: the start tick of a process forked as the command begins, kept
 * per shell. The reaper stops what started from then on, exactly – a server started half a second before the
 * timed-out command is not taken for part of it (a window of "the last N seconds" was: bug H).
 */
// no new process at all (each fork under proot costs ~60 ms on every command): the shell reads the time since boot
// itself – the clock process start ticks count on. Only when that cannot be read, a subshell's own start tick
// the file's name is worked out here, as the reaper's `tr` does it byte by byte: a `$(… | tr …)` would fork again
const markPath = (id) => `/tmp/.ocm-start-${[...new TextEncoder().encode(String(id))].map((b) => (/[A-Za-z0-9]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '_')).join('')}`;
export const startMark = (id) => `{ read -r ocm_up ocm_ < /proc/uptime && echo "U $ocm_up" > ${markPath(id)} || ( read -r l < /proc/self/stat && echo "$l" > ${markPath(id)} ); } 2>/dev/null; ${KEEP_FNS}`;
// `nohup cmd` / `setsid cmd` run with OCM_KEEP=1 in their environment, inherited by all they start: the reaper leaves
// those running when a command times out. Plain functions – nothing is started until they are used
const KEEP_FNS = 'nohup() { env OCM_KEEP=1 nohup "$@"; }; setsid() { env OCM_KEEP=1 setsid "$@"; }';

export function reapCmd(shellId, sinceS = null) {
  const lim = sinceS == null ? -1 : Math.max(0, Math.ceil(Number(sinceS) || 0)) + 2;
  return [
    decodeId(shellId),
    `LIM=${lim}`,
    'hz=$(getconf CLK_TCK 2>/dev/null || echo 100)',
    // "now" is the start tick of this cat itself: $$ is the reaper's long-lived shell, which may be minutes old, so
    // with it everything started since that shell looked new and was stopped, an earlier server too (bug F)
    'st=$(cat /proc/self/stat); r=${st##*) }; set -- $r; me=${20}',
    // when the command began (startMark): only what started since then is the command's
    // ("U <seconds since boot>" from the shell itself, in ticks here; else a subshell's stat line)
    `mark=; [ "$LIM" -ge 0 ] && st=$(cat ${markFile('$S')} 2>/dev/null) && case "$st" in`,
    '  "U "*) u=${st#U }; i=${u%.*}; f=${u#*.}; [ "$f" = "$u" ] && f=0; f=${f}00; f=${f%"${f#??}"}; f=${f#0}; mark=$(( i * hz + ${f:-0} * hz / 100 ));;',
    '  *) r=${st##*) }; set -- $r; mark=${20};;',
    'esac',
    'tagged() { tr "\\0" "\\n" 2>/dev/null < "/proc/$1/environ" | grep -qxF "OCM_SHELL=$S"; }',
    // the app: first ancestor of this script without a shell tag. The chat shell's root (proot) is its child; a
    // `nohup … &` server whose shell has exited is reparented to init, so "parent not tagged" alone would kill it too
    'anytag() { tr "\\0" "\\n" 2>/dev/null < "/proc/$1/environ" | grep -q "^OCM_SHELL="; }',
    'app=$$; while [ "$app" -gt 1 ] && anytag "$app"; do st=$(cat "/proc/$app/stat" 2>/dev/null) || { app=0; break; }; r=${st##*) }; set -- $r; app=$2; done',
    'recs=$(for d in /proc/[0-9]*; do',
    '  p=${d#/proc/}; [ "$p" = "$$" ] && continue',
    '  tagged "$p" || continue',
    '  st=$(cat "$d/stat" 2>/dev/null) || continue; r=${st##*) }; set -- $r; echo "$p $2 ${20}"',
    'done)',
    // the shell's root (proot, a child of the app) and the shell in it that runs the command (a child of the root):
    // that shell is old, but left alive it goes on with the rest of the line once its command is killed (bug G)
    'roots=" $(echo "$recs" | while read p pp start; do [ "$pp" = "$app" ] && echo "$p"; done | tr "\\n" " ") "',
    // started since the command began (or, without a mark, within the window): "pid:parent"
    'young=$(echo "$recs" | while read p pp start; do',
    '  [ -n "$p" ] || continue',
    '  if [ -n "$mark" ]; then [ "$start" -ge "$mark" ] && echo "$p:$pp"; elif [ $(( (me - start) / hz )) -le "$LIM" ]; then echo "$p:$pp"; fi',
    'done)',
    'if [ "$LIM" -lt 0 ]; then all=$(echo "$recs" | while read p pp start; do echo "$p"; done | tr "\\n" " "); else',
    '  ids=" $(echo "$recs" | while read p pp start; do echo "$p"; done | tr "\\n" " ") "',
    // the shell that runs the command (a child of proot), not proot itself: proot ends everything under it when it
    // ends (--kill-on-exit), an earlier server too; it is let go instead and ends by itself after its last process
    '  ks=" $(echo "$recs" | while read p pp start; do case "$roots" in *" $pp "*) echo "$p";; esac; done | tr "\\n" " ") "',
    // a young process is the command's when its parent is (or is gone: an orphan of it); a young child of an older
    // server – the date and sleep of its loop – is that server's, and is left alone with it
    // what the command asked to outlive it – `nohup …` (tagged OCM_KEEP=1 by startMark's nohup; SIGHUP cannot tell:
    // the chat shell ignores it already, inherited from the app) or `setsid …` (a session of its own) – is kept, with
    // everything under it: a dev server started and then checked on the same line survives the check timing out, as
    // it would under timeout(1). A plain `cmd &` is still stopped.
    '  keep() { tr "\\0" "\\n" 2>/dev/null < "/proc/$1/environ" | grep -qxF "OCM_KEEP=1"; }',
    '  sid() { st=$(cat "/proc/$1/stat" 2>/dev/null) || return; r=${st##*) }; set -- $r; echo "$4"; }',
    '  set -- $ks; shSid=$(sid "$1")',
    '  kp=" "',
    '  n=0; while [ $n -lt 12 ]; do n=$((n+1)); add=; more=',
    '    for e in $young; do p=${e%%:*}; pp=${e#*:}',
    '      case "$ks$kp" in *" $p "*) continue;; esac',
    '      case "$kp" in *" $pp "*) kp="$kp$p "; more=1; continue;; esac',
    '      own=; case "$ks" in *" $pp "*) own=1;; *) case "$ids" in *" $pp "*) ;; *) own=1;; esac;; esac',
    '      [ -n "$own" ] || continue',
    '      if keep "$p" || { [ -n "$shSid" ] && s=$(sid "$p") && [ -n "$s" ] && [ "$s" != "$shSid" ]; }; then',
    '        kp="$kp$p "; c=$(tr "\\0" " " 2>/dev/null < "/proc/$p/cmdline" | cut -c1-200); echo "@@KEPT $p $c"; more=1',
    '      else add="$add$p "; more=1; fi',
    '    done; [ -n "$more" ] || break; ks="$ks$add"',
    '  done; all=$ks',
    'fi',
    // frozen first, all at once: a shell cannot run its next command between its child dying and its own turn
    'set -- $all; [ $# -gt 0 ] && { kill -STOP $all 2>/dev/null; kill -KILL $all 2>/dev/null; }',
    'echo "@@REAPED $#"',
  ].join('\n');
}

/** Stop a process and everything under it (children first so nothing is left behind), only if it is the chat's. */
export function stopCmd(shellId, pid) {
  const n = Math.floor(Number(pid));
  if (!(n > 1)) throw new Error('not a process id');
  return [
    decodeId(shellId),
    `P=${n}`,
    'tr "\\0" "\\n" 2>/dev/null < "/proc/$P/environ" | grep -qxF -e "OCM_SHELL=$S" -e "OCM_SHELL=$S:aux" || { echo "@@NOTOURS"; exit 0; }',
    'tree() { for d in /proc/[0-9]*; do st=$(cat "$d/stat" 2>/dev/null) || continue; r=${st##*) }; set -- $r; if [ "$2" = "$T" ]; then c=${d#/proc/}; (T=$c; tree); echo "$c"; fi; done; }',
    'all=$(T=$P; tree); kill -TERM $all $P 2>/dev/null',
    'sleep 1',
    'kill -KILL $all $P 2>/dev/null',
    '[ -d "/proc/$P" ] && echo "@@ALIVE" || echo "@@STOPPED"',
  ].join('\n');
}
