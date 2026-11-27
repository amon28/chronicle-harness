// Running shell jobs of this chat as chips above the message box: what is running, for how long, and a stop for each
// (the reply's own Stop button stops the whole reply; this stops one job and lets the rest carry on).
import { $, el, state, toast } from './core.js';
import { getJob, killJob, listJobs } from '../jobs.js';
import { runShell, usedShells } from '../shell.js';
import { MIN_AGE, listCmd, parseProcs, stopCmd } from '../procs.js';
import { chooseOne } from './choose.js';

const fmt = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
/** The running jobs of a chat: [{ id, cmd, elapsed }] */
export const runningJobs = (convId, jobs = listJobs()) => jobs.filter((j) => j.running && String(j.shell || '').startsWith('chat:' + convId)).map((j) => ({ id: j.id, cmd: String(j.cmd || '').split('\n')[0], elapsed: j.elapsed }));

let sig = '';
// ---------- what the chat's shell left running (`nohup … &`): found every few seconds, while you look at the chat ----------
let procs = { conv: '', list: [], at: 0 }; // the last look, and when (their clocks run on from it)
let looking = false;
async function lookForProcs() {
  const conv = state.current;
  const shell = conv ? 'chat:' + conv.id : '';
  if (!conv || !usedShells.has(shell) || document.hidden || looking) return;
  // while the chat is writing, its own commands are running too: those are not "left running"
  if (state.runs?.has(conv.id) || listJobs().some((j) => j.running && String(j.shell || '').startsWith(shell))) return;
  looking = true;
  try {
    const r = await runShell(listCmd(shell), { id: 'procs', timeoutMs: 15000 });
    // the "a few seconds old" filter counts from when the app first saw it, not from what this look could tell
    if (state.current?.id === conv.id) procs = { conv: conv.id, list: parseProcs(r.output, { minAge: 0 }).map((p) => ({ ...p, age: ageOf(conv.id, p) })).filter((p) => p.age >= MIN_AGE), at: Date.now() };
  } catch {
    /* the next look tries again */
  } finally {
    looking = false;
    render();
  }
}
setInterval(lookForProcs, 8000);
document.addEventListener('visibilitychange', () => !document.hidden && lookForProcs());

// When each process was first seen (kept on the phone): a clock that never goes back to 0, also when Linux cannot
// tell a process's age or the app was in the background (the WebView may even have been reloaded)
const SEEN_KEY = 'ocm-procs-seen';
function ageOf(convId, p) {
  let seen = {};
  try {
    seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
  } catch {
    /* a fresh record */
  }
  const key = `${convId}:${p.pid}:${p.cmd.slice(0, 80)}`; // a reused pid with another command is another process
  const now = Date.now();
  if (!seen[key]) seen[key] = now - p.age * 1000;
  // keep the record small: only what was seen in the last two days
  for (const [k, t] of Object.entries(seen)) if (now - t > 2 * 86400000) delete seen[k];
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* the clock still runs for this visit */
  }
  return Math.max(p.age, Math.round((now - seen[key]) / 1000));
}

/** The process in plain words: the program and what it was given, shortened. */
const procName = (cmd) => {
  const parts = cmd.split(/\s+/).filter(Boolean);
  const i = parts[0] && /^(nohup|sh|bash|ash|setsid|exec)$/.test(parts[0].split('/').pop()) && parts[1] && !/^-/.test(parts[1]) ? 1 : parts[0] && /^(sh|bash)$/.test(parts[0].split('/').pop()) && parts[1] === '-c' ? 2 : 0;
  return parts.slice(i).join(' ').replace(/^\S*\//, '') || cmd;
};
async function stopProc(conv, p) {
  const ok = await chooseOne(
    `Stop ${procName(p.cmd).slice(0, 40)}?`,
    [
      { label: 'Stop it', value: true, danger: true, sub: p.kids ? `and the ${p.kids} process${p.kids > 1 ? 'es' : ''} it started` : '' },
      { label: 'Keep it running', value: false },
    ],
    `${p.cmd.slice(0, 300)}\n\nStarted by the assistant's shell in this chat and left running ${fmt(p.age + Math.round((Date.now() - procs.at) / 1000))}. A recording or download that is stopped keeps what it saved so far.`,
  );
  if (!ok) return;
  try {
    const r = await runShell(stopCmd('chat:' + conv.id, p.pid), { id: 'procs', timeoutMs: 15000 });
    const out = String(r.output || '');
    toast(/@@STOPPED/.test(out) ? `Stopped ${procName(p.cmd).slice(0, 40)}` : /@@NOTOURS/.test(out) ? 'It had already ended' : 'It did not stop – try again', 4000);
  } catch (e) {
    toast('Could not stop it: ' + (e?.message || e), 5000);
  }
  procs.list = procs.list.filter((x) => x.pid !== p.pid);
  render();
  lookForProcs();
}

function render() {
  const bar = $('#jobs-bar');
  const conv = state.current;
  const jobs = conv ? runningJobs(conv.id) : [];
  const left = conv && procs.conv === conv.id ? procs.list : [];
  const none = !jobs.length && !left.length;
  if (bar.hidden !== none) bar.hidden = none; // set every 1.5 s, it was a change to the page each time (decision 243)
  if (none && !sig) return;
  const since = Math.round((Date.now() - procs.at) / 1000);
  // only rebuild when the set changes; the clocks are updated in place
  const now = jobs.map((j) => j.id).join(',') + '|' + left.map((p) => p.pid).join(',');
  if (now !== sig) {
    sig = now;
    bar.innerHTML = '';
    for (const j of jobs) {
      const chip = el('span', 'job-chip');
      chip.dataset.job = j.id;
      chip.title = j.cmd;
      const stop = el('button', 'job-stop', '✕');
      stop.setAttribute('aria-label', `Stop ${j.cmd.slice(0, 40)}`);
      stop.onclick = async () => {
        stop.disabled = true;
        const job = getJob(j.id);
        if (job) await killJob(job).catch(() => {});
        toast(`Stopped: ${j.cmd.slice(0, 50)}`);
        render();
      };
      chip.append(el('span', 'job-dot'), el('span', 'job-cmd', j.cmd.slice(0, 28) + (j.cmd.length > 28 ? '…' : '')), el('span', 'job-time dim', fmt(j.elapsed)), stop);
      bar.append(chip);
    }
    for (const p of left) {
      const chip = el('button', 'job-chip bg-proc');
      chip.dataset.proc = p.pid;
      chip.title = p.cmd;
      chip.setAttribute('aria-label', `Running in the background: ${p.cmd.slice(0, 60)} – tap to stop`);
      const name = procName(p.cmd);
      chip.append(el('span', 'job-dot'), el('span', 'job-cmd', '⚙ ' + name.slice(0, 26) + (name.length > 26 ? '…' : '')), el('span', 'job-time dim', fmt(p.age + since)), el('span', 'job-stop', '✕'));
      chip.onclick = () => stopProc(conv, p);
      bar.append(chip);
    }
  } else {
    for (const j of jobs) bar.querySelector(`[data-job="${j.id}"] .job-time`)?.replaceChildren(fmt(j.elapsed));
    for (const p of left) bar.querySelector(`[data-proc="${p.pid}"] .job-time`)?.replaceChildren(fmt(p.age + since));
  }
}
setInterval(render, 1500);
