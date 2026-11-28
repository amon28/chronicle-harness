// A small Linux (Debian since decision 190; Alpine before) inside the app: proot runs a root filesystem downloaded once
// into the app's private storage.
// The assistant gets a 'shell' tool (one persistent shell per chat); you get a terminal sheet (Settings -> Linux terminal).
//
// Three things make it more than a terminal here:
//   - /workspace in the shell IS this chat's workspace, and /phone IS the linked phone folder (bridge.js),
//   - a command that outlives 30 s comes back with a job handle instead of dying on a timeout (jobs.js),
//   - the helper scripts in /usr/local/bin are installed and hash-checked from src/toolkit/ (toolkit.js).
import { scrubToken, syncShellGithub, resetShellGithub, githubHint, syncShellSsh, resetShellSsh } from './github.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { httpRequest } from './api.js';
import { reapCmd, startMark } from './procs.js';
import { configureJobs, startJob, settle, jobSnapshot, getJob, listJobs, killJob, jobOnShell, isRunning } from './jobs.js';
import { ensureToolkit, toolkitSummary } from './toolkit.js';
import { mountSpec, prepareShell, collectShell } from './bridge.js';
import { syncSkillScripts } from './skills.js';
import { NONINTERACTIVE_ENV, killedHint, promptHint } from './shellhints.js';

const native = Capacitor.isNativePlatform() ? registerPlugin('Shell') : null;
/** Tests can install globalThis.__ocmShell = { status(), install({url,sha256}), exec({id,cmd,timeoutMs,mounts}), kill({id}), uninstall(), addListener() } */
const impl = () => globalThis.__ocmShell || native;
export const canUseShell = () => !!impl();

/** How long a command may take before the tool hands back a job handle instead of blocking. */
export const SHELL_SOFT_MS = 30000;
let softLimit = SHELL_SOFT_MS;
/** Tests shorten the soft deadline (here or through globalThis.__ocmShellSoftMs); nothing else should. */
export const setShellSoftLimit = (ms) => {
  softLimit = Math.max(0, Number(ms) || 0);
};
const softDeadline = () => (Number(globalThis.__ocmShellSoftMs) > 0 ? Number(globalThis.__ocmShellSoftMs) : softLimit);

export async function shellStatus() {
  try {
    const st = await impl().status();
    if (st?.installed) setDistro(st.distro);
    return st;
  } catch {
    return { available: false, installed: false };
  }
}

// which Linux is installed (decision 190): Debian for new installs; an Alpine one from before keeps working until the
// user switches (Settings › Linux terminal) – what the assistant is told to install packages with follows it
let distro = 'debian';
export const setDistro = (d) => (distro = String(d || '').toLowerCase() === 'alpine' ? 'alpine' : 'debian');
export const linuxDistro = () => distro;
const pkgHint = () => (distro === 'alpine' ? 'Alpine: apk add <pkg>' : 'Debian 13: apt-get install -y <pkg>');

// Debian 13 (trixie), the slim image Debian publishes on Docker Hub (built by Debian's own image tooling): ~30 MB
// gzip, one layer, its SHA-256 is its address. The registry wants a sign-in token even for public images (free,
// anonymous, a few minutes long); the layer itself comes from a download server the registry redirects to.
const REG = 'https://registry-1.docker.io/v2/library/debian';
const TAG = 'trixie-slim';
const INDEX_TYPES = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json';
const MANIFEST_TYPES = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
const json = (r, what) => {
  if (r.status === 429) throw new Error("Docker Hub's download limit for this network is reached – try again in an hour or two, or on another network");
  if (r.status !== 200) throw new Error(`Could not read ${what} from Docker Hub (${r.status})`);
  try {
    return JSON.parse(r.body || '');
  } catch {
    throw new Error(`Docker Hub sent something that is not ${what}`);
  }
};
/**
 * → { url, sha256, size, auth? } of Debian's arm64 root filesystem (decision 190): first from GitHub, where Debian's
 * image builder (debuerreotype) publishes the very image Docker Hub serves – no sign-in token, and no per-network
 * download limit (a phone shares its carrier's address with many others) –, then from Docker Hub.
 */
export async function debianImage({ arch = 'arm64' } = {}) {
  try {
    return await githubDebian(arch);
  } catch (e) {
    try {
      return await dockerHubDebian(arch);
    } catch (e2) {
      throw new Error(`Could not find Debian's image – GitHub: ${e?.message || e}; Docker Hub: ${e2?.message || e2}`);
    }
  }
}
const GH = 'https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts';
const GH_ARCH = { arm64: 'arm64v8', amd64: 'amd64' };
async function githubDebian(arch) {
  const base = `${GH}/dist-${GH_ARCH[arch] || arch}/${TAG.replace('-', '/')}/oci`;
  const r = await httpRequest(`${base}/index.json`, { timeoutMs: 20000 });
  if (r.status !== 200) throw new Error(`the image list answered ${r.status}`);
  const index = JSON.parse(r.body || '{}');
  const m = (index.manifests || []).find((x) => x.platform?.architecture === arch) || (index.manifests || [])[0];
  if (!m?.data) throw new Error('the image list has no image in it');
  const man = JSON.parse(atob(m.data));
  const layers = man.layers || [];
  if (layers.length !== 1 || !/tar\+gzip/.test(layers[0].mediaType || '')) throw new Error('the image is not one gzip layer');
  const digest = String(layers[0].digest || '');
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('the image has no SHA-256');
  // the layer is kept under oci/blobs/rootfs.tar.gz (its sha256 name is a link to it); the download is checked against the digest
  return { url: `${base}/blobs/rootfs.tar.gz`, sha256: digest.slice(7), size: Number(layers[0].size) || 0 };
}
async function dockerHubDebian(arch) {
  const tok = json(await httpRequest('https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/debian:pull', { timeoutMs: 20000 }), 'a sign-in token');
  const auth = `Bearer ${tok.token || tok.access_token}`;
  const index = json(await httpRequest(`${REG}/manifests/${TAG}`, { headers: { Authorization: auth, Accept: INDEX_TYPES }, timeoutMs: 20000 }), 'the image list');
  const m = (index.manifests || []).find((x) => x.platform?.os === 'linux' && x.platform?.architecture === arch);
  if (!m) throw new Error(`Docker Hub has no ${arch} Debian image`);
  const man = json(await httpRequest(`${REG}/manifests/${m.digest}`, { headers: { Authorization: auth, Accept: MANIFEST_TYPES }, timeoutMs: 20000 }), 'the image');
  const layers = man.layers || [];
  if (layers.length !== 1 || !/tar(\.|\+)gzip|tar\.gz|diff\.tar\.gzip/.test(layers[0].mediaType || '')) throw new Error('The Debian image is not one gzip layer any more – Chronicle needs an update to install it');
  const digest = String(layers[0].digest || '');
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('The Debian image has no SHA-256');
  return { url: `${REG}/blobs/${digest}`, sha256: digest.slice(7), size: Number(layers[0].size) || 0, auth };
}

/**
 * After the image is unpacked: the package lists and what agents reach for first (certificates for https, curl,
 * ps). Needs a connection; without one Linux still works and apt-get update can be run later.
 */
export const DEBIAN_FIRST = 'chmod 1777 /tmp /var/tmp 2>/dev/null; export DEBIAN_FRONTEND=noninteractive; apt-get update -q && apt-get install -y -q --no-install-recommends ca-certificates curl procps xz-utils less && echo "@@SETUP_OK"';

export async function installLinux(onProgress) {
  const api = impl();
  onProgress?.({ phase: 'find', pct: 0 });
  const img = await debianImage();
  const sub = await api.addListener?.('install', (e) => onProgress?.(e));
  try {
    await api.install(img);
    toolkitCache = null; // a fresh root filesystem: the toolkit has to go in again
    resetShellGithub(); // …and so does the GitHub sign-in
    resetShellSsh();
    skillsInstalled = '';
    setDistro('debian');
  } finally {
    sub?.remove?.();
  }
  // the first packages: the shell works without them, so a failure here is said, not thrown
  onProgress?.({ phase: 'setup', pct: 0 });
  const r = await runShell(DEBIAN_FIRST, { id: 'setup', timeoutMs: 600000 }).catch((e) => ({ output: String(e?.message || e) }));
  await impl().kill?.({ id: 'setup' })?.catch?.(() => {});
  return { setup: /@@SETUP_OK/.test(r?.output || '') ? 'ok' : clipOutput(String(r?.output || ''), 600) };
}

export const uninstallLinux = () => {
  toolkitCache = null;
  resetShellGithub(); // a new root filesystem has no sign-in yet
  resetShellSsh();
  return impl().uninstall();
};
/**
 * Stop a chat shell and what runs in it. proot is dropped last: killed on its own it leaves its processes running,
 * detached (bug D). `since` (ms, Date.now()): only what started after it is stopped, besides the shell itself, so a
 * server left running earlier survives a timed-out command. -> number of processes stopped (null: not known)
 */
export async function killShell(id, { since = null } = {}) {
  const s = impl();
  if (!s) return null;
  let reaped = null;
  if (id !== REAPER) {
    try {
      const r = await Promise.race([
        s.exec({ id: REAPER, cmd: reapCmd(id, since == null ? null : (Date.now() - since) / 1000), timeoutMs: 15000 }),
        new Promise((res) => setTimeout(() => res(null), 16000)),
      ]);
      const m = /@@REAPED (\d+)/.exec(String(r?.output || ''));
      if (m) reaped = +m[1];      // what the command started with nohup or setsid, kept running: said in the timeout's reply
      kept.set(id, [...String(r?.output || '').matchAll(/^@@KEPT (\d+) ?(.*)$/gm)].map((k) => ({ pid: +k[1], cmd: k[2].trim() })));
    } catch {
      /* no Linux, or the reaper shell is busy: proot is still dropped below */
    }
  }
  // proot kills everything under it when it ends (--kill-on-exit): when only a command was to be stopped and the
  // reaper did it, proot is let go instead, so a server started earlier lives on in it. Otherwise it is ended.
  await s.kill({ id, ...(since != null && reaped != null ? { spare: true } : {}) });
  return reaped;
}
const REAPER = 'reaper';
const kept = new Map(); // shell id -> [{pid, cmd}] the last reap left running on purpose
/** What the last timeout of this shell left running on purpose (nohup / setsid), once. */
export const takeKept = (id) => {
  const k = kept.get(id) || [];
  kept.delete(id);
  return k;
};

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
/**
 * Output as a terminal would show it: no colour codes, and a line that redraws itself with \r (git clone's
 * "Receiving objects: 37%", npm and apk progress) shows only its latest state – not every update glued together.
 */
export const plain = (t) =>
  String(t || '')
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.includes('\r') ? l.split('\r').filter(Boolean).pop() || '' : l))
    .join('\n');

/** Output that fits a model's context: the start and the end, with a note about what was left out. */
export function clipOutput(text, max = 12000) {
  let t = scrubToken(plain(text)).replace(/\n+$/, ''); // a command that prints the GitHub token shows a placeholder
  const hint = githubHint(t); // a refused clone/push: what the user can do (never: make an SSH key)
  if (hint) t += '\n[' + hint + ']';
  if (t.length <= max) return t;
  const head = Math.floor(max / 3);
  return t.slice(0, head) + '\n… [' + (t.length - max) + ' characters left out] …\n' + t.slice(-(max - head));
}

/**
 * One command at a time per shell, in the app (decision 186). Android refuses a second command while one runs ("The
 * previous command in this shell is still running"), and a refused or abandoned command must never run later: the next
 * one waits its turn here instead, and one whose caller gave up while it waited (signal) is not run at all.
 * run(waitedMs) → its result.
 */
const lanes = new Map(); // shell id -> the last command handed to it (the next one waits for it)
export const NOT_RUN = 'Not run: it was stopped while it waited for the shell (another command was running there), and it will not run later';
function inLane(id, run, signal = null) {
  const t0 = Date.now();
  const turn = lanes.get(id) || Promise.resolve();
  let gaveUp = false;
  const p = new Promise((resolve, reject) => {
    // given up on while it waits: answered at once, and when its turn comes it is skipped
    const onAbort = () => {
      gaveUp = true;
      reject(Object.assign(new Error(NOT_RUN), { notRun: true }));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    turn.then(() => {
      signal?.removeEventListener('abort', onAbort);
      if (gaveUp) return;
      Promise.resolve()
        .then(() => run(Date.now() - t0))
        .then(resolve, reject);
    });
  });
  // the shell is free for the next one when this one is over – or, given up on, when its turn came
  const tail = turn.then(() => p.catch(() => {}));
  lanes.set(id, tail);
  tail.then(() => lanes.get(id) === tail && lanes.delete(id));
  return p;
}
/** A command is running in this shell (or waiting for it) right now. */
export const shellBusy = (id) => lanes.has(id);

/** Run one command in a shell (kept per id, so cd and variables stay). -> { output, exit, timedOut?, ended?, waitedMs } */
export async function runShell(cmd, { id = 'main', timeoutMs = 60000, mounts = '', signal = null, onStart = null } = {}) {
  return await inLane(
    id,
    async (waitedMs) => {
      onStart?.();
      return { ...(await impl().exec({ id, cmd, timeoutMs, ...(mounts ? { mounts } : {}) })), waitedMs };
    },
    signal,
  );
}
/** A helper job's own shell is not needed any more: let it end once what runs in it (a nohup / setsid server) ends. */
export function releaseShell(id) {
  if (!usedShells.has(id)) return;
  usedShells.delete(id);
  return inLane(id, () => impl()?.kill?.({ id, spare: true })).catch(() => {});
}
/** Subscribe to live output of any shell: fn({ id, data }). -> remove() */
export async function onShellOutput(fn) {
  const h = await impl()?.addListener?.('out', fn);
  return () => h?.remove?.();
}

// the start mark and the non-interactive defaults share the first line, so the command itself stays as it was written
const markLine = (id, cmd) => startMark(id) + (String(cmd).trimStart().startsWith(NONINTERACTIVE_ENV) ? '' : '; ' + NONINTERACTIVE_ENV) + '\n' + cmd;

configureJobs({
  // the command's start is marked first, so a timeout stops exactly what it started (not a server started just before)
  exec: (cmd, o) => inLane(o.id, () => impl().exec({ id: o.id, cmd: markLine(o.id, cmd), timeoutMs: o.timeoutMs, ...(o.mounts ? { mounts: o.mounts } : {}) }), o.signal),
  kill: (id, o) => killShell(id, o),
  kept: (id) => takeKept(id),
  onOutput: (fn) => onShellOutput(fn),
});

const toolExec = (shellId, mounts, signal = null) => (cmd, timeoutMs = 120000) => runShell(cmd, { id: shellId, timeoutMs, mounts, signal });

let toolkitCache = null; // verified once per install: the root filesystem is shared by every shell
let skillsInstalled = ''; // the skill scripts toolkit-pull last put in PATH (same root filesystem)
let toolkitPending = null; // the check / install going on right now
/**
 * The toolkit, verified (installed if needed) once for every shell: they share one root filesystem. Two shells that
 * start at the same moment (two helper jobs) wait for the same check – the second used to hash a script the first was
 * still writing and read an empty file (decision 187).
 */
function toolkitFor(exec) {
  if (toolkitCache?.ok) return Promise.resolve(toolkitCache);
  if (!toolkitPending)
    toolkitPending = (async () => {
      try {
        toolkitCache = await ensureToolkit(exec, { force: !toolkitCache });
      } catch (e) {
        toolkitCache = { ok: false, files: {}, error: String(e?.message || e) };
      }
      return toolkitCache;
    })().finally(() => (toolkitPending = null));
  return toolkitPending;
}

const bytesOf = (s) => new TextEncoder().encode(String(s || '')).byteLength;

/** Make sure the helper scripts are in this shell (doctor uses it before running its own script). */
export async function ensureShellToolkit(shellId = 'main', mounts = '') {
  return toolkitFor(toolExec(shellId, mounts));
}

/** Notes for the result header, without the one that only repeats part of another. */
const uniqNotes = (list) => {
  const uniq = [...new Set(list.filter(Boolean))];
  // "1 file into /workspace" followed by "1 file into /workspace; the two copies ... disagreed"
  // is one fact printed twice: keep the longer line that carries it
  return uniq.filter((n) => !uniq.some((o) => o !== n && o.includes(n)));
};

/**
 * After a git clone: where the repo is, whether the app sees it, and how to keep the next big one small.
 * (A clone outside /workspace is in the shell only – list_files saying "empty" does not mean it failed.)
 */
/** A repo cloned outside /workspace is remembered on the chat's workspace, so list_files can say where it is later. */
export function rememberPlace(w, cmd = '', out = '') {
  if (!w || !/\bgit\b[^\n;&|]*\bclone\b/.test(String(cmd))) return;
  let into = /Cloning into (?:bare repository )?'([^']+)'/.exec(String(out || ''))?.[1] || '';
  if (!into) return;
  if (!into.startsWith('/')) {
    const cd = [...String(cmd).matchAll(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|\S+)/g)].pop()?.[1]?.replace(/^['"]|['"]$/g, '');
    into = (cd && cd.startsWith('/') ? cd.replace(/\/+$/, '') : '/root') + '/' + into;
  }
  if (/^\/workspace(\/|$)/.test(into)) return;
  w.shellPlaces = [...(w.shellPlaces || []).filter((x) => x !== into), into].slice(-10);
}

export function cloneNote(cmd = '', out = '') {
  if (!/\bgit\b[^\n;&|]*\bclone\b/.test(String(cmd))) return '';
  const into = /Cloning into (?:bare repository )?'([^']+)'/.exec(String(out))?.[1] || '';
  const shallow = /--depth[= ]|--filter[= ]|--single-branch/.test(cmd);
  const inWs = /^\/workspace(\/|$)/.test(into) || (!into.startsWith('/') && /(^|[;&|]\s*)cd\s+\/workspace/.test(cmd));
  const where = into ? `Cloned into ${into}${inWs ? ' (inside /workspace: its files are mirrored into the app; .git and node_modules stay in the shell)' : ' – unless that is under /workspace, it is in the shell only: list_files and read_file do not see it. Work on it with the shell, and copy just the files the user should get into /workspace'}.` : '';
  return '[' + [where, shallow ? '' : 'A big repo next time: git clone --depth=1 --filter=blob:none (history and old blobs left out) is much faster and smaller.', 'Check the size with du -sh <dir> before copying anything out of it.'].filter(Boolean).join(' ') + ']';
}

// a timed-out command's `nohup …` / `setsid …` is left running, as timeout(1) would: say which, so nobody has to guess
const keptText = (k) => (k?.length ? ` – except what it started with nohup or setsid, which is still running: ${k.slice(0, 5).map((x) => `pid ${x.pid}${x.cmd ? ' (' + x.cmd.slice(0, 80) + ')' : ''}`).join(', ')}${k.length > 5 ? ` and ${k.length - 5} more` : ''} (stop it with kill <pid>)` : '');

export function finishedResult(r, { notes = [], prep = null, post = null, job = null } = {}) {
  const out = clipOutput(r.output, 400000); // a long output is spilled to .out/ by runTool, not lost
  const endedWith = r.ended && r.exit != null && r.exit >= 0;
  const head = r.killed
    ? 'KILLED mid-way: the job that ran it was cancelled, so the command was stopped' + (r.exit != null ? ' (exit code ' + r.exit + ')' : '') + '; what it had written until then is kept in the files'
    : r.timedOut
    ? 'TIMED OUT after ' + (r.limitS ? r.limitS + ' s' : 'the time limit') + ' – killed: the command and what it started were stopped' + (r.reaped ? ' (' + r.reaped + ' processes)' : '') + ', so it writes nothing more' + keptText(r.kept) + '; the next command starts a fresh shell (cd and variables are reset). What it had written until then is kept. For work that needs longer than 10 minutes (a build, a big install, training), start it with the job script – job run \'<command>\' – which has no time limit, and follow it with job out <id>; after an interrupted apt-get run dpkg --configure -a first'
    : r.ended
      ? (endedWith ? 'exit code ' + r.exit + ' – ' : '') + 'the command ended the shell itself (exit or exec): the next command starts a fresh shell, so cd and variables are reset'
      : 'exit code ' + r.exit;
  const ok = !r.killed && !r.timedOut && r.exit === 0 && (!r.ended || endedWith);
  // a sync log that repeats a line is a sync log nobody reads
  const extra = uniqNotes([prep?.note, post?.note, job ? 'job ' + job.id : '', ...notes, r.timedOut ? promptHint(out) : null, !r.timedOut && !r.killed ? killedHint(out, r.exit) : null]).join('\n');
  return {
    ok,
    result: [head, out || (ok ? '(the command printed nothing – it succeeded)' : '(no output)'), cloneNote(r.cmd, out), extra].filter(Boolean).join('\n'),
    display: { path: String(r.cmd || 'shell').slice(0, 80), output: out.slice(0, 6000), ...(ok ? {} : { error: head }), ...(job ? { job: job.id } : {}) },
    meta: { surface: 'linux-shell', bytes: bytesOf(out), exit: r.exit, job: job?.id || '' },
  };
}

export const shellDefs = () => [
  {
    type: 'function',
    function: {
      name: 'shell',
      description:
        `Run a command in a small Linux (${distro === 'alpine' ? 'Alpine, busybox sh' : 'Debian 13: commands run in sh (dash) – use bash -c for bash syntax; the usual GNU tools'}) that lives inside this app. Use it for things Python alone is awkward for: installing and running tools (${distro === 'alpine' ? 'apk add nodejs python3 git curl ffmpeg' : 'apt-get install -y nodejs npm python3 git ffmpeg'}), running scripts, git, curl, grep/sed/awk, building small projects. ` +
        '/workspace is this chat workspace, mounted in (the same files as list_files and run_python: write a file there and it appears in both, delete it and it is gone from both), and /phone is the folder the user linked from their phone. No copying by hand – except a file over 32 MB (a video, an archive), which is not in /phone until phone_import puts it there (the command\'s notes list them); never look for phone files under /storage, /sdcard or /proc: the app cannot read them that way. ' +
        'The shell is persistent per chat (cd and environment variables carry over), and the helper scripts job, doctor and toolkit-pull are installed in PATH. ' +
        'A command that runs longer than 30 s comes back as a job with an id: keep working, then follow it with shell_job (action poll, wait or kill) - do not sleep in a loop. ' +
        'Internet access works. It is NOT the user phone: it cannot see their files beyond the linked folder. Set timeout_s for slow commands (default: no give-up until 10 minutes; max 600). ' +
        'Small files cross between /workspace and the app by themselves (up to 32 MB each, 128 MB per command, about 4-6 MB/s); for big media, deliver on the phone and tell the user, do not try to carry gigabytes through the chat. ' +
        'node_modules and .git directories stay in the shell only (list_files/read_file do not see them), and /workspace is compared up to 20,000 files: clone big repositories and install packages under /root, and put only the results in /workspace – but a project you will edit with edit_file / apply_patch (with diffs and undo) belongs in /workspace/<name>: those tools cannot reach /root, and its .git and node_modules stay in the shell anyway. ' +
        'A command that could destroy what cannot be brought back (rm -rf outside /workspace or of it, anything deleted or overwritten on /phone or /sdcard, git reset --hard, git push --force, git clean -f, dd, mkfs) waits for the user to allow it, even in Auto, and is refused where nobody can be asked.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command(s) to run' },
          timeout_s: { type: 'integer', description: 'Time limit in seconds (max 600): at the limit the command and what it started are killed and the shell restarts. Commands over 30 s return a job handle first. To keep something running on purpose, start it with the job script (job run \'cmd\') and follow it with job out <id> / job wait <id> inside the shell – shell_job only knows the jobs the shell tool handed back. A plain & leaves it running with no handle at all.' },
          restart: { type: 'boolean', description: 'Start a fresh shell first (clears cd/variables, kills anything running)' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
];

export const shellJobDefs = () => [
  {
    type: 'function',
    function: {
      name: 'shell_job',
      description:
        'Follow up a command that the shell tool returned as a job (job_… ids). One started inside the shell with the job script (job run) is followed there: job out <id>, job wait <id>, job kill <id>. poll reads what the command has printed so far and whether it is still running; wait blocks until it ends (or wait_s passes); kill stops it; list shows the jobs of this chat. The exit code and any files it wrote are there when it finishes.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['poll', 'wait', 'kill', 'list'], description: 'Default poll' },
          job_id: { type: 'string', description: 'The job id the shell tool gave you' },
          lines: { type: 'integer', description: 'For poll/wait: how many last lines (default 80; 0 = everything)' },
          wait_s: { type: 'integer', description: 'For wait: how long to wait before answering (default 30, max 60)' },
        },
        additionalProperties: false,
      },
    },
  },
];

let storage = false; // all files access allowed: the phone's storage is at /sdcard
export const setShellStorage = (on) => (storage = !!on);
export const shellPrompt = () =>
  '- shell runs commands in a small Linux inside the app (' + pkgHint() + ' to install nodejs, python3, git, ffmpeg, ...). /workspace there is this chat workspace and /phone is the linked phone folder - read and write them directly instead of copying through the app. A phone file over 32 MB (a video) is not in /phone until phone_import brings it there (it then says /phone/<path>); do not hunt for it under /storage. Keep /workspace small (big clones and installs under /root): it is mirrored file by file into the app, and node_modules/.git stay in the shell only. The file tools (read_file, edit_file…) see /workspace only – a project you edit with them goes in /workspace/<name>.' +
  (storage ? ' The phone\'s whole storage (Download, DCIM, Documents…) is at /sdcard: the user allowed it – change or delete files there only when asked.' : '') +
  // what this Linux is and is not (decision 276): every field review found a model losing turns to one of these
  (distro === 'alpine'
    ? ''
    : " It is Debian on ARM64 under proot (not a VM, no root kernel access): x86_64 binaries (many SDK and toolchain zips) do not run – prefer Debian's own packages; npm is a separate package from nodejs (apt-get install -y nodejs npm); pip refuses system installs – use apt-get install -y python3-<name> or python3 -m venv /root/venv. No USB, serial or Bluetooth devices, and no raw sockets: ping, arp, ip route and nmap -sS do not work – use curl, nmap -sT -Pn. Anything that may take more than 10 minutes (a build, a toolchain install, a dev server you keep running) starts with job run '<command>' (no time limit; job out <id> to follow) – a plain command is killed at its timeout. The user's local network is reachable from here (the app's local-network grant does not limit the shell), so treat devices there with care.") +
  ' Run doctor once on a fresh machine (it prints tools, network and writable folders) before installing anything. A command over 30 s comes back with a job id: poll it with shell_job (or job out <id> inside the shell) instead of sleeping, and check the exit code and the output before claiming success. Do not paste secrets into commands.';

/** One exec's worth of setup: toolkit verified, /workspace and /phone in sync. Returns notes for the result. */
async function prepare({ shellId, mount, ctx, refresh = false }) {
  const exec = toolExec(shellId, mount.mounts, ctx.signal); // given up on while it waits for the shell: not run
  const tk = await toolkitFor(exec);
  const notes = [];
  if (tk.repaired && tk.ok) notes.push('toolkit installed: ' + toolkitSummary(tk));
  else if (!tk.ok) notes.push('toolkit NOT verified (' + (tk.error || 'unknown') + ') - toolkit-pull cannot repair that until it is fixed');
  // the skills' own tools: in the workspace before the sync, so they cross with everything else
  let sk = null;
  if (ctx.workspace && ctx.settings?.agentSkills?.length) {
    try {
      sk = await syncSkillScripts(ctx.workspace, ctx.settings.agentSkills);
    } catch (e) {
      notes.push('skill scripts were not placed: ' + String(e?.message || e));
    }
  }
  // GitHub: the shell gets the sign-in (or loses it) once after it changes – the root filesystem is shared
  const gh = await syncShellGithub(exec).catch(() => '');
  if (gh) notes.push(gh);
  // the user's SSH key: in only while it is switched on, out as soon as it is off or its time is up
  const sshNote = await syncShellSsh(exec).catch(() => '');
  if (sshNote) notes.push(sshNote);
  const prep = ctx.workspace ? await prepareShell({ w: ctx.workspace, ctx, convId: ctx.convId || 'main', mount, refreshPhone: refresh }) : { mode: mount.mode, note: '' };
  // ...and into PATH: once per install, again when a script changes or the toolkit had to be put back
  if (sk?.scripts.length && mount.workHost && tk.ok && (tk.repaired || skillsInstalled !== sk.signature)) {
    const r = await exec('toolkit-pull 2>&1; echo "TOOLKIT_PULL_EXIT=$?"').catch((e) => ({ output: String(e?.message || e) }));
    const out = String(r.output || '');
    const lines = out.split(/\r?\n/);
    const failed = lines.filter((l) => /^pull .*(FAILED|SKIPPED)/.test(l));
    const names = sk.scripts.map((s) => s.name + ' (' + s.skill + ')').join(', ');
    if (/TOOLKIT_PULL_EXIT=0/.test(out)) {
      skillsInstalled = sk.signature;
      notes.push('skill scripts in PATH: ' + names);
    } else notes.push('skill scripts NOT all installed: ' + (failed.slice(0, 3).join('; ') || lines.filter(Boolean).slice(-2).join(' / ').slice(0, 160)));
  }
  return { exec, prep, notes };
}

/** The chat shells used since the app started: only they can have left something running (jobs-ui.js looks). */
export const usedShells = new Set();

const shq = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
export async function runShellTool(args, ctx) {
  if (!canUseShell()) return { ok: false, result: 'The Linux shell is only available in the Android app.', display: { error: 'unavailable' } };
  const st = await shellStatus();
  if (!st.available) return { ok: false, result: 'This phone cannot run the built-in Linux (it needs a 64-bit ARM phone and the app build that includes it).', display: { error: 'unavailable' } };
  if (!st.installed) return { ok: false, result: 'Linux is not installed yet. Ask the user to open Settings → Linux terminal and tap Install (Debian, about 30 MB), then try again.', display: { error: 'not installed' } };
  const asked = String(args.command || '').trim();
  if (!asked) throw new Error('command is required');
  // a helper's command starts in the chat's /workspace like its Python does (decision 182): the chat's shell keeps the
  // folder an earlier command cd'd into (once /usr/local/bin), and a relative path would land there
  const cmd = ctx.shellCwd ? `cd ${shq(ctx.shellCwd)} 2>/dev/null; ${asked}` : asked;
  // a helper job has a shell of its own (decision 186): two jobs at once neither wait for nor kill each other's command
  const id = 'chat:' + (ctx.convId || 'main') + (ctx.shellKey ? ':' + String(ctx.shellKey).replace(/[^\w-]/g, '') : '');
  usedShells.add(id);
  if (args.restart) {
    await killShell(id);
    toolkitCache = null;
    resetShellGithub();
    skillsInstalled = '';
  }
  ctx.onStatus?.('$ ' + asked.split('\n')[0].slice(0, 80));

  const convId = ctx.convId || 'main';
  const mount = await mountSpec(ctx, convId);
  // a job in this chat's shell is still running: work in a second shell rather than refuse the turn
  const busy = jobOnShell(id);
  const shellId = busy ? id + ':aux' : id;
  usedShells.add(shellId);
  const notes = busy ? ['your main shell is busy with ' + busy.id + ', so this ran in a fresh shell (cd and variables from earlier are not here)'] : [];
  const { prep, notes: setupNotes } = await prepare({ shellId, mount, ctx, refresh: !!args.restart });
  notes.push(...setupNotes);

  const hardMs = args.timeout_s != null ? Math.min(600, Math.max(1, Number(args.timeout_s) || 60)) * 1000 : 600000;
  const soft = softDeadline();
  const softMs = Math.min(soft, Math.max(0, hardMs - 1000));
  const useJobs = hardMs > soft + 5000;
  // a cancelled ask_model job (decision 183): its command is killed, not left to finish and write files later
  const stopped = ctx.killOnAbort && ctx.signal ? new Promise((res) => (ctx.signal.aborted ? res('stop') : ctx.signal.addEventListener('abort', () => res('stop'), { once: true }))) : null;

  let began = useJobs ? Date.now() : 0; // when the command really started (after any wait for the shell)
  if (!useJobs) {
    const ran = runShell(markLine(shellId, cmd), { id: shellId, timeoutMs: hardMs, mounts: mount.mounts, signal: ctx.signal, onStart: () => (began = Date.now()) }); // its start marked, as for jobs
    let r;
    try {
      r = stopped ? await Promise.race([ran, stopped]) : await ran;
    } catch (e) {
      if (!e?.notRun) throw e;
      return { ok: false, result: NOT_RUN + '.', display: { path: cmd.slice(0, 80), error: 'not run' } };
    }
    if (r === 'stop' && !began) r = { output: '', notRun: true }; // still waiting for the shell: it will not run (its lane checks the signal)
    if (r?.notRun) return { ok: false, result: NOT_RUN + '.', display: { path: cmd.slice(0, 80), error: 'not run' } };
    if (r.waitedMs > 1500) notes.push('waited ' + Math.round(r.waitedMs / 1000) + ' s for the shell: another command was running in it');
    if (r === 'stop') {
      await killShell(shellId, { since: began }).catch(() => {});
      r = { ...((await Promise.race([ran.catch(() => null), new Promise((res) => setTimeout(res, 3000))])) || { output: '' }), killed: true };
    }
    // an explicit short timeout: the command and what it started are stopped, and the shell is restarted
    if (r.timedOut) r = { ...r, reaped: await killShell(shellId, { since: began }).catch(() => null), kept: takeKept(shellId), limitS: Math.round(hardMs / 1000) };
    const post = ctx.workspace ? await collectShell({ w: ctx.workspace, ctx, convId, mode: prep.mode, mounted: !!mount.workHost }) : { note: '' };
    rememberPlace(ctx.workspace, cmd, r.output);
    return finishedResult(r, { notes, prep, post: forJob(post, ctx) });
  }

  const job = startJob({
    cmd,
    shellId,
    signal: ctx.signal,
    timeoutMs: hardMs,
    mounts: mount.mounts,
    note: prep.note,
    onProgress: (out) => {
      // only the end matters for the status line: a 2 MB output is not split into lines on every chunk
      const last = plain(out.slice(-600)).trimEnd().split('\n').pop();
      if (last) ctx.onStatus?.('… ' + last.slice(-70));
    },
    onFinish: async () => {
      if (ctx.workspace) job.collected = await collectShell({ w: ctx.workspace, ctx, convId, mode: prep.mode, mounted: !!mount.workHost });
    },
  });
  if ((await Promise.race([settle(job, softMs), ...(stopped ? [stopped] : [])])) === 'stop' && isRunning(job)) {
    await killJob(job);
    // the exec came back after the kill: its files were brought in; it never came back: bring them in here
    if (!job.collected && ctx.workspace) job.collected = await collectShell({ w: ctx.workspace, ctx, convId, mode: prep.mode, mounted: !!mount.workHost }).catch(() => ({ note: '' }));
    rememberPlace(ctx.workspace, cmd, job.output);
    return finishedResult({ output: job.output, exit: job.exit, killed: true, cmd }, { notes, prep, post: forJob(job.collected, ctx), job });
  }
  if (isRunning(job)) {
    // the chat is told when it finishes (decision 199): no need to poll it in a loop of waits
    const tells = !ctx.shellKey && typeof ctx.onJobDone === 'function';
    if (tells) ctx.onJobDone(job);
    const snap = jobSnapshot(job, { lines: 60 });
    const out = clipOutput(snap.output, 6000);
    const extra = [prep.note, ...notes].filter(Boolean).join('\n');
    return {
      ok: true,
      result:
        '[still running after ' + Math.round(softMs / 1000) + ' s - job ' + job.id + ']\n' +
        'The command keeps running. Poll it with shell_job {"action":"poll","job_id":"' + job.id + '"} (or "wait", or "kill"). Do not sleep and re-run it.\n' +
        (tells ? 'Chronicle sends you a message when it ends (exit code and last lines) – if there is nothing else to do meanwhile, end your reply now instead of waiting.\n' : '') +
        (extra ? '\n' + extra + '\n' : '') +
        (promptHint(out) ? '\n' + promptHint(out) + '\n' : '') +
        '\n--- output so far ---\n' + (out || '(nothing yet)'),
      display: { path: cmd.slice(0, 80), job: job.id, running: true, output: out.slice(0, 4000) },
      meta: { surface: 'linux-shell', job: job.id, bytes: snap.bytes },
    };
  }
  rememberPlace(ctx.workspace, cmd, job.output);
  return finishedResult({ output: job.output, exit: job.exit, timedOut: job.timedOut, ended: job.ended, reaped: job.reaped, kept: job.kept, limitS: job.timedOut ? Math.round(hardMs / 1000) : 0, cmd }, { notes, prep, post: forJob(job.collected, ctx), job });
}

/** A helper job's command: the sync's count covers the whole chat folder (other jobs too) – said, so it is not read as this command's. */
const forJob = (post, ctx) => (post && ctx.shellKey && /\d+ files? back from \/workspace/.test(post.note || '') ? { ...post, note: post.note.replace(/(\d+ files? back from \/workspace)/, "$1 (every change in the chat's folder since the last copy, also other jobs' – your job's own files are in its status)") } : post);

function jobResult(job, snap) {
  if (job && !snap.running) job.seenDone = true; // its end was seen: the chat is not told again
  const out = clipOutput(snap.output || '', 12000); // no colour codes or \r progress spam, start and end kept
  const head = snap.id + ' ' + snap.status.toUpperCase() + (snap.exit != null ? ' exit=' + snap.exit : '') + ' after ' + snap.elapsed + ' s';
  const tail = [job?.collected?.note, snap.note, snap.error, snap.running ? promptHint(snap.output || '') : null].filter(Boolean).join('\n');
  const meta = { surface: 'linux-shell', job: snap.id, exit: snap.exit, bytes: bytesOf(out) };
  if (!out && snap.running) return { ok: true, result: head + '\n(no output yet)' + (tail ? '\n' + tail : ''), display: { job: snap.id, running: true }, meta };
  // an empty output is not a failure: say so, with the exit code, so it does not read as one
  const none = snap.status === 'done' && snap.exit === 0 ? '(the command printed nothing – exit 0: it succeeded)' : snap.status === 'done' ? `(the command printed nothing – exit ${snap.exit}: it failed)` : '(no output)';
  return {
    // a poll of a running job is a successful poll; a kill is a successful kill. Only a real failure is ok=0.
    ok: snap.running || snap.status === 'killed' || (snap.status === 'done' && snap.exit === 0),
    result: head + '\n' + (out || none) + (tail ? '\n\n' + tail : ''),
    display: { job: snap.id, running: snap.running, output: out.slice(0, 4000) },
    meta,
  };
}

export async function runShellJobTool(args, ctx = {}) {
  // jobs belong to the chat that started them
  const mine = (j) => !ctx.convId || !(j.shellId || j.shell) || String(j.shellId || j.shell).startsWith('chat:' + ctx.convId);
  const action = String(args.action || 'poll');
  if (action === 'list') {
    const jobs = listJobs().filter(mine);
    const text = jobs.length ? jobs.map((j) => j.id + '  ' + j.status.toUpperCase() + (j.exit != null ? ' exit=' + j.exit : '') + '  ' + j.elapsed + 's  ' + j.cmd.split('\n')[0].slice(0, 60)).join('\n') : 'No jobs in this chat.';
    return { ok: true, result: text, display: { jobs: jobs.map((j) => j.id) }, meta: { surface: 'linux-shell', bytes: bytesOf(text) } };
  }
  const found = getJob(args.job_id);
  const job = found && mine(found) ? found : null;
  if (!job) {
    // an id from the job script (job run) is not one of these – say where it is followed instead of only "no job" (decision 269)
    const id = String(args.job_id || '?');
    const script = id !== '?' && !/^job_/.test(id) ? ' If ' + id + ' came from the job script (job run) inside the shell, follow it there: shell {"command":"job out ' + id.replace(/[^\w.-]/g, '') + '"} (or job wait / job kill).' : '';
    return { ok: false, result: 'No job ' + id + ' among the shell tool\'s jobs.' + script + ' shell_job {"action":"list"} shows the jobs of this chat.', display: { error: 'unknown job' }, meta: { surface: 'linux-shell' } };
  }
  if (action === 'kill') {
    const snap = await killJob(job);
    return jobResult(job, { ...snap, status: 'killed', running: false });
  }
  const waitMs = action === 'wait' ? Math.min(60, Math.max(1, Number(args.wait_s) || 30)) * 1000 : 0;
  if (waitMs) await settle(job, waitMs);
  const lines = args.lines === 0 ? 0 : Math.max(1, Math.min(400, Number(args.lines) || 80));
  return jobResult(job, jobSnapshot(job, { lines }));
}

// ---------- full-screen programs on a real terminal (vim, htop, less…) ----------
export const canPty = () => !!impl()?.ptyStart;
/** The full terminal's shell: bash where there is one (Debian, decision 190) – history and Tab completion – else sh. */
export const LOGIN_SHELL = 'sh -c "command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l"';
export const ptyStart = (o) => impl().ptyStart(o);
export const ptyWrite = (id, data) => impl().ptyWrite({ id, data });
export const ptyResize = (id, cols, rows) => impl().ptyResize?.({ id, cols, rows });
export const ptyKill = (id) => impl().ptyKill({ id });
/** fn({ id, b64 }) for output, onExit({ id, code }). → remove() */
export async function onPty(fn, onExit) {
  const a = await impl()?.addListener?.('ptyData', fn);
  const b = await impl()?.addListener?.('ptyExit', onExit);
  return () => (a?.remove?.(), b?.remove?.());
}
