// doctor: what this machine is, surface by surface, in one call. The app-side companion of the
// shell's doctor script. Each surface is exercised rather than advertised - a probe that only reads
// a flag is the kind of check that reports ok without touching the path.
import { canUseShell, ensureShellToolkit, runShell, shellStatus } from './shell.js';
import { sandbox, getWorkspace } from './sandbox.js';
import { listFolder, folderLocalPath } from './phonefolder.js';
import { canControlBrowser } from './browsercontrol.js';
import { readUrl } from './webread.js';
import { WORK, PHONE, mountSpec } from './bridge.js';
import { backgroundRow, keepAlivePlugin } from './bgstate.js';
import { formatLog, readLog } from './errorlog.js';

export const DOCTOR_PROBE = 'https://example.com';

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const doctorDefs = () => [
  fn(
    'doctor',
    'Check what this machine actually is before working on it: which surfaces answer right now (the built-in Linux, Python, the phone folder, the browser, the network, background running) and the latest errors the app logged, what the Linux has installed, how the workspace and phone folder are mounted, and which files are where. Use it once at the start of a task that depends on a tool that may be missing (ffmpeg, python3, curl), or when something behaves unlike the docs say. Every line says which surface answered.',
    {
      surfaces: { type: 'array', items: { type: 'string', enum: ['shell', 'python', 'phone', 'browser', 'network', 'background', 'errors'] }, description: 'Only these surfaces (default: all)' },
      network: { type: 'boolean', description: 'Include the HTTP probe (default true)' },
      deep: { type: 'boolean', description: 'Also start Python and run a line in it, to prove it works rather than report that it would (slower: it loads Pyodide)' },
    },
  ),
];

const line = (name, state, detail) => name.padEnd(12) + ' ' + state.toUpperCase().padEnd(11) + ' ' + detail;

async function shellProbe(ctx) {
  const st = await shellStatus();
  if (!canUseShell()) return { rows: [line('shell', 'n/a', 'only in the Android app')], ok: true };
  if (!st.available) return { rows: [line('shell', 'n/a', 'this phone cannot run it (needs 64-bit ARM and the app build)')], ok: true };
  if (!st.installed) return { rows: [line('shell', 'missing', 'Settings → Linux terminal → Install (Debian, about 30 MB)')], ok: false };
  const id = 'chat:' + (ctx.convId || 'main'); // the chat's own shell, so its state is what gets checked
  // with the chat's own mounts: a shell started without them would be a different shell (the app restarts a shell
  // whose mounts change, losing cd, variables and background processes) and would report nothing about /workspace
  const mounts = (await mountSpec(ctx, ctx.convId || 'main').catch(() => null))?.mounts || '';
  await ensureShellToolkit(id, mounts).catch(() => {});
  const out = await runShell('doctor 2>&1', { id, timeoutMs: 60000, mounts }).catch(async (e) => {
    // the chat's shell is busy with a job: a second shell can still answer
    return await runShell('doctor 2>&1', { id: id + ':doctor', timeoutMs: 60000, mounts }).catch(() => ({ output: 'doctor failed: ' + (e.message || e), exit: 1 }));
  });
  const body = String(out.output || '').trim().split('\n');
  return { rows: [line('shell', out.exit === 0 ? 'ok' : 'error', (st.distro || st.abi || 'linux') + ', ' + id), ...body.map((l) => '  ' + l)], ok: out.exit === 0, raw: body.join('\n') };
}

async function pythonProbe(ctx, deep) {
  const warm = !!(sandbox.worker && sandbox.ready);
  if (!deep) return { rows: [line('python', warm ? 'warm' : 'cold', warm ? 'Pyodide is loaded for this chat' : 'starts on the first run_python (a few MB, once per session); pass deep to start it now')], ok: true };
  try {
    const w = await getWorkspace(ctx.convId || 'doctor');
    const r = await sandbox.run(w, 'import sys\nprint(sys.version.split()[0])', { timeoutMs: 90000 });
    const v = String(r.stdout || r.error || '').trim().slice(0, 40);
    return { rows: [line('python', r.error ? 'error' : 'ok', 'Python ' + v + ' (Pyodide, ' + (r.ms || 0) + ' ms)')], ok: !r.error };
  } catch (e) {
    return { rows: [line('python', 'error', String(e?.message || e))], ok: false };
  }
}

async function phoneProbe(ctx) {
  const f = ctx.phone?.folder?.();
  if (!f) return { rows: [line('phone folder', 'none', 'nothing linked; phone_folder action "link" asks for one')], ok: true };
  const host = await folderLocalPath(f).catch(() => null);
  try {
    const entries = await listFolder(f, '', false, 5);
    const names = entries.slice(0, 4).map((e) => e.path + (e.isDir ? '/' : '')).join(', ');
    return { rows: [line('phone folder', 'ok', '"' + f.name + '" (' + entries.length + ' entries' + (names ? ': ' + names : '') + ')'), '  mounted as ' + (host ? '/phone (bind to ' + host + ')' : '/phone (copy, checked by hash)')], ok: true };
  } catch (e) {
    return { rows: [line('phone folder', 'error', String(e?.message || e))], ok: false };
  }
}

function browserProbe() {
  if (!canControlBrowser()) return { rows: [line('browser', 'n/a', 'only in the Android app, and only when enabled in Settings')], ok: true };
  return { rows: [line('browser', 'ok', 'available (a page is opened when a task needs one, not by doctor)')], ok: true };
}

/** Whether a reply keeps going when the app is in the background (decision 172): Android can refuse or pause it. */
async function backgroundProbe() {
  const k = keepAlivePlugin();
  const st = k?.status ? await k.status().catch(() => null) : null;
  const r = backgroundRow(k ? st || { running: false, lastStop: 'status unknown' } : null);
  return { rows: [line('background', r.state, r.detail)], ok: true };
}

/** The app's error log (decision 177): how many in the last day, and the newest few – error text only. */
function errorsProbe() {
  const all = readLog();
  const day = all.filter((e) => Date.now() - e.at < 864e5);
  if (!all.length) return { rows: [line('errors', 'none', 'nothing in the app error log')], ok: true };
  const rows = [line('errors', day.length ? 'logged' : 'old only', `${day.length} in the last 24 h, ${all.length} kept (Settings › Data › Error log)`)];
  rows.push(...formatLog(all, { limit: 8 }).split('\n').map((l) => '  ' + l));
  return { rows, ok: true };
}

async function networkProbe() {
  const t0 = Date.now();
  const r = await readUrl(DOCTOR_PROBE, { maxChars: 300, timeoutMs: 12000 }).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
  const ms = Date.now() - t0;
  const detail = r.ok ? 'HTTP ' + r.status + ' via ' + (r.via || 'direct') + ', ' + (r.bytes || 0) + ' bytes in ' + ms + ' ms' : 'FAILED: ' + (r.reason || 'unknown') + ' after ' + ms + ' ms';
  // what this row is and is not (decision 269): the app's own web requests – the Linux shell has its own route (its
  // doctor script probes it), and local-network addresses are refused by the app's web tools whatever this says
  const scope = ' (the app\'s own requests: fetch_url, web_search, the browser; the Linux shell is checked by its own doctor lines; addresses on the local network are refused by these tools unless the user allowed them for the chat – local_network)';
  return { rows: [line('network', r.ok ? 'ok' : 'error', DOCTOR_PROBE + ' - ' + detail + scope)], ok: !!r.ok };
}

export async function runDoctorTool(args, ctx) {
  const want = Array.isArray(args.surfaces) && args.surfaces.length ? args.surfaces : ['shell', 'python', 'phone', 'browser', 'network', 'background', 'errors'];
  const rows = [];
  let ok = true;
  if (want.includes('shell')) {
    const r = await shellProbe(ctx);
    rows.push(...r.rows);
    ok &&= r.ok;
  }
  if (want.includes('python')) {
    const r = await pythonProbe(ctx, !!args.deep);
    rows.push(...r.rows);
    ok &&= r.ok;
  }
  if (want.includes('phone')) {
    const r = await phoneProbe(ctx);
    rows.push(...r.rows);
    ok &&= r.ok;
  }
  if (want.includes('browser')) rows.push(...browserProbe().rows);
  if (want.includes('background')) rows.push(...(await backgroundProbe()).rows);
  if (want.includes('errors')) rows.push(...errorsProbe().rows);
  if (args.network !== false && want.includes('network')) {
    const r = await networkProbe();
    rows.push(...r.rows);
    ok &&= r.ok;
  }
  rows.push(line('mounts', 'ok', WORK + ' = this chat workspace, ' + PHONE + ' = the linked phone folder (bound, or a hash-checked copy)'));
  const text = rows.join('\n');
  return {
    ok,
    result: text,
    display: { surfaces: want, output: text.slice(0, 4000) },
    meta: { surface: 'harness', bytes: new TextEncoder().encode(text).byteLength },
  };
}
