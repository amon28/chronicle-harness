// Files on the user's PC (decision 223): folders a small script on the computer shares (scripts/pc-files.py), reached
// over the network with a secret. The assistant can look around, search, read, copy files into /workspace and – when
// the PC allows saving and this chat's mode does – save files back. Nothing is ever deleted on the PC.
import { httpRequest } from './api.js';
import { wsPut, looksText, bytesToText, cleanPath } from './sandbox.js';
import { sha256Hex, shortHash } from './hash.js';
import { commands, RULES } from './shellguard.js';
import { applyEdits } from './codeedit.js';
import { lineDiff, collapseDiff } from './diff.js';

const MAX_IMPORT_FILES = 300;
const MAX_IMPORT_BYTES = 80 * 1024 * 1024;
const MAX_WRITE_BYTES = 24 * 1024 * 1024;
const MAX_EDIT_BYTES = 8 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
// folders a build or an install makes again: pc_search and pc_import leave them out unless asked (decision 274)
export const PC_SKIP = ['node_modules', '.git', 'dist', 'build', '.next', 'target', 'venv', '.venv', '__pycache__'];
const UPDATE = (pc) => `pc-files.py on ${pc.name} is older than version 5 – update it (copy the new scripts/pc-files.py there and start it again)`;
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
export async function pcCall(pc, path, body, { timeoutMs = 30000, running = false, job = '' } = {}) {
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
    // the job id is the phone's own, so it is known even when the answer never came (decision 269)
    if (running && /timed out/i.test(String(e?.message || e))) throw new Error(`${pc.name} took longer than ${Math.round(timeoutMs / 1000)} s to answer about the command. It may still be running there${job ? ` as job ${job}: pc_job (job "${job}", action read) shows it, action list shows every job` : ': pc_job action list shows the jobs there'} – do not run it again to find out.`);
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
  return { folders: (j.folders || []).map((f) => String(f.name)), write: !!j.write, full: !!j.full, os: String(j.os || ''), host: String(j.host || ''), version: Number(j.version) || 0, ...(j.dotfiles != null ? { dotfiles: !!j.dotfiles } : {}) };
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
          // stdin is closed and Windows runs cmd: sudo hung on its password prompt and PowerShell lines failed in cmd (decision 274)
          `Run a command on the user's computer (full control${many ? `: ${fullOnes.map((p) => p.name).join(', ')}` : ''}), as the user, in their shell (${[...new Set(fullOnes.map((p) => (/windows/i.test(p.os || '') ? 'Windows cmd' : 'sh')))].join(' / ')}). Returns the exit code and output. In review mode the user is asked before each command; in read-only mode it is refused; a kill, delete, shutdown or service/container stop asks in Auto too. Nothing can be typed into it (stdin is closed): sudo works only as sudo -n, for a command the user allowed without a password (NOPASSWD). ${fullOnes.some((p) => /windows/i.test(p.os || '')) ? 'Windows runs cmd: for PowerShell use powershell -NoProfile -Command "…". ' : ''}Prefer pc_read / pc_search for looking and pc_edit / pc_write for changing files; never run something destructive the user did not ask for.`,
          { ...which, command: { type: 'string' }, cwd: { type: 'string', description: 'Folder to run in (absolute; default the home folder)' }, timeout_s: { type: 'integer', description: 'How long it may run in all, default 600 (10 min), at most 21600. A command still running after about 20 s goes on as a job: you get its job id and the output so far; follow it with pc_job' }, confirm: { type: 'boolean', description: 'Only after a kill or delete was stopped because it would hit more than one process or file, and you mean all of them' } },
          ['command'],
        ),
        fn(
          'pc_job',
          "A pc_shell command that is still running on the user's computer: wait for it (up to 25 s a call), read its output so far, or kill it. action list shows every job kept there (running, and ended in the last hour) – for when the id is lost.",
          { ...which, job: { type: 'string', description: 'The job id pc_shell gave (not needed with list)' }, action: { type: 'string', enum: ['wait', 'read', 'kill', 'list'] }, wait_s: { type: 'integer', description: 'With wait: up to 25' }, lines: { type: 'integer', description: 'How many last lines of its output (and of its errors) to show, default 80; 0 = everything kept' } },
          [],
        ),
      ]
    : [];
  return [
    fn('pc_list', "List the folders the user shares from their computer, or what is inside one. Paths start with the shared folder's name, e.g. \"game/src\"; no path = the shared folders.", { ...which, path: { type: 'string' }, recursive: { type: 'boolean', description: 'Everything below' }, depth: { type: 'integer', description: 'How many levels down (2 = this folder and one below); implies recursive' }, max: { type: 'integer', description: 'At most this many entries, default 2000, up to 20000' } }),
    fn('pc_search', `Find files on the user's computer by name (a pattern like *.py or report*) and/or by text inside them (case-insensitive). Searches everything shared, or below path; ${PC_SKIP.join(', ')} are left out unless all is true (or path is inside one). The result says what was not searched.`, { ...which, path: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, regex: { type: 'boolean', description: 'text is a regular expression (Python syntax)' }, count_only: { type: 'boolean', description: 'Only how many matching lines each file has' }, all: { type: 'boolean', description: `Also search ${PC_SKIP.slice(0, 3).join(', ')}… folders` }, max: { type: 'integer', description: 'Default 100' } }),
    fn('pc_read', "Read a text file on the user's computer, with line numbers (use pc_import for images, PDFs and other files). For a long file read it in parts with start_line; for the end of a big log use tail_lines; deep inside a huge file, offset (bytes).", { ...which, path: { type: 'string' }, start_line: { type: 'integer', description: 'First line to show (1-based), default 1' }, tail_lines: { type: 'integer', description: 'Show the last this many lines instead (a log)' }, offset: { type: 'integer', description: 'Start at this byte instead (from the next whole line) – for a part deep inside a file of many MB' }, max_lines: { type: 'integer', description: 'Default 400' }, max_chars: { type: 'integer', description: 'Default 12000' } }, ['path']),
    fn('pc_import', `Copy a file or folder from the user's computer into /workspace, so read_file, view_images, run_python and the shell can use it. Returns the workspace paths. From a folder, ${PC_SKIP.slice(0, 5).join(', ')}… are left out (made again by a build or an install) unless all is true.`, { ...which, path: { type: 'string' }, to: { type: 'string', description: 'Workspace folder to copy into (default: the same path as on the PC)' }, all: { type: 'boolean', description: 'Also copy node_modules, .git, dist, build… folders' } }, ['path']),
    fn('pc_write', "Save a file to the user's computer: content (text) or from_workspace (a file in /workspace). Only works when the computer allows saving; in review mode the user is asked first, in read-only mode it is refused. It never deletes anything: a replaced file keeps its permissions and its previous version stays as <file>.bak (one, replaced the next time). To change part of a text file use pc_edit.", { ...which, path: { type: 'string' }, content: { type: 'string' }, from_workspace: { type: 'string' }, append: { type: 'boolean', description: 'Add to the end of the file instead of replacing it' }, backup: { type: 'boolean', description: 'Keep the replaced version as <file>.bak (default true)' } }, ['path']),
    fn(
      'pc_edit',
      "Change part of a text file on the user's computer by exact text replacement, like edit_file: old_text must match the file exactly (indentation included) and be unique unless replace_all; several edits apply in order, all or none. Needs saving allowed, like pc_write (asked first in review mode, with the diff); the replaced version stays as <file>.bak. Read the part first with pc_read.",
      {
        ...which,
        path: { type: 'string' },
        edits: {
          type: 'array',
          description: 'Applied in order, each to the result of the one before',
          items: { type: 'object', properties: { old_text: { type: 'string', description: 'Exact text now in the file' }, new_text: { type: 'string', description: 'What it becomes ("" deletes it)' }, replace_all: { type: 'boolean', description: 'Change every occurrence (default: old_text must be unique)' } }, required: ['old_text', 'new_text'] },
        },
        old_text: { type: 'string', description: 'For a single edit instead of edits' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean' },
        expect_sha256: { type: 'string', description: 'The [sha256 …] pc_read (or the last pc_edit) showed: refused if the file changed since' },
        backup: { type: 'boolean', description: 'Keep the version before as <file>.bak (default true)' },
      },
      ['path'],
    ),
    ...shell,
  ];
}

export function pcPrompt(list, mode = 'ask') {
  const pcs = Array.isArray(list) ? list : [];
  if (!pcs.length) return '';
  const desc = pcs.map((p) => `"${p.name}"${p.full ? ` (FULL CONTROL${p.os ? `, ${p.os}` : ''}: any file by absolute path, and pc_shell runs commands)` : p.folders?.length ? ` (shares ${p.folders.join(', ')}${p.write ? '; saving allowed' : '; read-only'})` : ''}`).join(', ');
  const how = mode === 'readonly' ? 'This chat is read-only: pc_write and pc_edit are refused.' : mode === 'auto' ? 'pc_write and pc_edit save at once.' : 'pc_write and pc_edit ask the user before each save.';
  // a full-control PC was told "only the folders shown are reachable" right after "any file by absolute path", and
  // nothing said that hidden files (.github, .gitignore, .env) are refused without --dotfiles (decision 274)
  const shared = pcs.filter((p) => !p.full);
  const reach = shared.length
    ? ` On ${shared.length === pcs.length ? (pcs.length > 1 ? 'these computers' : 'this computer') : shared.map((p) => `"${p.name}"`).join(', ')} only the shared folders are reachable – if the user wants another one, they must share it on the computer – and hidden files and folders (.github, .gitignore, .env…) are refused there unless pc-files.py was started with --dotfiles${shared.some((p) => p.dotfiles) ? ` (${shared.filter((p) => p.dotfiles).map((p) => `"${p.name}"`).join(', ')} shares them)` : ''}.${shared.length < pcs.length ? ' A full-control computer reaches any file by absolute path, hidden ones included.' : ''}`
    : ' Full control reaches any file by absolute path (C:/Users/… or /home/…), hidden ones included.';
  return `- Files on the user's computer: ${desc}. Use pc_list (no path = what is shared), pc_search, pc_read for text and pc_import to bring files into /workspace before working on them; pc_edit changes part of a text file, pc_write saves whole files back. Paths start with the shared folder's name. ${how}${reach}`;
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
// a kill or delete as the COMMAND – at the start, after ; & | ( or sudo / xargs – not a word in an argument: git log
// --format=…, Format-Table, "echo kill" and grep shutdown were stopped to be asked about (decision 270)
const CMD_AT = String.raw`(?:^|[;&|(\n]|\bsudo\s+|\bxargs\s+(?:-\S+\s+)*)\s*`;
const KILL_OR_DELETE_RE = new RegExp(`${CMD_AT}(?:taskkill|stop-process|spps|pkill|killall|kill|shutdown|restart-computer|stop-computer|format|rm|del|erase|rd|rmdir|remove-item|ri)(?![\\w.-])`, 'i');

// ---------- what asks before it runs on the PC, in Auto too (decision 274) ----------
// The regex above saw a kill or delete only as the first word or right after sudo: sudo reboot, systemctl stop,
// docker rm -f, dd of=, mkfs, zfs destroy, sudo -u www rm, bash -c "rm …", ssh nas "rm …", find -delete, crontab -r,
// truncate, time rm and powershell -Command "Remove-Item …" all ran unasked. Now the line is split the way a shell
// splits it (shellguard.js: ; && | $( ), sudo/env/time/nohup, sh -c, ssh host "…"), each command is looked at by its
// name and words, and what powershell -Command, cmd /c and wsl run is looked at the same way.
const ALWAYS = {
  rm: 'deletes files', rmdir: 'deletes folders', unlink: 'deletes a file', shred: 'destroys files for good', del: 'deletes files', erase: 'deletes files', rd: 'deletes folders', 'remove-item': 'deletes files', ri: 'deletes files', 'clear-content': 'empties files', truncate: 'cuts files short',
  kill: 'ends processes', pkill: 'ends processes', killall: 'ends processes', taskkill: 'ends processes', 'stop-process': 'ends processes', spps: 'ends processes',
  shutdown: 'shuts the computer down', reboot: 'restarts the computer', poweroff: 'switches the computer off', halt: 'stops the computer', 'restart-computer': 'restarts the computer', 'stop-computer': 'switches the computer off',
  format: 'formats a disk', wipefs: 'wipes a disk', mke2fs: 'formats a disk', mkswap: 'formats a disk', diskpart: 'changes disks and partitions', 'format-volume': 'formats a disk', 'clear-disk': 'wipes a disk', 'remove-partition': 'deletes a partition', 'initialize-disk': 'wipes a disk',
  lvremove: 'deletes a volume', vgremove: 'deletes a volume group', pvremove: 'wipes a disk', 'stop-service': 'stops a service', 'remove-service': 'removes a service', 'clear-recyclebin': 'empties the recycle bin',
};
const word0 = (args) => args.find((a) => !a.v.startsWith('-'))?.v.toLowerCase() || '';
const flagsOf = (args) => args.filter((a) => /^-[A-Za-z]+$/.test(a.v)).map((a) => a.v.slice(1)).join('');
const GIT_RULE = RULES.find((r) => r.id === 'git');
const CHMOD_RULE = RULES.find((r) => r.id === 'chmod-000');
/** Why one simple command (shellguard's form) needs the user's OK on the PC, or ''. */
function pcCommandRisk(c) {
  const name = String(c.name || '').toLowerCase().replace(/\.exe$/, '');
  const args = c.args || [];
  const lower = args.map((a) => a.v.toLowerCase());
  const sub = word0(args);
  const at = c.remote ? ` on ${c.remote}` : '';
  if (ALWAYS[name]) return `${name} ${ALWAYS[name]}${at}`;
  if (/^mkfs(\.|$)/.test(name)) return `${name} formats a disk${at}`;
  if (name === 'dd' && lower.some((a) => a.startsWith('of='))) return `dd of= writes over a file or a disk${at}`;
  if (/^(fdisk|sfdisk|gdisk|sgdisk|cfdisk|parted)$/.test(name) && !lower.some((a) => /^(-l|--list|-p|--print|print|-d|--dump)$/.test(a))) return `${name} changes partitions${at}`;
  if (name === 'find' && (lower.includes('-delete') || args.some((a, k) => /^-(exec|execdir|ok)$/.test(a.v) && /^(rm|shred|unlink)$/.test((args[k + 1]?.v || '').split('/').pop())))) return `find -delete removes files${at}`;
  if (name === 'crontab' && /r/.test(flagsOf(args))) return `crontab -r deletes every scheduled job${at}`;
  if (name === 'systemctl' && /^(stop|kill|disable|mask|reboot|poweroff|halt|isolate|rescue|emergency|suspend|hibernate|kexec|soft-reboot)$/.test(sub)) return `systemctl ${sub} stops a service or the computer${at}`;
  if (name === 'service' && /^(stop|kill)$/.test(args[1]?.v || '')) return `service ${args[0]?.v} stop stops a service${at}`;
  if ((name === 'init' || name === 'telinit') && /^[06]$/.test(args[0]?.v || '')) return `${name} ${args[0].v} stops the computer${at}`;
  if (/^(docker|podman|nerdctl)$/.test(name)) {
    if (/^(rm|rmi|kill|stop)$/.test(sub)) return `${name} ${sub} ends or removes containers or images${at}`;
    if (lower.includes('prune') || (/^(container|image|volume|network|system|builder|compose|pod)$/.test(sub) && lower.some((a) => /^(rm|remove|prune|down|kill|stop)$/.test(a)))) return `${name} ${lower.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')} removes or stops containers, images or volumes${at}`;
  }
  if (name === 'docker-compose' && /^(down|rm|kill|stop)$/.test(sub)) return `docker-compose ${sub} stops or removes containers${at}`;
  if (/^(kubectl|oc)$/.test(name) && /^(delete|drain)$/.test(sub)) return `${name} ${sub} removes or empties things in the cluster${at}`;
  if (name === 'zfs' && /^(destroy|rollback)$/.test(sub)) return `zfs ${sub} deletes data${at}`;
  if (name === 'zpool' && /^(destroy|labelclear)$/.test(sub)) return `zpool ${sub} deletes a pool${at}`;
  if ((name === 'sc' && /^(stop|delete)$/.test(sub)) || (name === 'net' && sub === 'stop')) return `${name} ${sub} stops or removes a service${at}`;
  if ((name === 'reg' && sub === 'delete') || (name === 'vssadmin' && sub === 'delete') || (name === 'bcdedit' && lower.includes('/delete')) || (name === 'cipher' && lower.some((a) => a.startsWith('/w')))) return `${name} ${sub || lower[0]} deletes for good${at}`;
  if (c.redirects?.some((r) => /^(>|>\||&>)$/.test(r.v) && /^\/dev\/(sd|hd|nvme|mmcblk|disk|vd|xvd)/.test(r.target || ''))) return `the > redirect writes over a disk${at}`;
  const shared = GIT_RULE?.test(c) || CHMOD_RULE?.test(c); // git reset --hard, push --force…, chmod -R 000
  if (shared) return shared + at;
  // PowerShell script blocks: Get-ChildItem | ForEach-Object { Remove-Item $_ }
  for (let k = 0; k < args.length; k++) {
    const m = /^\{(.*)$/.exec(args[k].v);
    if (!m) continue;
    const inner = (m[1] || args[k + 1]?.v || '').toLowerCase();
    if (ALWAYS[inner]) return `${inner} ${ALWAYS[inner]}${at}`;
  }
  return '';
}
/** The command line that powershell -Command / -c, cmd /c, wsl run, or '' (null: an encoded one, which cannot be read). */
function innerLine(c) {
  const name = String(c.name || '').toLowerCase().replace(/\.exe$/, '');
  const args = c.args || [];
  if (name === 'powershell' || name === 'pwsh') {
    for (let k = 0; k < args.length; k++) {
      const v = args[k].v.toLowerCase();
      if (/^-(e|ec|enc|encodedcommand)$/.test(v)) return null;
      if (v.length > 1 && '-command'.startsWith(v)) return args.slice(k + 1).map((a) => a.v).join(' ');
      if (v.length > 1 && '-file'.startsWith(v)) return '';
      if (/^-(executionpolicy|ex|ep|windowstyle|w|version|v|inputformat|outputformat|of|configurationname|workingdirectory|wd|settingsfile)$/.test(v)) k++;
      else if (!v.startsWith('-')) return args.slice(k).map((a) => a.v).join(' '); // Windows PowerShell: the rest is the command
    }
    return '';
  }
  if (name === 'cmd') {
    const k = args.findIndex((a) => /^\/[ck]$/i.test(a.v));
    return k >= 0 ? args.slice(k + 1).map((a) => a.v).join(' ') : '';
  }
  if (name === 'wsl') {
    let k = 0;
    while (k < args.length && args[k].v.startsWith('-')) {
      const v = args[k].v;
      if (v === '-e' || v === '--exec' || v === '--') return args.slice(k + 1).map((a) => a.v).join(' ');
      k += /^(-d|--distribution|-u|--user|--cd)$/.test(v) ? 2 : 1;
    }
    return args.slice(k).map((a) => a.v).join(' ');
  }
  return '';
}
/** Why a pc_shell command asks first even in Auto (a kill, delete, shutdown, service/container stop…), or ''. */
export function pcDanger(command, depth = 0) {
  const line = String(command || '');
  let list = [];
  try {
    list = commands(line, { cwd: null });
  } catch {
    /* the regex below still looks */
  }
  for (const c of list) {
    const risk = pcCommandRisk(c);
    if (risk) return risk;
    const inner = innerLine(c);
    if (inner === null) return `${c.name} -EncodedCommand runs a command that cannot be read before it runs`;
    if (inner && depth < 3) {
      const r = pcDanger(inner, depth + 1);
      if (r) return r;
    }
  }
  return KILL_OR_DELETE_RE.test(line) ? 'it ends processes, deletes files or shuts the computer down' : '';
}
/** Kept for what tested the old regex: .test(command) is pcDanger as a yes/no. */
export const DESTRUCTIVE = { test: (command) => !!pcDanger(command) };

const clipOut = (x) => (x.length > 30000 ? '… (earlier output cut)\n' + x.slice(-30000) : x);
/** The last n lines of a stream (0 = all) and a note of how many earlier ones were left out (decision 274). */
function lastLines(x, n, cutOnPc) {
  if (!n) return (cutOnPc ? '… (earlier output is no longer kept on the PC)\n' : '') + clipOut(x);
  const rows = x.replace(/\n$/, '').split('\n');
  if (rows.length <= n) return (cutOnPc ? '… (earlier output is no longer kept on the PC)\n' : '') + clipOut(x);
  return `… (${rows.length - n} earlier line${rows.length - n === 1 ? '' : 's'}${cutOnPc ? ' and what the PC no longer keeps' : ''} left out – lines: 0 shows all)\n` + clipOut(rows.slice(-n).join('\n') + '\n');
}
const fmtSecs = (n) => (n >= 3600 ? `${+(n / 3600).toFixed(1)} h` : n >= 120 ? `${Math.round(n / 60)} min` : `${Math.round(n)} s`);
/** A job id the phone makes, sent with the command: a retried request is the same job, not a second run. */
export const newJobId = () => 'j' + [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, '0')).join('');
// stdin is closed: sudo cannot ask for its password, and said only "a terminal is required" (decision 274)
const SUDO_ASKS = /sudo: (a terminal is required|a password is required|no tty present|unable to read password)|sudo: \d+ incorrect password/i;
/** A /exec or /job answer as a tool result: finished, or still running as a job (never "the PC did not answer"). */
function shellResult(r, label, pc, { lines = null } = {}) {
  const part = (x) => (lines == null ? clipOut(x) : lastLines(x, lines, r.cut));
  const out = [r.stdout && part(r.stdout), r.stderr && `[stderr]\n${part(r.stderr)}`].filter(Boolean).join('\n') || '(no output yet)';
  const hint = SUDO_ASKS.test(r.stderr || '') || SUDO_ASKS.test(r.stdout || '') ? `\nHint: sudo wanted a password, and nothing can be typed into a pc_shell command. Use sudo -n with a command the user allowed without a password (a NOPASSWD line in sudoers), or ask the user to run it themselves on ${pc.name}.` : '';
  const limit = r.timeout ? `${fmtSecs(r.timeout)} timeout` : 'its timeout';
  if (r.running) return { ok: true, result: `Still running after ${fmtSecs(r.seconds ?? 20)} on ${pc.name} – job ${r.job}${r.timeout ? `, stopped by itself at the ${limit} (${fmtSecs(Math.max(0, r.timeout - (r.seconds || 0)))} from now)` : ''}. It keeps going; follow it with pc_job (job "${r.job}", action wait / read / kill).\nOutput so far:\n${out}${hint}`, display: { path: label.slice(0, 80), output: out.slice(0, 6000) }, meta: { surface: 'pc' } };
  const head = r.killed ? 'Killed.' : r.timed_out ? `Stopped: job ${r.job} ran past the ${limit} and was ended${r.exit != null ? ` (exit code ${r.exit})` : ''}; what it printed is below. Run it again with a bigger timeout_s if it needs longer.` : `Exit code ${r.exit}.`;
  return { ok: !r.timed_out && !r.killed && r.exit === 0, result: `${head} (in ${r.cwd})\n${out}${hint}`, display: { path: label.slice(0, 80), output: out.slice(0, 6000) }, meta: { surface: 'pc' } };
}

/** A short unified diff of an edit: the changed lines with two around them, at most `max` lines. */
export function shortDiff(before, after, path = '', max = 60) {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) (ea--, eb--);
  // only the part that differs is compared line by line (a big file would be too slow, and fall back to all -/+)
  const mid = ea > s && eb > s ? lineDiff(a.slice(s, ea).join('\n'), b.slice(s, eb).join('\n')) : [...a.slice(s, ea).map((x) => ({ t: '-', s: x })), ...b.slice(s, eb).map((x) => ({ t: '+', s: x }))];
  const from = Math.max(0, s - 2);
  const ops = collapseDiff([...a.slice(from, s).map((x) => ({ t: ' ', s: x })), ...mid, ...a.slice(ea, ea + 2).map((x) => ({ t: ' ', s: x }))], 2);
  const rows = ops.map((o) => (o.t === '…' ? `… ${o.s}` : `${o.t}${o.s.length > 240 ? o.s.slice(0, 240) + '…' : o.s}`));
  const shown = rows.length > max ? [...rows.slice(0, max), `… ${rows.length - max} more diff lines`] : rows;
  return `--- ${path}\n+++ ${path}\n@@ line ${from + 1} @@\n${shown.join('\n')}`;
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

/**
 * /write, then read back to prove it. → { ok, w, proof, note } – note says where the .bak is and a link written
 * through (decision 274) – or { refused } when the PC turned out to be read-only.
 */
async function saveOnPc(pc, p, bytes, { append = false, backup = true, existed = false } = {}) {
  let w;
  try {
    w = await pcCall(pc, '/write', { path: p, data: toB64(bytes), mkdirs: true, append, backup }, { timeoutMs: 120000 });
  } catch (e) {
    // a PC that was not checked since it was started read-only says so itself
    if (/shares its folders read-only/.test(e.message)) return { refused: { ok: false, result: `${e.message}. Nothing was saved.`, display: { path: p, error: 'read-only PC' }, meta: { surface: 'pc' } } };
    throw e;
  }
  let proof = 'size ' + (w.size === bytes.length || append ? 'matches' : 'DIFFERS');
  let ok = append ? w.size >= bytes.length : w.size === bytes.length;
  if (ok && !append && bytes.length <= 8 * 1024 * 1024) {
    const back = await pcReadFile(pc, p, 8 * 1024 * 1024).catch(() => null);
    if (back) {
      const [a, b] = await Promise.all([sha256Hex(back), sha256Hex(bytes)]);
      ok = a === b;
      proof = 'sha256:' + shortHash(a) + (ok ? ' read-back' : ' READ-BACK DIFFERS');
    }
  }
  const notes = [];
  if (w.link_to) notes.push(`${p} is a link: the file it points to (${w.link_to}) was written, the link stays.`);
  if (w.backup) notes.push(`The version before is kept as ${w.backup} (one .bak, replaced the next time).`);
  else if (w.backup_error) notes.push(`No .bak could be made (${w.backup_error}).`);
  else if (existed && !append && backup && !('backup' in w)) notes.push(`(${UPDATE(pc)}: this version keeps no .bak and saves the file with default permissions instead of its own.)`);
  return { ok, w, proof, note: notes.length ? ' ' + notes.join(' ') : '' };
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
      const j = await pcCall(pc, '/search', { path: pcPath(args.path, pc), name: args.name || '', text: args.text || '', regex: !!args.regex, count_only: !!args.count_only, all: !!args.all, max: args.max || 100 }, { timeoutMs: 90000 });
      const ms = j.matches || [];
      // what was not searched is said, not hidden behind "Nothing found." (decision 274)
      const notes = [];
      if (j.stopped) notes.push(`(the search stopped after ${j.stopped}: the rest was not searched – narrow path or name)`);
      if (j.left_out_count) notes.push(`(left out: ${j.left_out.slice(0, 8).join(', ')}${j.left_out_count > 8 ? ` and ${j.left_out_count - 8} more` : ''} – folders a build or an install makes; all: true searches them too)`);
      if (j.skipped_count) notes.push(`(not searched: ${j.skipped.slice(0, 8).map((s) => `${s.path} – ${s.why}`).join('; ')}${j.skipped_count > 8 ? `; and ${j.skipped_count - 8} more` : ''})`);
      if (j.skipped === undefined && args.text) notes.push(`(${UPDATE(pc)}: this version skips files over 4 MB, stops after 2000 files and folders and searches node_modules first, without saying so)`);
      if (args.count_only && args.text && j.skipped !== undefined) {
        const total = ms.reduce((n, m) => n + (m.count || 0), 0);
        const text = ms.length ? `${ms.map((m) => `${m.path}: ${m.count}`).join('\n')}\n${total} matching line${total === 1 ? '' : 's'} in ${ms.length} file${ms.length === 1 ? '' : 's'}${j.cut ? ' (more files match – narrow the search)' : ''}` : `Nothing found in ${j.searched} file${j.searched === 1 ? '' : 's'}.`;
        return { ok: true, result: [text, ...notes].join('\n'), display: { path: args.text, count: ms.length }, meta: { surface: 'pc' } };
      }
      const none = j.searched != null && args.text ? `Nothing found in ${j.searched} file${j.searched === 1 ? '' : 's'}${j.binary ? ` (and ${j.binary} binary file${j.binary === 1 ? '' : 's'} not read)` : ''}.` : 'Nothing found.';
      const text = ms.length ? ms.map((m) => (m.line ? `${m.path}:${m.line}: ${m.text}` : m.path)).join('\n') + (j.cut ? '\n… (more matches – narrow the search)' : '') : none;
      return { ok: true, result: [text, ...notes].join('\n'), display: { path: args.text || args.name || '', count: ms.length }, meta: { surface: 'pc' } };
    }
    case 'pc_read': {
      const p = pcPath(args.path, pc);
      const maxChars = Math.max(200, Math.min(40000, Number(args.max_chars) || 12000));
      const want = Math.max(1, Math.min(5000, Number(args.max_lines) || Number(args.tail_lines) || 400));
      const CH = 4 * 1024 * 1024;
      const notText = (size) => ({ ok: true, result: `${p} is not a text file (${fmtKB(size)}). Use pc_import to copy it into the workspace.`, display: { path: p }, meta: { surface: 'pc' } });
      // the end of a file (a log), or a part from a byte offset: a file past the first 4 MB was out of reach (decision 269)
      if (args.tail_lines || args.offset != null) {
        const st = await pcCall(pc, '/stat', { path: p });
        if (!st.exists) throw new Error(`Not found on ${pc.name}: ${p}`);
        const size = st.size || 0;
        const tail = !!args.tail_lines;
        const want0 = tail ? Math.max(0, size - Math.min(CH, Math.max(64 * 1024, want * 400))) : Math.max(0, Math.min(size, Number(args.offset) || 0));
        // one byte before, so an offset that is the start of a line keeps that line (the byte before it is its newline)
        const at = Math.max(0, want0 - 1);
        const j = await pcCall(pc, '/read', { path: p, offset: at, length: CH });
        let b = fromB64(j.data);
        if (b.length && !looksText(b.subarray(0, 8192))) return notText(size);
        // a part that starts in the middle of a line starts at the next one; one that ends in the middle stops before it
        let s0 = 0;
        if (at > 0) {
          const nl = b.indexOf(10);
          s0 = nl < 0 ? b.length : nl + 1;
        }
        let e0 = b.length;
        if (!j.eof) {
          const nl = b.lastIndexOf(10);
          e0 = nl >= s0 ? nl + 1 : b.length;
        }
        let lines = bytesToText(b.subarray(s0, e0)).split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        const whole = at === 0 && j.eof;
        let first = 1;
        if (tail && lines.length > want) {
          first = lines.length - want + 1;
          lines = lines.slice(-want);
        }
        const out = [];
        let used = 0;
        if (tail) {
          for (let i = lines.length - 1; i >= 0; i--) {
            const row = whole ? `${String(first + i).padStart(5)}\t${lines[i]}` : lines[i];
            if (used + row.length > maxChars && out.length) break;
            out.unshift(row);
            used += row.length + 1;
          }
          const head = whole ? `[the last ${out.length} lines of ${p}]` : `[the last ${out.length} lines of ${p} (${fmtKB(size)}; line numbers are not counted this far into the file)]`;
          return { ok: true, result: `${head}\n${out.join('\n')}`, display: { path: p, chars: used }, meta: { surface: 'pc', bytes: b.length } };
        }
        let endByte = at + s0;
        for (const ln of lines.slice(0, want)) {
          if (used + ln.length > maxChars && out.length) break;
          out.push(ln);
          used += ln.length + 1;
          endByte += new TextEncoder().encode(ln).length + 1;
        }
        endByte = Math.min(size, endByte);
        const more = endByte < size ? `\n… [more after byte ${endByte} of ${size} – pc_read with offset ${endByte}]` : '';
        return { ok: true, result: `[${p} from byte ${at + s0} of ${size}${at + s0 > 0 ? '; line numbers are not counted from an offset' : ''}]\n${out.join('\n') || '(nothing there – the offset is at the end of the file)'}${more}`, display: { path: p, chars: used }, meta: { surface: 'pc', bytes: b.length } };
      }
      const from = Math.max(1, Number(args.start_line) || 1);
      // line by line, in 4 MB parts, until the lines asked for are in (at most 32 MB in: past that, offset or tail_lines)
      const LIMIT = 32 * 1024 * 1024;
      const keep = [];
      let off = 0;
      let carry = new Uint8Array(0);
      let lineNo = 0;
      let eof = false;
      let size = 0;
      let whole = null; // the file, when it came in one part: its sha256 is what pc_edit's expect_sha256 checks
      while (true) {
        const j = await pcCall(pc, '/read', { path: p, offset: off, length: CH });
        const bytes = fromB64(j.data);
        size = j.size;
        if (off === 0 && !looksText(bytes)) return notText(j.size);
        if (off === 0 && (j.eof || !bytes.length)) whole = bytes;
        off += bytes.length;
        eof = !!j.eof || !bytes.length;
        const buf = carry.length ? new Uint8Array(carry.length + bytes.length) : bytes;
        if (carry.length) {
          buf.set(carry);
          buf.set(bytes, carry.length);
        }
        let st = 0;
        for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) {
          lineNo++;
          if (lineNo >= from && lineNo < from + want) keep.push(bytesToText(buf.subarray(st, i)));
          st = i + 1;
          if (lineNo >= from + want && !eof) break; // a part that is the last one is counted to the end: the line count is known
        }
        carry = buf.slice(st);
        if (lineNo >= from + want && !eof) break;
        if (eof) {
          if (carry.length) {
            lineNo++;
            if (lineNo >= from && lineNo < from + want) keep.push(bytesToText(carry));
          }
          break;
        }
        if (off >= LIMIT) break;
      }
      const out = [];
      let used = 0;
      for (let k = 0; k < keep.length; k++) {
        const row = `${String(from + k).padStart(5)}\t${keep[k].replace(/\r$/, '')}`;
        if (used + row.length > maxChars && out.length) break;
        out.push(row);
        used += row.length + 1;
      }
      const next = from + out.length;
      const known = eof; // every line was counted
      if (!out.length) {
        const why = known ? `(${p} has no line ${from} – it has ${lineNo} line${lineNo === 1 ? '' : 's'})` : `(line ${from} is more than ${fmtKB(LIMIT)} into ${p} (${fmtKB(size)}), past what is read line by line – use tail_lines for the end, or offset (a byte position) for a part in the middle)`;
        return { ok: true, result: why, display: { path: p }, meta: { surface: 'pc' } };
      }
      const left = !known || next <= lineNo;
      const tail = left ? `\n… [more after line ${next - 1}${known ? ` of ${lineNo}` : ''} – pc_read with start_line ${next}${known ? '' : `, or tail_lines for the end (${fmtKB(size)})`}]` : '';
      const sha = whole ? `\n[sha256 ${shortHash(await sha256Hex(whole))}]` : '';
      return { ok: true, result: out.join('\n') + tail + sha, display: { path: p, chars: used }, meta: { surface: 'pc', bytes: off } };
    }
    case 'pc_import': {
      const src = pcPath(args.path, pc);
      if (!src) throw new Error('path is required (a file or folder, starting with the shared folder\'s name)');
      const st = await pcCall(pc, '/stat', { path: src });
      if (!st.exists) throw new Error(`Not found on ${pc.name}: ${src}`);
      const to = cleanPath(args.to || '');
      let files;
      let leftOut = [];
      if (st.dir) {
        // a repo root stopped at 2000 entries, most of them node_modules: those folders are left out unless all (decision 274)
        const skip = args.all ? [] : PC_SKIP;
        const j = await pcCall(pc, '/list', { path: src, recursive: true, max: 5000, skip }, { timeoutMs: 60000 });
        const old = j.left_out === undefined;
        const inSkip = (e) => e.path.slice(src.length).split('/').some((x) => skip.includes(x));
        if (j.cut) throw new Error(`${src} has more than 5000 files and folders${skip.length ? ` even without ${PC_SKIP.slice(0, 4).join(', ')}…` : ''} – import a sub-folder.${old && skip.length ? ` (${UPDATE(pc)}: this version cannot leave node_modules and the like out.)` : ''}`);
        leftOut = old ? [...new Set((j.entries || []).filter((e) => e.dir && skip.includes(e.path.split('/').pop())).map((e) => e.path))] : j.left_out;
        files = (j.entries || []).filter((e) => !e.dir && !(old && inSkip(e)));
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
      const left = leftOut.length ? `\nLeft out (made again by a build or an install): ${leftOut.slice(0, 12).join(', ')}${leftOut.length > 12 ? ` and ${leftOut.length - 12} more` : ''} – all: true (or one of them as path) copies them too.` : '';
      return { ok: true, result: `Copied ${done.length} file${done.length === 1 ? '' : 's'} from ${pc.name} into /workspace:\n${show}${done.length > 40 ? `\n… and ${done.length - 40} more (use list_files)` : ''}${left}`, display: { files: done.slice(0, 20), count: done.length }, meta: { surface: 'pc', bytes: total } };
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
      const s = await saveOnPc(pc, p, bytes, { append: !!args.append, backup: args.backup !== false, existed: st.exists });
      if (s.refused) return s.refused;
      return s.ok
        ? { ok: true, result: (args.append ? `Added ${fmtKB(bytes.length)} to the end of ${p} on ${pc.name} (now ${fmtKB(s.w.size)}).` : `${st.exists ? 'Replaced' : 'Saved'} ${p} on ${pc.name} (${fmtKB(bytes.length)}).`) + s.note, display: { path: p }, meta: { surface: 'pc', bytes: bytes.length, proof: s.proof } }
        : { ok: false, result: `The file was written but does not read back the same – treat ${p} as NOT saved.`, display: { path: p, error: 'read-back differs' }, meta: { surface: 'pc', bytes: bytes.length, proof: s.proof } };
    }
    case 'pc_edit': {
      // exact-text edits on the PC, done here with /read and /write: a whole-file pc_write for a one-line change
      // rewrote what the model had not read, and nothing caught a file that changed in between (decision 274)
      const p = pcPath(args.path, pc);
      if (!p.includes('/')) throw new Error(`path must be inside a shared folder, e.g. ${(pc.folders || ['Documents'])[0]}/${p || 'notes.txt'}`);
      const edits = Array.isArray(args.edits) && args.edits.length ? args.edits : args.old_text != null ? [{ old_text: args.old_text, new_text: args.new_text ?? '', replace_all: args.replace_all }] : [];
      if (!edits.length) throw new Error('Give edits ([{ old_text, new_text }]) or old_text and new_text.');
      const m = mode(ctx);
      if (m === 'readonly') return { ok: false, result: 'This chat is read-only, so nothing was changed on the computer.', display: { path: p, error: 'read-only' }, meta: { surface: 'pc' } };
      if (pc.write === false) return { ok: false, result: `${pc.name} shares its folders read-only, so nothing was changed. The user can restart pc-files.py with --write to allow saving.`, display: { path: p, error: 'read-only PC' }, meta: { surface: 'pc' } };
      const st = await pcCall(pc, '/stat', { path: p });
      if (!st.exists) throw new Error(`Not found on ${pc.name}: ${p}. pc_write makes a new file.`);
      if (st.dir) throw new Error(`${p} is a folder – give a file inside it.`);
      if (st.size > MAX_EDIT_BYTES) throw new Error(`${p} is ${fmtKB(st.size)} – too big to edit here (limit ${fmtKB(MAX_EDIT_BYTES)}).`);
      const bytes = await pcReadFile(pc, p, MAX_EDIT_BYTES);
      if (!looksText(bytes)) throw new Error(`${p} is not a text file – pc_import it to work on it.`);
      let before;
      try {
        before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); // a BOM stays, other text encodings are not rewritten as UTF-8
      } catch {
        throw new Error(`${p} is not UTF-8 text, so it is not edited here (it would be saved in another encoding). pc_import it, change it, and pc_write it back if that is meant.`);
      }
      const sha = await sha256Hex(bytes);
      const want = String(args.expect_sha256 || '').trim().toLowerCase().replace(/^sha256[:\s]*/, '');
      if (want && (want.length < 8 || !sha.startsWith(want))) return { ok: false, result: `${p} changed on ${pc.name} since you read it (sha256 now ${shortHash(sha)}, you gave ${want.slice(0, 12)}), so nothing was changed. Read it again with pc_read and redo the edit on what is there now.`, display: { path: p, error: 'changed since read' }, meta: { surface: 'pc' } };
      const { text, replaced } = applyEdits(before, edits, p);
      const diff = shortDiff(before, text, p);
      if (m === 'ask') {
        if (!ctx.ask) return { ok: false, result: "Changing a file on the computer needs the user's OK, which is not available here.", display: { path: p, error: 'unavailable' }, meta: { surface: 'pc' } };
        ctx.onStatus?.('waiting for your OK…');
        const ans = await ctx.ask(`Change ${p} on ${pc.name}?\n\n${diff}`, ['Change it', 'Not now'], ctx.signal);
        if (ans !== 'Change it') return { ok: false, result: `The user said no (${ans}). Nothing was changed on the computer.`, display: { path: p, error: 'declined' }, meta: { surface: 'pc' } };
      }
      const out = new TextEncoder().encode(text);
      const s = await saveOnPc(pc, p, out, { backup: args.backup !== false, existed: true });
      if (s.refused) return s.refused;
      if (!s.ok) return { ok: false, result: `The file was written but does not read back the same – treat ${p} as NOT changed.`, display: { path: p, error: 'read-back differs' }, meta: { surface: 'pc', bytes: out.length, proof: s.proof } };
      return { ok: true, result: `Edited ${p} on ${pc.name}: ${replaced} change${replaced === 1 ? '' : 's'}.${s.note}\n${diff}\n[sha256 ${shortHash(await sha256Hex(out))}]`, display: { path: p }, meta: { surface: 'pc', bytes: out.length, proof: s.proof } };
    }
    case 'pc_shell': {
      const command = String(args.command || '').trim();
      if (!command) throw new Error('command is required');
      if (!pc.full) return { ok: false, result: `${pc.name} does not allow running commands (pc-files.py was not started with --full).`, display: { error: 'not full control' }, meta: { surface: 'pc' } };
      const m = mode(ctx);
      if (m === 'readonly') return { ok: false, result: 'This chat is read-only, so no command was run on the computer.', display: { error: 'read-only' }, meta: { surface: 'pc' } };
      // a kill or delete: what it would hit, first (decision 233) – "two Notepad windows, which one?"
      let hits = '';
      const danger = pcDanger(command);
      if (danger) {
        const pv = await pcCall(pc, '/preview', { command, cwd: args.cwd || '' }).catch(() => null); // an older pc-files.py has no preview
        const procs = pv?.processes || [];
        const files = pv?.files || [];
        hits = [...procs.map((x) => `process ${x.name} (pid ${x.pid})${x.title ? ` – “${x.title}”` : ''}`), ...files.map((f) => (f.dir ? `folder ${f.path} (${f.items} item${f.items === 1 ? '' : 's'} inside)` : `file ${f.path} (${fmtKB(f.size)})`))].join('\n');
        if (procs.length + files.length > 1 && !args.confirm)
          return { ok: false, result: `Not run: this would hit ${procs.length + files.length} things on ${pc.name}:\n${hits}\n\nIf that is not exactly what you mean, narrow the command (a process by its pid – taskkill /PID 1234 – or the one file). If you do mean all of them, call pc_shell again with confirm: true.`, display: { error: `would hit ${procs.length + files.length}`, path: command.slice(0, 60) }, meta: { surface: 'pc' } };
      }
      // Review asks before every command; Auto asks before a kill or delete too; Bypass asks nothing
      if (m === 'ask' || (danger && !ctx.phone?.bypass?.())) {
        if (!ctx.ask) return { ok: false, result: `Running this on the computer needs the user's OK${danger ? ` (${danger})` : ''}, which is not available here.`, display: { error: 'unavailable' }, meta: { surface: 'pc' } };
        ctx.onStatus?.('waiting for your OK…');
        const yes = 'Run it';
        const ans = await ctx.ask(`Run on ${pc.name}${args.cwd ? ` (in ${args.cwd})` : ''}:\n\n${command}${hits ? `\n\nThis will hit:\n${hits}` : ''}${danger ? `\n\n(${danger})` : ''}`, [yes, 'Not now'], ctx.signal);
        if (ans !== yes) return { ok: false, result: `The user said no (${ans}). Nothing was run.`, display: { error: 'declined', path: command.slice(0, 60) }, meta: { surface: 'pc' } };
      }
      ctx.onStatus?.(`running on ${pc.name}…`);
      const t = Math.max(1, Math.min(21600, Number(args.timeout_s) || 600));
      const job = newJobId();
      const r = await pcCall(pc, '/exec', { command, cwd: args.cwd || '', timeout: t, wait: globalThis.__ocmPcWait ?? 20, job }, { timeoutMs: 60000, running: true, job });
      return shellResult(r, command, pc);
    }
    case 'pc_job': {
      const job = String(args.job || '').trim();
      const action = args.action || (job ? 'wait' : 'list');
      if (action === 'list') {
        let j;
        try {
          j = await pcCall(pc, '/jobs', {}, { timeoutMs: 30000 });
        } catch (e) {
          if (/404|not found|unknown/i.test(String(e?.message || e))) return { ok: false, result: `pc-files.py on ${pc.name} is too old to list its jobs – update it (version 4 or newer).`, display: { error: 'too old' }, meta: { surface: 'pc' } };
          throw e;
        }
        const jobs = j?.jobs || [];
        const lines = jobs.map((x) => `${x.job} – ${x.running ? `running ${fmtSecs(x.seconds)} of ${fmtSecs(x.timeout)}` : x.killed ? 'killed' : x.timed_out ? `stopped at its ${fmtSecs(x.timeout)} timeout` : `ended, exit code ${x.exit}`} – ${x.command}${x.cwd ? ` (in ${x.cwd})` : ''}`);
        return { ok: true, result: jobs.length ? `${jobs.length} job${jobs.length === 1 ? '' : 's'} on ${pc.name} (newest first; an ended one is kept for an hour):\n${lines.join('\n')}` : `No jobs on ${pc.name} (an ended one is kept for an hour, none across a restart of pc-files.py).`, display: { path: 'jobs', output: lines.join('\n').slice(0, 6000) }, meta: { surface: 'pc' } };
      }
      if (!job) throw new Error('job is required (the id pc_shell gave) – or action list to see them all');
      const r = await pcCall(pc, '/job', { job, kill: action === 'kill', wait: action === 'wait' ? Math.max(1, Math.min(25, Number(args.wait_s) || 25)) : 0 }, { timeoutMs: 60000, running: true });
      // the last lines, like shell_job: every poll gave up to 30,000 characters of each stream again (decision 274)
      const lines = args.lines === 0 ? 0 : Math.max(1, Math.min(5000, Number(args.lines) || 80));
      return shellResult(r, `job ${job}`, pc, { lines });
    }
    default:
      return null;
  }
}
