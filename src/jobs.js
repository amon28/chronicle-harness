// Job handles for the built-in Linux. A long command should not gamble on a timeout: the exec call
// keeps running in the background, the tool returns { job_id, partial_output } after ~30 s, and polling
// reads what has arrived so far. Nothing here knows what a shell is - shell.js wires in exec/kill/listen.
const jobs = new Map();
const KEEP_MS = 10 * 60 * 1000; // a finished job stays pollable for a while, then is forgotten
let deps = null;

/** shell.js calls this once: { exec(cmd,{id,timeoutMs}), kill(id), onOutput(fn) }. */
export function configureJobs(d) {
  deps = d;
}

export const jobId = () => 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A runaway command must not fill the phone's memory with its log; the tail is what matters. */
const MAX_KEEP = 512 * 1024;
const keepTail = (s) => {
  const t = String(s || '');
  return t.length > MAX_KEEP ? '… [' + (t.length - MAX_KEEP) + ' characters of earlier output left out] …\n' + t.slice(-MAX_KEEP) : t;
};

/** Resolve early (never reject) after ms: a post-command step must not hold a job open for ever. */
function withTimeout(promise, ms) {
  return Promise.race([Promise.resolve(promise), sleep(ms).then(() => undefined)]);
}
const text = (v) => (typeof v === 'string' ? v : '');

function prune() {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > KEEP_MS) jobs.delete(id);
}

/**
 * Start a command and keep hold of it. Returns the record immediately; watch it with settle().
 * exec resolves when the command ends (or when the shell's own timeout fires).
 */
export function startJob({ cmd, shellId, timeoutMs, mounts = '', onProgress, onFinish, note, signal = null }) {
  if (!deps) throw new Error('The job runner is not configured');
  const job = {
    id: jobId(),
    cmd: String(cmd),
    shellId,
    started: Date.now(),
    status: 'running',
    exit: null,
    timedOut: false,
    ended: false,
    error: null,
    finishedAt: null,
    note: note || '',
  };
  jobs.set(job.id, job);
  // live output: only the newest part is kept, and the tail is made when someone looks (not on every chunk – a
  // command that prints megabytes sends hundreds of chunks)
  let streamed = '';
  let dropped = 0;
  let fixed = null;
  Object.defineProperty(job, 'output', {
    enumerable: true,
    get: () => (fixed != null ? fixed : dropped ? '… [' + (dropped + Math.max(0, streamed.length - MAX_KEEP)) + ' characters of earlier output left out] …\n' + streamed.slice(-MAX_KEEP) : keepTail(streamed)),
    set: (v) => (fixed = v),
  });
  let stop = () => {};
  try {
    const handle = deps.onOutput?.((e) => {
      if (e?.id !== shellId) return;
      streamed += text(e.data);
      if (streamed.length > 2 * MAX_KEEP) {
        dropped += streamed.length - MAX_KEEP;
        streamed = streamed.slice(-MAX_KEEP);
      }
      onProgress?.(streamed);
    });
    // subscribing is async in the plugin layer: stop() has to work either way
    if (handle && typeof handle.then === 'function')
      handle.then((fn) => {
        if (typeof fn !== 'function') return;
        if (job.finishedAt) fn(); // the command beat the subscription: do not leave the listener behind
        else stop = fn;
      }, () => {});
    else if (typeof handle === 'function') stop = handle;
  } catch {
    /* live output is a nicety: the final result is still authoritative */
  }
  job.done = Promise.resolve()
    .then(() => deps.exec(job.cmd, { id: shellId, timeoutMs, mounts, signal })) // signal: given up on while it waited for the shell → never run
    .then(async (r) => {
      job.timedOut = !!r?.timedOut;
      job.ended = !!r?.ended;
      job.exit = job.timedOut ? null : job.ended ? (r?.exit >= 0 ? r.exit : null) : (r?.exit ?? null);
      job.output = text(r?.output) ? keepTail(text(r.output)) : job.output;
      job.status = job.timedOut ? 'timed-out' : job.ended ? 'ended' : 'done';
      // a timed-out command is stopped, not left to run on and write files after the job says it ended (bug D)
      if (job.timedOut) {
        try {
          job.reaped = await withTimeout(Promise.resolve(deps.kill?.(shellId, { since: job.started })), 20000);
          job.kept = deps.kept?.(shellId) || [];
        } catch {
          job.reaped = null;
        }
        job.note = [job.note, 'timed out after ' + Math.round(timeoutMs / 1000) + ' s – killed (the command and what it started)'].filter(Boolean).join('; ');
      }
      // whatever has to happen after the command (bringing files back from the shell) happens
      // before the job reports finished, so a poll never says DONE about a half-applied result
      if (onFinish) {
        try {
          await withTimeout(onFinish(job), 90000);
        } catch (err) {
          job.note = [job.note, 'after the command: ' + String(err?.message || err)].filter(Boolean).join('; ');
        }
      }
      job.finishedAt = Date.now();
      return job;
    })
    .catch((e) => {
      job.status = 'failed';
      job.error = String(e?.message || e);
      job.output = job.output; // keep what was streamed
      job.finishedAt = Date.now();
      return job;
    })
    .finally(() => {
      stop();
      prune();
    });
  return job;
}

/** Wait until the job finishes or `softMs` passes, whichever comes first. */
export async function settle(job, softMs) {
  if (!job.finishedAt) await Promise.race([job.done, sleep(Math.max(0, softMs))]);
  return job;
}

export const isRunning = (job) => !!job && !job.finishedAt;
/** Is any shell job still running? (the app stays alive for it, decision 276) */
export const anyJobRunning = () => [...jobs.values()].some((j) => !j.finishedAt);

/** A job as the model and the UI see it: status, exit code, elapsed time and the last N lines. */
export function jobSnapshot(job, { lines = 80, full = false } = {}) {
  if (!job) return null;
  const output = full ? job.output : tailLines(job.output, lines);
  return {
    id: job.id,
    cmd: job.cmd,
    shell: job.shellId,
    status: job.status,
    exit: job.exit,
    timedOut: job.timedOut,
    ended: job.ended,
    error: job.error,
    elapsed: Math.round(((job.finishedAt || Date.now()) - job.started) / 1000),
    running: isRunning(job),
    bytes: new TextEncoder().encode(job.output || '').byteLength,
    output,
    note: job.note,
  };
}

export function tailLines(textStr, n) {
  const s = String(textStr || '').replace(/\n+$/, '');
  if (!s) return '';
  const want = Math.max(0, Number(n) || 0);
  if (!want) return s;
  const lines = s.split('\n');
  return lines.length <= want ? s : `… [${lines.length - want} earlier lines] …\n` + lines.slice(-want).join('\n');
}

export const getJob = (id) => jobs.get(String(id || '')) || null;

/** The job (if any) still running in this shell. */
export const jobOnShell = (shellId) => [...jobs.values()].find((j) => j.shellId === shellId && isRunning(j)) || null;

export function listJobs() {
  prune();
  return [...jobs.values()].sort((a, b) => b.started - a.started).map((j) => jobSnapshot(j, { lines: 6 }));
}

/** The shell was killed: settle its job honestly rather than leaving it RUNNING for ever. */
export async function killJob(job) {
  if (!job) return null;
  if (isRunning(job)) {
    try {
      await deps?.kill?.(job.shellId, { since: job.started }); // what the job started, not a server left running earlier
    } catch {
      /* the shell may already be gone */
    }
    await settle(job, 1500);
    if (isRunning(job)) {
      // the exec call never came back (the process was destroyed under it): say so
      job.status = 'killed';
      job.finishedAt = Date.now();
    }
  }
  return jobSnapshot(job);
}
