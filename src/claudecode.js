// Claude Code in Linux: the official Claude Code CLI, installed by the user in the app's own Linux, driven from a
// chat over ACP – the same way a PC agent is (acp.js, acp-ui.js), through scripts/acp-bridge.py running inside Linux.
//
// The sign-in belongs to Claude Code: the user types `claude` in the 🐧 terminal and follows its own sign-in. Chronicle
// offers no sign-in, never reads, copies, stores, backs up or shows Claude Code's credentials, and asks only
// `claude auth status` whether it is signed in (the answer is reduced to yes/no and the kind, inside Linux). The
// ACP adapter is told we have no terminal, so it advertises no sign-in method of its own either. Decision 163.
//
// The bridge listens on 127.0.0.1 only, on a free port, with a fresh random secret that lives in this module's
// memory: it is sent on the bridge's stdin, so it is in no command line, file, log, setting or backup.
import bridgeBody from '../scripts/acp-bridge.py?raw';
import { runShell } from './shell.js';
import { httpRequest } from './api.js';

/** The program's packages (npm). The adapter was @zed-industries/claude-agent-acp, before that …/claude-code-acp. */
export const CLI_PKG = '@anthropic-ai/claude-code';
export const ACP_PKG = '@agentclientprotocol/claude-agent-acp';
export const ACP_BIN = 'claude-agent-acp';
export const NODE_MIN = 22;
/** Where Node comes from on Debian (its own nodejs is 20): the current LTS line, with its SHA256SUMS (decision 190). */
export const NODE_DIST = 'https://nodejs.org/dist/latest-v24.x';
/** Where the bridge script, its log, port and pid live in Linux (nothing secret is ever written here). */
export const DIR = '/root/.cache/chronicle-claude';
export const SHELL_ID = 'claude-code';
export const AGENT_ID = 'acp_claude_phone';
export const AGENT_NAME = 'Claude Code'; // the same name as in the model picker and the replies (it was "Claude Code (phone)")

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(String(s))));
/** A path into a command without ever being command text (the files browser does the same). */
const decodeTo = (v, s) => `${v}=$(printf '%s' '${b64(s)}' | base64 -d; printf x); ${v}=\${${v}%x}`;

/** A fresh secret for one bridge run: 24 random bytes, base64url. */
export function newSecret() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** An absolute folder inside Linux (default /root); '..' never climbs above /. */
export function cleanCwd(p) {
  const s = String(p || '').trim() || '/root';
  const abs = s === '~' || s.startsWith('~/') ? '/root' + s.slice(1) : s.startsWith('/') ? s : '/root/' + s;
  const out = [];
  for (const part of abs.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

/**
 * The install, run in the background inside Linux so it survives the 10-minute limit of one command and the app's
 * screen closing: Linux packages it lacks, a Node version check (Claude Code needs Node 22+), then the two npm
 * packages. The adapter is installed without its optional dependencies: they are a second ~350 MB copy of the Claude
 * CLI, and CLAUDE_CODE_EXECUTABLE points it at the one the user installed and signed in to instead.
 */
/**
 * After npm: does `claude` really run? The npm package's `claude` is a native program (~350 MB) its postinstall copies
 * over bin/claude.exe from a per-platform package – musl for Alpine. When that did not happen (no space, an interrupted
 * update, the glibc build) the shell says "claude: not found" for a file that is there. The log gets what is wrong,
 * the musl build is put in place, and the install fails clearly if it still does not run (no "done" with a blank version).
 */
const CLAUDE_REPAIR = `echo "== checking claude"
R=$(npm root -g); W="$R/@anthropic-ai/claude-code"; G=$(npm prefix -g)/bin/claude; E="$W/bin/claude.exe"
# the native build that fits this Linux: musl on Alpine (it has apk), the plain (glibc) one on Debian
LC=""; command -v apk >/dev/null 2>&1 && LC="-musl"
# proot fakes the hard link the postinstall makes: claude.exe becomes a symlink to a hidden .l2s. file inside the
# platform package, and the next npm update deletes that file with the package – claude is gone. A real copy instead.
if [ -L "$E" ] && [ -f "$E" ]; then echo "making claude a real file (proot's hard-link stand-in breaks on updates)"; cp "$E" "$E.tmp" && rm -f "$E" && mv "$E.tmp" "$E" && chmod 755 "$E" || rm -f "$E.tmp"; fi
if ! claude --version >/dev/null 2>&1; then
  case "$(uname -m)" in aarch64|arm64) A=arm64;; x86_64|amd64) A=x64;; *) A=unknown;; esac
  V=$(node -p "require(process.argv[1]).version" "$W/package.json" 2>/dev/null)
  echo "claude does not run. command: $(command -v claude || echo none); link: $(ls -l "$G" 2>/dev/null | sed 's/.* -> /-> /')"
  if [ -L "$E" ] && [ ! -e "$E" ]; then echo "claude points to a file that is gone: $(readlink "$E") (proot's hard-link stand-in, removed by an update)"
  elif [ -f "$E" ]; then
    if [ "$(head -c 4 "$E" | tail -c 3)" = "ELF" ]; then
      if [ -n "$LC" ] && grep -q "ld-linux" "$E" 2>/dev/null; then echo "it is the glibc build – Alpine needs the musl one"; else echo "it is a native build that does not start: $("$E" --version 2>&1 | head -n 2)"; fi
    else echo "the native program was never put in place (the stub is still there)"; fi
  else echo "the npm package is missing"; fi
  echo "free space: $(df -h "$R" 2>/dev/null | tail -n 1 | sed 's/  */ /g')"
  M=""; T=""
  # the build for this Linux that came with this version, if its file is still there
  d="$W/node_modules/@anthropic-ai/claude-code-linux-$A$LC"
  [ -f "$d/claude" ] && [ "$(node -p "require(process.argv[1]).version" "$d/package.json" 2>/dev/null)" = "$V" ] && M="$d/claude"
  if [ -z "$M" ] && [ -n "$V" ]; then
    # downloaded into a temporary folder, never installed as a package: a second copy of it in npm's global folder
    # makes Claude Code's own postinstall refuse every later update ("Two copies of the native package")
    T=$(mktemp -d)
    echo "== downloading the linux-$A$LC build of $V"
    (cd "$T" && npm pack "@anthropic-ai/claude-code-linux-$A$LC@$V" >/dev/null && tar xzf ./*.tgz package/claude) && M="$T/package/claude"
  fi
  if [ -n "$M" ] && [ -f "$M" ] && [ -d "$W/bin" ]; then
    echo "putting the linux-$A$LC build in place"
    cp "$M" "$E.tmp" && rm -f "$E" && mv "$E.tmp" "$E" && chmod 755 "$E" || { rm -f "$E.tmp"; echo "copying it failed (space?)"; }
  fi
  [ -n "$T" ] && rm -rf "$T"
  [ -e "$G" ] || ln -sf "$E" "$G"
  hash -r 2>/dev/null
fi
if ! claude --version >/dev/null 2>&1; then echo "@@FAIL claude still does not run: $(claude --version 2>&1 | head -n 1)"; exit 1; fi`;

export function installScript() {
  return [
    'set -u',
    'chmod 1777 /tmp /var/tmp 2>/dev/null', // see the start command: Claude Code wants /tmp sticky
    `echo "== Linux packages"`,
    'if command -v apk >/dev/null 2>&1; then',
    '  need=""',
    // Alpine (an install from before decision 190): libgcc/libstdc++ for the native musl build, ripgrep for its search
    '  for p in nodejs npm python3 libgcc libstdc++ ripgrep; do apk info -e "$p" >/dev/null 2>&1 || need="$need $p"; done',
    '  if [ -n "$need" ]; then echo "apk add$need"; apk add --no-cache $need || { echo "@@FAIL apk"; exit 1; }; else echo "already there: nodejs npm python3"; fi',
    'else',
    // Debian (decision 190): python3 for the bridge, ripgrep for Claude Code's search, git and curl it reaches for;
    // Debian's own Node is too old for Claude Code, so Node comes from nodejs.org (checked against its SHA256SUMS)
    '  export DEBIAN_FRONTEND=noninteractive',
    '  echo "apt-get install ca-certificates curl xz-utils python3 ripgrep git procps"',
    '  apt-get update -q >/dev/null || { echo "@@FAIL apt-get update (no connection?)"; exit 1; }',
    '  apt-get install -y -q --no-install-recommends ca-certificates curl xz-utils python3 ripgrep git procps || { echo "@@FAIL apt"; exit 1; }',
    '  nv=$(node --version 2>/dev/null || echo none); major=$(echo "$nv" | sed -n "s/^v\\([0-9]*\\).*/\\1/p")',
    `  if [ -z "$major" ] || [ "$major" -lt ${NODE_MIN} ]; then`,
    '    case "$(uname -m)" in aarch64|arm64) NA=arm64;; x86_64|amd64) NA=x64;; *) NA=;; esac',
    `    NB=${NODE_DIST}`,
    '    NF=$(curl -fsSL "$NB/SHASUMS256.txt" | grep -o "node-v[0-9.]*-linux-$NA\\.tar\\.xz" | head -n 1)',
    '    [ -n "$NA" ] && [ -n "$NF" ] || { echo "@@FAIL no Node download for $(uname -m)"; exit 1; }',
    '    echo "== Node from nodejs.org: $NF"',
    '    T=$(mktemp -d)',
    '    if (cd "$T" && curl -fsSLO "$NB/$NF" && curl -fsSL "$NB/SHASUMS256.txt" | grep " $NF\\$" | sha256sum -c - >/dev/null && tar -xJf "$NF" -C /usr/local --strip-components=1 --no-same-owner --exclude=CHANGELOG.md --exclude=README.md --exclude=LICENSE); then rm -rf "$T"; else rm -rf "$T"; echo "@@FAIL the Node download did not arrive or did not match its checksum"; exit 1; fi',
    '    hash -r 2>/dev/null',
    '  fi',
    'fi',
    'nv=$(node --version 2>/dev/null || echo none)',
    'echo "node $nv"',
    'major=$(echo "$nv" | sed -n "s/^v\\([0-9]*\\).*/\\1/p")',
    `if [ -z "$major" ] || [ "$major" -lt ${NODE_MIN} ]; then echo "@@NODE_OLD $nv"; exit 3; fi`,
    // an earlier repair (one build) installed the musl package on its own: Claude Code's postinstall then finds two
    // copies and refuses the install – that copy goes first
    'R0=$(npm root -g 2>/dev/null); for a in arm64 x64; do if [ -n "$R0" ] && [ -d "$R0/@anthropic-ai/claude-code-linux-$a-musl" ]; then echo "removing a stray copy of the musl package (left by an earlier repair)"; rm -rf "$R0/@anthropic-ai/claude-code-linux-$a-musl"; fi; done',
    `echo "== npm install -g ${CLI_PKG}"`,
    `npm install -g ${CLI_PKG} || { echo "@@FAIL npm ${CLI_PKG}"; exit 1; }`,
    `echo "== npm install -g ${ACP_PKG}"`,
    `npm install -g --omit=optional ${ACP_PKG} || { echo "@@FAIL npm ${ACP_PKG}"; exit 1; }`,
    // Claude Code updates itself in the background by default – under proot, an interrupted update (Android pausing
    // the app, low space) leaves no claude at all. Updates come from Chronicle's Install / Update button instead.
    '{ mkdir -p /etc/profile.d && echo "export DISABLE_AUTOUPDATER=1" > /etc/profile.d/claude-code-no-autoupdate.sh; } 2>/dev/null || true',
    ...CLAUDE_REPAIR.split('\n'),
    'echo "@@VERSIONS"',
    'echo "claude $(claude --version 2>/dev/null | head -n 1)"',
    `echo "${ACP_BIN} $(npm ls -g ${ACP_PKG} 2>/dev/null | sed -n 's/.*@\\([0-9][^ ]*\\).*/\\1/p' | head -n 1)"`,
    'echo "node $(node --version)"',
    'echo "@@DONE"',
  ].join('\n');
}

/** Write the install script and start it detached; its output goes to install.log, its exit code to install.exit. */
export function installCmd({ dir = DIR } = {}) {
  const body = installScript();
  if (body.includes('OCM_EOF_CC')) throw new Error('heredoc marker in the script');
  return [
    '# ocm-claude install',
    `D='${dir}'; mkdir -p "$D"`,
    // /tmp shared as on any Linux (1777): an unpack that lost the sticky bit makes Claude Code turn its messaging off
    'chmod 1777 /tmp /var/tmp 2>/dev/null',
    `cat > "$D/install.sh" <<'OCM_EOF_CC'`,
    body,
    'OCM_EOF_CC',
    'rm -f "$D/install.exit"; : > "$D/install.log"',
    `setsid nohup sh -c 'sh "$0/install.sh"; echo $? > "$0/install.exit"' "$D" > "$D/install.log" 2>&1 < /dev/null &`,
    'echo $! > "$D/install.pid"',
    'echo "@@STARTED"',
  ].join('\n');
}

/** The last part of the install log and whether it is still running. */
export function installPollCmd({ bytes = 8000, dir = DIR } = {}) {
  return [
    '# ocm-claude poll',
    `D='${dir}'`,
    'echo "@@LOG"',
    `tail -c ${Math.max(500, bytes | 0)} "$D/install.log" 2>/dev/null`,
    'echo',
    'echo "@@STATE"',
    'if [ -f "$D/install.exit" ]; then echo "exit $(cat "$D/install.exit")"; elif [ -f "$D/install.pid" ] && kill -0 "$(cat "$D/install.pid")" 2>/dev/null; then echo running; else echo none; fi',
  ].join('\n');
}

/**
 * What is installed and whether Claude Code is signed in – without reading its credentials: `claude auth status
 * --json` answers, and only loggedIn and the method's kind leave Linux (no e-mail, no organisation, no token).
 */
export function statusCmd({ dir = DIR } = {}) {
  return [
    '# ocm-claude status',
    `D='${dir}'`,
    'echo "@@NODE $(node --version 2>/dev/null)"',
    'command -v claude >/dev/null 2>&1 && echo "@@CLAUDE $(claude --version 2>/dev/null | head -n 1)"',
    `command -v ${ACP_BIN} >/dev/null 2>&1 && echo "@@ACP yes"`,
    'command -v python3 >/dev/null 2>&1 && echo "@@PY yes"',
    // a tiny filter in Node: the full JSON never leaves Linux
    'if command -v claude >/dev/null 2>&1; then claude auth status --json 2>/dev/null | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const k=(v)=>String(v||"").replace(/[^\\w.-]/g,"").slice(0,24);console.log("@@AUTH "+(j.loggedIn?"yes":"no")+" "+(k(j.authMethod)||"-")+" "+(k(j.apiKeySource)||"-"))}catch{console.log("@@AUTH unknown")}})\' 2>/dev/null; fi',
    'if [ -f "$D/install.pid" ] && [ ! -f "$D/install.exit" ] && kill -0 "$(cat "$D/install.pid")" 2>/dev/null; then echo "@@INSTALLING"; fi',
    'if [ -f "$D/bridge.pid" ] && P=$(cat "$D/bridge.pid") && [ -d "/proc/$P" ] && tr "\\0" " " < "/proc/$P/cmdline" 2>/dev/null | grep -q acp-bridge; then echo "@@RUNNING $P $(cat "$D/port" 2>/dev/null)"; fi',
    'echo "@@END"',
  ].join('\n');
}

/** Lines "@@KEY value" → the state the card shows. */
export function parseStatus(out) {
  const s = { node: '', nodeMajor: 0, claude: '', acp: false, python: false, auth: 'unknown', authMethod: '', installing: false, running: null };
  for (const line of String(out || '').split('\n')) {
    const m = /^@@([A-Z]+)\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2].trim();
    if (m[1] === 'NODE') {
      s.node = v;
      s.nodeMajor = Number(/^v(\d+)/.exec(v)?.[1] || 0);
    } else if (m[1] === 'CLAUDE') s.claude = v.replace(/\s*\(Claude Code\)\s*$/, '');
    else if (m[1] === 'ACP') s.acp = true;
    else if (m[1] === 'PY') s.python = true;
    else if (m[1] === 'AUTH') {
      const [yes, method, source] = v.split(/\s+/);
      s.auth = yes === 'yes' ? 'yes' : yes === 'no' ? 'no' : 'unknown';
      s.authMethod = method && method !== '-' ? method : source && source !== '-' ? source : '';
    } else if (m[1] === 'INSTALLING') s.installing = true;
    else if (m[1] === 'RUNNING') {
      const [pid, port] = v.split(/\s+/);
      s.running = { pid: Number(pid), port: Number(port) || 0 };
    }
  }
  s.installed = !!s.claude && s.acp;
  // the script ran to its end: only then does "not installed" mean it (an empty answer is Linux busy or timing out)
  s.answered = /(^|\n)@@END\s*(\n|$)/.test(String(out || ''));
  return s;
}

/** "Signed in (claude.ai account)" … for the status line. */
export function authLabel(st) {
  if (st.auth === 'yes') return /api|key/i.test(st.authMethod) ? 'signed in (API key)' : 'signed in';
  if (st.auth === 'no') return 'not signed in yet';
  return 'sign-in unknown';
}

/** The install poll's answer → { log, state: 'running' | 'done' | 'failed' | 'node-old' | 'none', exit, versions }. */
export function parseInstall(out) {
  const text = String(out || '');
  const i = text.lastIndexOf('@@STATE');
  const log = (i >= 0 ? text.slice(0, i) : text).replace(/^@@LOG\n?/, '').replace(/\n$/, '');
  const st = (i >= 0 ? text.slice(i + 7) : '').trim().split('\n')[0] || 'none';
  const exit = /^exit (-?\d+)/.exec(st)?.[1];
  const nodeOld = /@@NODE_OLD (\S*)/.exec(log)?.[1];
  const versions = {};
  const vi = log.lastIndexOf('@@VERSIONS');
  if (vi >= 0) for (const l of log.slice(vi).split('\n').slice(1)) if (/^(claude|claude-agent-acp|node) /.test(l)) versions[l.split(' ')[0]] = l.slice(l.indexOf(' ') + 1).trim();
  const state = st === 'running' ? 'running' : exit == null ? 'none' : exit === '0' && /@@DONE/.test(log) ? 'done' : nodeOld != null ? 'node-old' : 'failed';
  return { log, state, exit: exit == null ? null : Number(exit), versions, nodeOld: nodeOld ?? null };
}

/** Stop the bridge started before (by its pid file) and everything in its session: the adapter and Claude Code. */
export function stopCmd({ dir = DIR } = {}) {
  return [
    '# ocm-claude stop',
    `D='${dir}'`,
    'P=$(cat "$D/bridge.pid" 2>/dev/null)',
    'if [ -n "$P" ] && [ -d "/proc/$P" ] && tr "\\0" " " < "/proc/$P/cmdline" 2>/dev/null | grep -q acp-bridge; then',
    '  all=""',
    // every process in the bridge's session (setsid made it the leader): field 4 after the name is the session id
    '  for d in /proc/[0-9]*; do st=$(cat "$d/stat" 2>/dev/null) || continue; r=${st##*) }; set -- $r; [ "$4" = "$P" ] && all="$all ${d#/proc/}"; done',
    '  kill -TERM $all $P 2>/dev/null; sleep 1; kill -KILL $all $P 2>/dev/null',
    'fi',
    'rm -f "$D/bridge.pid" "$D/port"',
    'echo "@@STOPPED"',
  ].join('\n');
}

/**
 * Start the bridge: the script written fresh, any earlier run stopped, then acp-bridge on 127.0.0.1 with port 0 (a free
 * one, written to the port file) and the secret on its stdin, running claude-agent-acp in the chosen folder. Waits up
 * to ~20 s for the port and prints "@@PORT n", or "@@FAIL" with the end of the log.
 */
export function startCmd({ cwd = '/root', secret, script = bridgeBody, dir = DIR } = {}) {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(String(secret || ''))) throw new Error('a bridge secret is needed');
  if (String(script).includes('OCM_EOF_ACP')) throw new Error('heredoc marker in the bridge');
  return [
    '# ocm-claude start',
    stopCmd({ dir }).split('\n').slice(1, -1).join('\n'), // the earlier run, if any (no @@STOPPED line)
    `D='${dir}'; mkdir -p "$D"`,
    `cat > "$D/acp-bridge.py" <<'OCM_EOF_ACP'`,
    String(script).replace(/\n$/, ''),
    'OCM_EOF_ACP',
    decodeTo('W', cleanCwd(cwd)),
    'cd "$W" 2>/dev/null || { echo "@@FAIL cwd"; exit 0; }',
    `command -v ${ACP_BIN} >/dev/null 2>&1 || { echo "@@FAIL not-installed"; exit 0; }`,
    'CLI=$(command -v claude) || { echo "@@FAIL not-installed"; exit 0; }',
    'rm -f "$D/port"',
    // printf is the shell's own: the secret is in no process's command line; the bridge reads it from stdin
    `printf '%s\\n' '${secret}' | CLAUDE_CODE_EXECUTABLE="$CLI" USE_BUILTIN_RIPGREP=0 DISABLE_AUTOUPDATER=1 setsid nohup python3 "$D/acp-bridge.py" --host 127.0.0.1 --port 0 --port-file "$D/port" --secret-stdin -- ${ACP_BIN} > "$D/bridge.log" 2>&1 &`,
    'echo $! > "$D/bridge.pid"',
    'i=0; while [ $i -lt 100 ] && [ ! -s "$D/port" ] && kill -0 "$(cat "$D/bridge.pid")" 2>/dev/null; do sleep 0.2; i=$((i+1)); done',
    'if [ -s "$D/port" ]; then echo "@@PORT $(cat "$D/port")"; else echo "@@FAIL start"; tail -n 20 "$D/bridge.log" 2>/dev/null; fi',
  ].join('\n');
}

/**
 * What became of a bridge that stopped answering (decision 216): is its process still there, are Claude Code's, how
 * much memory Linux has left, and the last lines of its log. Prints @@BRIDGE alive|gone, @@AGENTS n, @@MEM mb, @@LOG.
 */
export function diagnoseCmd({ dir = DIR } = {}) {
  return [
    '# ocm-claude diagnose',
    `D='${dir}'`,
    'P=$(cat "$D/bridge.pid" 2>/dev/null)',
    'if [ -n "$P" ] && [ -d "/proc/$P" ]; then echo "@@BRIDGE alive"; else echo "@@BRIDGE gone"; fi',
    'n=0; for d in /proc/[0-9]*; do c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; case "$c" in *claude-agent-acp*|*/bin/claude*|*claude-code/cli*) n=$((n+1));; esac; done; echo "@@AGENTS $n"',
    'awk \'/^MemAvailable/{print "@@MEM " int($2/1024)}\' /proc/meminfo 2>/dev/null',
    'echo "@@LOG"; tail -n 12 "$D/bridge.log" 2>/dev/null | cut -c1-240',
  ].join('\n');
}

/** diagnoseCmd's output → { alive, why } for the error the user sees. */
export function parseDiagnose(out) {
  const t = String(out || '');
  const state = /@@BRIDGE (alive|gone)/.exec(t)?.[1];
  if (!state) return { alive: false, why: "Linux itself did not answer either – Android may have stopped the app's Linux (it does that when memory runs short); it starts again with your next message" };
  const agents = Number(/@@AGENTS (\d+)/.exec(t)?.[1] || 0);
  const mem = /@@MEM (\d+)/.exec(t)?.[1];
  // the log's last lines, without the bridge's own start banner (it holds nothing about why)
  const log = (t.split('@@LOG')[1] || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^(acp-bridge: agent running|In Chronicle|address |secret )/.test(l)).slice(-6).join(' | ').slice(0, 600);
  const memNote = mem != null ? ` Linux has ${mem} MB of memory free now.` : '';
  if (state === 'alive') return { alive: true, why: `the bridge is still running but did not answer – Linux was too busy (a heavy command?).${memNote}${log ? ` Its log: ${log}` : ''}` };
  return {
    alive: false,
    why: `the bridge process is gone${agents ? '' : ', and Claude Code with it'} – it was stopped from outside, not by an error Chronicle saw: Android ends an app's Linux processes when the phone runs short of memory or too many are running (a big build, git or test run can do it).${memNote}${log ? ` The last lines of its log: ${log}` : ' Its log says nothing about it (a process killed this way leaves no message).'}`,
  };
}

/** → { port } | { error, log } */
export function parseStart(out) {
  const t = String(out || '');
  const port = Number(/@@PORT (\d+)/.exec(t)?.[1] || 0);
  if (port > 0 && port < 65536) return { port };
  const why = /@@FAIL (\S+)/.exec(t)?.[1] || 'no answer';
  return { error: why, log: t.split('@@FAIL')[1]?.split('\n').slice(1).join('\n').trim().slice(-1500) || '' };
}

export const bridgeUrl = (port) => `http://127.0.0.1:${Number(port)}`;

/** Only the loopback address this module itself starts: what the ACP connection of the phone agent may use. */
export const isOwnBridgeUrl = (url) => /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(String(url || ''));

// ---------- state: one bridge per app ----------
const live = { secret: '', port: 0, cwd: '', mcpToken: '' }; // the secret never leaves this object (and the bridge's stdin)
export const bridgeSecret = () => live.secret;
/** The token of the bridge's own MCP endpoint (/mcp/<chat>): handed to Claude Code in session/new, nowhere else. */
export const bridgeMcpToken = () => live.mcpToken;

/**
 * Where the chats' workspaces are in Claude Code's Linux (decision 166): the app's folder that holds every chat's
 * /workspace (shell/work/<chat>) bound at /chats, so a Claude Code chat works in /chats/<chat> – the same files the
 * chat's own shell sees as /workspace and its 📁 shows. The bind is the Claude Code shell's for good: every command
 * in that shell passes the same spec (a different one would start a new proot and lose the bridge).
 */
export const CHATS = '/chats';
let mountSpec = null; // Promise<string>: '' when the app has no host folder for it (the web build)
let mountResolver = null;
/** How the host folder is found (claudecode-ui sets it; tests pass their own). */
export const setChatsMount = (fn) => ((mountResolver = fn), (mountSpec = null));
export function chatsMount() {
  if (!mountSpec) mountSpec = Promise.resolve(mountResolver ? mountResolver() : '').then((host) => (host && String(host).startsWith('/') && !/[;:]/.test(host) ? `${host}:${CHATS}` : ''), () => '');
  return mountSpec;
}
/** The folder a chat's Claude Code session works in, or '' when the workspaces are not bound. */
export async function chatCwd(chatDir) {
  return (await chatsMount()) && /^[\w.-]{1,64}$/.test(String(chatDir || '')) ? `${CHATS}/${chatDir}` : '';
}
export const bridgeState = () => ({ running: !!live.secret && live.port > 0, port: live.port, cwd: live.cwd });

/** Is the bridge we started answering (with our secret)? */
export async function bridgeHealthy({ http = httpRequest } = {}) {
  if (!live.secret || !live.port) return false;
  try {
    const r = await http(bridgeUrl(live.port) + '/health', { method: 'GET', headers: { Authorization: `Bearer ${live.secret}` }, timeoutMs: 4000 });
    if (r.status !== 200 || !/"running":\s*true/.test(r.body || '')) return false;
    const t = /"mcpToken":\s*"([A-Za-z0-9_-]{16,})"/.exec(r.body || '')?.[1];
    if (t) live.mcpToken = t;
    return true;
  } catch {
    return false;
  }
}

const sh = async (exec, cmd, timeoutMs) => {
  const mounts = await chatsMount();
  return exec(cmd, { id: SHELL_ID, timeoutMs, ...(mounts ? { mounts } : {}) });
};
/** A command in the Claude Code shell (with its bind): for the skills sync. */
export const ccExec = (cmd, { exec = runShell, timeoutMs = 120000 } = {}) => sh(exec, cmd, timeoutMs);
/** Ask Linux what became of the bridge (diagnoseCmd). → { alive, why } */
export async function diagnoseBridge({ exec = runShell, dir = DIR } = {}) {
  try {
    return parseDiagnose((await sh(exec, diagnoseCmd({ dir }), 15000))?.output);
  } catch {
    return parseDiagnose('');
  }
}

export async function readStatus({ exec = runShell } = {}) {
  const r = await sh(exec, statusCmd(), 30000);
  return parseStatus(r?.output);
}
export async function startInstall({ exec = runShell } = {}) {
  const r = await sh(exec, installCmd(), 30000);
  if (!/@@STARTED/.test(String(r?.output || ''))) throw new Error('The install did not start: ' + String(r?.output || '').slice(-300));
}
export async function pollInstall({ exec = runShell } = {}) {
  const r = await sh(exec, installPollCmd(), 20000);
  return parseInstall(r?.output);
}

/** Start (or restart) the bridge in `cwd`. → { port, url } — throws with the end of the bridge log when it fails. */
export async function startBridge({ cwd = '/root', exec = runShell, http = httpRequest, wait = 60000, dir = DIR } = {}) {
  const secret = newSecret();
  live.secret = '';
  live.port = 0;
  live.mcpToken = '';
  const r = await sh(exec, startCmd({ cwd, secret, dir }), 60000);
  const s = parseStart(r?.output);
  if (s.error) {
    const why = s.error === 'cwd' ? `the folder ${cleanCwd(cwd)} does not exist in Linux` : s.error === 'not-installed' ? 'Claude Code is not installed in Linux yet' : 'the bridge did not start';
    throw new Error(why + (s.log ? ':\n' + s.log : ''));
  }
  Object.assign(live, { secret, port: s.port, cwd: cleanCwd(cwd) });
  const until = Date.now() + wait;
  while (!(await bridgeHealthy({ http }))) {
    if (Date.now() > until) {
      live.secret = '';
      throw new Error(`the bridge did not answer on 127.0.0.1:${s.port} within ${Math.round(wait / 1000)} s (Linux may still be busy – try Restart)`);
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return { port: s.port, url: bridgeUrl(s.port) };
}

export async function stopBridge({ exec = runShell, dir = DIR } = {}) {
  live.secret = '';
  live.port = 0;
  live.mcpToken = '';
  await sh(exec, stopCmd({ dir }), 20000);
}

/** The settings entry of the phone agent: address and folder, never a secret (acp-ui.js asks bridgeSecret()). */
export const agentEntry = (port, cwd) => ({ id: AGENT_ID, name: AGENT_NAME, url: bridgeUrl(port), phone: true, cwd: cleanCwd(cwd) });

/**
 * An ACP error that means Claude Code is not signed in: the adapter's authRequired (-32000), which it sends only when
 * Claude Code itself said "run /login". Not any text that mentions authentication (an MCP server's own sign-in, a
 * git error), and never a Claude Code process that died (a crash is not a sign-out – decision 184).
 */
const DIED = /process (died|terminated|exited|crashed)|terminated by signal|\bSIG(BUS|SEGV|KILL|ABRT|TERM)\b/i;
export const isAuthError = (e) => {
  const m = String(e?.message || '');
  return !DIED.test(m) && (e?.code === -32000 || /\brun \/login\b/i.test(m));
};
export const SIGN_IN_HINT = 'Claude Code is not signed in. Open the 🐧 terminal, type `claude` and follow its own sign-in there (Chronicle never sees it), then send again.';
/**
 * What a chat shows for a Claude Code error: Claude Code's own words always (decision 184 – the sign-in hint used to
 * replace them, so a crash read as a sign-out), with the sign-in hint in front only for a sign-in error.
 */
export function ccErrorText(e) {
  const own = String(e?.message || e || '').trim();
  const why = e?.data?.startupFailureReason || e?.data?.reason || '';
  const said = [own, why && !own.includes(why) ? `(${why})` : ''].filter(Boolean).join(' ').slice(0, 800);
  if (!isAuthError(e)) return `Claude Code in Linux: ${said || 'it failed without saying why'}`;
  return !said || /^auth(entication)? required\.?$/i.test(said) ? SIGN_IN_HINT : `${SIGN_IN_HINT}\n\nClaude Code said: ${said}`;
}
