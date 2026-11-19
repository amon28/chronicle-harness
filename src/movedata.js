// Moving everything to another app or phone (decision 218). "Export everything" is the backup with the keys, plus
// what an ordinary backup leaves out: each chat's git history and search index (IndexedDB), and the app's own
// lists kept on this phone (usage history, learned model abilities). The Linux home folder (/root) goes as a second
// file, a .tar.gz packed inside Linux – without Claude Code's sign-in, which never leaves Linux (decision 167).

/** Values with bytes, Maps and Sets as JSON (git objects are bytes). */
export function encodeValue(v) {
  return JSON.stringify(v, function (k, x) {
    const raw = this[k];
    if (raw instanceof Uint8Array) return { __b64: bytesToB64(raw) };
    if (raw instanceof ArrayBuffer) return { __b64: bytesToB64(new Uint8Array(raw)), __ab: 1 };
    if (raw instanceof Map) return { __map: [...raw.entries()] };
    if (raw instanceof Set) return { __set: [...raw.values()] };
    return x;
  });
}
export function decodeValue(text) {
  return JSON.parse(text, (k, x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      if (typeof x.__b64 === 'string') {
        const u = b64ToBytes(x.__b64);
        return x.__ab ? u.buffer : u;
      }
      if (Array.isArray(x.__map)) return new Map(x.__map);
      if (Array.isArray(x.__set)) return new Set(x.__set);
    }
    return x;
  });
}
function bytesToB64(u) {
  let s = '';
  for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
  return btoa(s);
}
function b64ToBytes(b) {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

/** The app's own lists kept on this phone (localStorage): what is worth moving – not caches, logs or flags. */
const LOCAL_SKIP = /^ocm\.(settings|settingsInIdb|cache\.|errlog|mcpTools|modeljobs|wsSummary)/;
export function localEntries(ls = globalThis.localStorage) {
  const out = {};
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith('ocm.') && !LOCAL_SKIP.test(k)) out[k] = ls.getItem(k);
    }
  } catch {
    /* no storage */
  }
  return out;
}
export function putLocalEntries(entries, ls = globalThis.localStorage) {
  let n = 0;
  for (const [k, v] of Object.entries(entries || {})) {
    if (!k.startsWith('ocm.') || LOCAL_SKIP.test(k) || typeof v !== 'string') continue;
    try {
      ls.setItem(k, v);
      n++;
    } catch {
      /* full */
    }
  }
  return n;
}

// ---------- the Linux home folder ----------
export const MOVE_DIR = '/var/tmp/chronicle-move';
export const HOME_TAR = `${MOVE_DIR}/linux-home.tar.gz`;
/**
 * Never in the file: Claude Code's sign-in and account (only Claude Code may use them – sign in again there), the
 * app's own sign-in folder (the app writes it again from its keys), and caches that come back by themselves.
 */
export const HOME_EXCLUDES = ['./.claude/.credentials.json', './.claude.json', './.claude.json.backup*', './.claude/backups', './.config/chronicle', './.cache', './.npm/_cacache'];
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** Pack /root into HOME_TAR in the background (it can take longer than one command may run). */
export function packHomeCmd({ home = '/root', dir = MOVE_DIR } = {}) {
  const ex = HOME_EXCLUDES.map((e) => `--exclude=${q(e)}`).join(' ');
  return [
    `D=${q(dir)}; H=${q(home)}; mkdir -p "$D"; rm -f "$D/home.exit" "$D/linux-home.tar.gz"`,
    // GNU tar exits 1 when a file changed while it was read (a log being written): the file is still good
    `setsid nohup sh -c 'cd "$1" && tar -czpf "$0/linux-home.tar.gz" ${ex.replace(/'/g, "'\\''")} . ; echo $? > "$0/home.exit"' "$D" "$H" > "$D/home.log" 2>&1 < /dev/null &`,
    'echo "@@STARTED"',
  ].join('\n');
}
/** Unpack a home archive into /root in the background. */
export function unpackHomeCmd(file = HOME_TAR, { home = '/root', dir = MOVE_DIR } = {}) {
  return [
    `D=${q(dir)}; mkdir -p "$D"; rm -f "$D/home.exit"`,
    `setsid nohup sh -c 'cd "$2" && tar -xzpf "$1" --no-same-owner ; r=$?; rm -f "$1"; echo $r > "$0/home.exit"' "$D" ${q(file)} ${q(home)} > "$D/home.log" 2>&1 < /dev/null &`,
    'echo "@@STARTED"',
  ].join('\n');
}
/** How the background tar is doing: @@RUN <bytes so far> or @@EXIT <code> <bytes> and the end of its log. */
export function homeStatusCmd({ dir = MOVE_DIR } = {}) {
  return [
    `D=${q(dir)}`,
    'S=$(wc -c < "$D/linux-home.tar.gz" 2>/dev/null || echo 0)',
    'if [ -f "$D/home.exit" ]; then echo "@@EXIT $(cat "$D/home.exit") $S"; tail -n 5 "$D/home.log" 2>/dev/null; else echo "@@RUN $S"; fi',
  ].join('\n');
}
/** → { done, ok, bytes, log } */
export function parseHomeStatus(out) {
  const t = String(out || '');
  const ex = /@@EXIT (\d+) (\d+)/.exec(t);
  if (ex) return { done: true, ok: Number(ex[1]) <= 1, bytes: Number(ex[2]), log: t.split('\n').slice(1).join('\n').trim().slice(-600) };
  return { done: false, ok: false, bytes: Number(/@@RUN (\d+)/.exec(t)?.[1] || 0), log: '' };
}
export const cleanHomeCmd = () => `rm -rf ${q(MOVE_DIR)}`;
