// ask_model jobs (decision 179): every helper Claude Code starts on one of Chronicle's models is a job with an id, so
// it can be started in the background, looked at while it works (state, last activity, what it is doing, files it
// touched), fetched when done – also after the call that started it gave up – and cancelled. Finished jobs are kept
// on the phone (localStorage), so an id and its answer survive an app restart; a job that was running when the app
// stopped is "interrupted" (it ran in the app, so it stopped too).

export const KEEP = 30; // jobs remembered (the oldest finished ones go first)
const TAIL = 12; // activity lines kept per job
const jobs = new Map(); // id -> job
const STORE = 'ocm.modeljobs';
const recent = new Map(); // path -> { job, at, conv, sig, unsure }: the last job that changed it (conflicts between jobs)
// every tool step: when it ran and what it was asked (the command, the path) – two jobs whose steps overlap both see
// the other's files land, and only the text of a step can tell whose a file is
const steps = []; // { job, conv, from, to (0 while it runs), hint }
const STEP_KEEP_MS = 600000;
let seq = 0; // start order (two jobs can start in the same millisecond)
const now = () => Date.now();
const live = (j) => j.state === 'running' || j.state === 'cancelling';

const newId = () => 'job_' + Math.random().toString(36).slice(2, 8);
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** A new running job. → the job (its `signal` stops the helper on cancel). */
export function startJob({ conv, model = '', task = '', tools = 'none', background = false }) {
  const ctrl = new AbortController();
  const j = { id: newId(), seq: ++seq, conv, model, task: clip(task, 200), tools, background, state: 'running', startedAt: now(), lastAt: now(), lastWhat: 'started', tail: [], changes: new Map(), conflicts: [], chars: 0, result: '', error: '', endedAt: 0, readAt: 0, ctrl, signal: ctrl.signal };
  while (jobs.has(j.id)) j.id = newId();
  jobs.set(j.id, j);
  // over the limit: forget the oldest finished jobs (never a running one)
  const done = [...jobs.values()].filter((x) => !live(x)).sort((a, b) => a.seq - b.seq);
  while (jobs.size > KEEP && done.length) jobs.delete(done.shift().id);
  saveJobs();
  return j;
}

export const getJob = (id) => jobs.get(String(id || '').trim()) || null;
export const jobsOf = (conv) => [...jobs.values()].filter((j) => j.conv === conv).sort((a, b) => b.seq - a.seq);

/** Something the helper did: a tool step ("edit_file painter_gen.js"), or text it wrote. */
export function noteActivity(j, what, { kind = 'step' } = {}) {
  if (!j || !live(j)) return;
  j.lastAt = now();
  if (kind === 'text') {
    j.chars += what.length;
    j.lastWhat = 'writing its answer';
    return;
  }
  const line = clip(what, 160);
  j.lastWhat = line;
  j.tail.push({ at: j.lastAt, what: line });
  if (j.tail.length > TAIL) j.tail.shift();
  saveJobs();
}

/** The chat's files as path -> "mtime:size", to compare before and after a step. */
export const snapshotFiles = (files) => new Map(Object.entries(files || {}).map(([p, f]) => [p, `${f?.mtime || 0}:${f?.data?.length ?? f?.size ?? 0}`]));
/**
 * What one step changed (decision 181): every file created, changed or deleted between the two snapshots – whatever
 * did it (write_file, Python, the shell). A file another job changed while this one ran, or that changed since this
 * job started without this job touching it (Claude Code itself, the user, a job that has ended), is a conflict.
 * A change another job of the chat already counted as its own since this step began (its shell's files brought in
 * while this step ran) is that job's, not this one's: it is left out when the file is still as that job left it.
 * → the changes, [{ path, kind }]
 */
/** Does a step's text (its command or arguments) name this file? By its path or, as a word, by its name. */
export function mentions(hint, path) {
  const h = String(hint || '');
  if (!h || !path) return false;
  const word = (name) => new RegExp('(^|[^\\w.-])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-]|\\.\\w)').test(h);
  const base = String(path).split('/').pop();
  return word(String(path)) || (base.length >= 2 && word(base));
}

export function noteFileChanges(j, before, after, t = now(), since = 0) {
  const all = [];
  for (const [p, sig] of after) if (!before.has(p)) all.push({ path: p, kind: 'created' });
  else if (before.get(p) !== sig) all.push({ path: p, kind: 'changed' });
  for (const p of before.keys()) if (!after.has(p)) all.push({ path: p, kind: 'deleted' });
  const from = since || j.startedAt;
  const othersOwn = (c) => {
    const o = recent.get(c.path);
    return !!o && o.job !== j.id && o.conv === j.conv && o.at >= from && (c.kind === 'deleted' ? o.sig === null : o.sig === after.get(c.path));
  };
  // other jobs' steps that ran while this one did (in this chat): a file named by one of them and not by this step
  // is theirs – the shell's files all come back together, whoever wrote them
  const mine = steps.findLast((s) => s.job === j.id && !s.to);
  const overlap = steps.filter((s) => s.job !== j.id && s.conv === j.conv && s.from <= t && (!s.to || s.to >= from));
  const unsure = new Set();
  const theirs = (c) => {
    if (!overlap.length) return false;
    if (mentions(mine?.hint, c.path)) return false;
    if (overlap.some((s) => mentions(s.hint, c.path))) return true;
    unsure.add(c.path); // named by nobody (a script's output): kept as this job's, but not blamed on anyone
    return false;
  };
  const out = all.filter((c) => !othersOwn(c) && !theirs(c));
  for (const c of out) {
    const prev = j.changes.get(c.path);
    // created then deleted in this job stays "created and deleted"; created then changed stays "created"
    j.changes.set(c.path, prev === 'created' && c.kind === 'changed' ? 'created' : prev === 'created' && c.kind === 'deleted' ? 'created and deleted' : c.kind);
    const other = recent.get(c.path);
    const sure = !unsure.has(c.path) && !other?.unsure;
    if (other && other.job !== j.id && other.conv === j.conv && other.at >= j.startedAt && sure && !j.conflicts.some((x) => x.path === c.path)) j.conflicts.push({ path: c.path, by: `job ${other.job}` });
    else if (!prev && c.kind !== 'created' && !other) {
      const mt = Number(String(before.get(c.path) || '').split(':')[0]) || 0;
      if (mt > j.startedAt && !j.conflicts.some((x) => x.path === c.path)) j.conflicts.push({ path: c.path, by: 'someone else (Claude Code, the user or an earlier step outside this job)' });
    }
    recent.set(c.path, { job: j.id, at: t, conv: j.conv, sig: after.has(c.path) ? after.get(c.path) : null, ...(unsure.has(c.path) ? { unsure: true } : {}) });
  }
  return out;
}
/**
 * A sync found a file changed on both sides (decision 182): every job of the chat that changed it in the last 10
 * minutes gets a conflict, and its "changed" says the edit may not be the file any more – with the copy that keeps it.
 */
export function noteOverwrites(conv, list, t = now()) {
  for (const o of list || []) {
    for (const j of jobs.values()) {
      if (j.conv !== conv || !j.changes.has(o.path) || (!live(j) && t - (j.endedAt || 0) > 600000)) continue;
      if (o.merged) {
        // both only added at the end: nothing lost, but the file holds more than this job wrote
        if (!/CONFLICT/.test(j.changes.get(o.path))) j.changes.set(o.path, 'changed – merged: text was also added at its end elsewhere at the same time; both additions are in the file');
        saveJobs();
        continue;
      }
      j.changes.set(o.path, `changed – CONFLICT: also changed on the other side at the same time; ${o.kept ? `the other version is kept as ${o.kept}` : 'one version was replaced'}`);
      if (!j.conflicts.some((x) => x.path === o.path)) j.conflicts.push({ path: o.path, by: 'a change made at the same time elsewhere (Claude Code, the user or another job)', kept: o.kept || '' });
      saveJobs();
    }
  }
}

const changeText = (j) => {
  const by = { created: [], changed: [], deleted: [], 'created and deleted': [] };
  const odd = [];
  const merged = [];
  for (const [p, k] of j.changes) (by[k] || (/^changed – merged/.test(k) ? merged : odd)).push(by[k] ? p : `${p} (${k})`);
  if (merged.length) by['changed (merged)'] = merged;
  if (odd.length) by['changed – CONFLICT'] = odd;
  return Object.entries(by)
    .filter(([, l]) => l.length)
    .map(([k, l]) => `${k} ${l.join(', ')}`)
    .join('; ');
};
export const filesSummary = (j) => changeText(j);

export function finishJob(j, text) {
  if (!j || !live(j)) return;
  // cancelled while its last step was ending: it stays cancelled (what it answered is kept)
  const over = j.state === 'cancelling' ? { state: 'cancelled', error: 'cancelled', lastWhat: 'cancelled' } : { state: 'done', lastWhat: 'finished' };
  Object.assign(j, { ...over, result: String(text ?? ''), endedAt: now(), lastAt: now() });
  saveJobs();
}
export function failJob(j, err) {
  if (!j || !live(j)) return;
  if (j.state === 'cancelling' && j.step) return; // its step is still being stopped: that step's end finishes the job
  const cancelled = j.ctrl.signal.aborted;
  Object.assign(j, { state: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'cancelled' : String(err?.message || err), endedAt: now(), lastAt: now(), lastWhat: cancelled ? 'cancelled' : 'failed' });
  saveJobs();
}

/**
 * One tool step of the job (decision 183): while it runs, a cancel has to stop it – a Python run or a shell command
 * would otherwise go on and write files long after "cancelled". → end(changes) for when the step is over.
 */
export function beginStep(j, name, hint = '') {
  let end;
  const done = new Promise((r) => (end = r));
  j.step = { name, done, startedAt: now() };
  const rec = { job: j.id, conv: j.conv, from: now(), to: 0, hint: String(hint || '').slice(0, 20000) };
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].to && now() - steps[i].to > STEP_KEEP_MS) steps.splice(i, 1);
  steps.push(rec);
  return (changes = []) => {
    rec.to = now();
    if (j.step?.done === done) j.step = null;
    end(changes);
    // the step a cancel was waiting for is over: now the job is cancelled for good
    if (j.state === 'cancelling') {
      noteActivity(j, `${name} stopped by the cancel${changes.length ? ` (${changes.length} file change${changes.length === 1 ? '' : 's'} kept)` : ''}`);
      failJob(j, 'cancelled');
    }
  };
}
/** The calls the helper planned that have not started yet (decision 189): listed as waiting; a cancel drops them. */
export function noteQueue(j, list) {
  if (!j || !live(j)) return;
  j.queue = list || [];
}
/** A shell command a step left running as a shell job: a cancel kills it too. */
export const noteShellJob = (j, id) => id && !(j.shellJobs ||= []).includes(id) && j.shellJobs.push(id);

/**
 * Cancel (decision 183): the job's signal stops the helper and kills its running step. With a step still going the
 * job is "cancelling" until that step has ended (and its files are in), then "cancelled". → true when it was running.
 */
export function cancelJob(j) {
  if (!j || j.state !== 'running') return false;
  // what was still waiting its turn is dropped, and said so: it never starts after the cancel
  if (j.queue?.length) (j.dropped = j.queue), (j.queue = []);
  j.ctrl.abort();
  if (j.step) {
    Object.assign(j, { state: 'cancelling', lastAt: now(), lastWhat: `cancelling: stopping its ${j.step.name} step` });
    saveJobs();
  } else failJob(j, 'cancelled');
  return true;
}

const secs = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
};

/** ask_model_status for one job: state, times, activity, tail, files, and the result or error when it is over. */
export function jobStatusText(j, t = now()) {
  const lines = [`${j.id}: ${j.state} – ${j.model || 'helper model'}, tools ${j.tools}${j.background ? ', background' : ''}`];
  lines.push(`task: ${j.task}`);
  lines.push(
    j.state === 'running'
      ? `running for ${secs(t - j.startedAt)}; last activity ${secs(t - j.lastAt)} ago: ${j.lastWhat}`
      : j.state === 'cancelling'
        ? `cancel pending: its ${j.step?.name || ''} step is still running and being stopped (${secs(t - j.lastAt)} so far) – files that step writes may still land; this says "cancelled" once it has ended`
        : `ran ${secs(j.endedAt - j.startedAt)}, ended ${secs(t - j.endedAt)} ago`,
  );
  if (j.chars) lines.push(`about ${Math.round(j.chars / 4)} tokens written so far`);
  if (j.changes.size) lines.push(`files (every step, also Python and the shell): ${changeText(j)}`);
  if (j.conflicts.length) lines.push(`⚠ conflicts – changed by this job and by ${j.conflicts.map((c) => `${c.by} (${c.path}${c.kept ? `; the other version is kept as ${c.kept}` : ''})`).join(', ')} while it ran: check those files`);
  if (j.tail.length) lines.push('recent steps:', ...j.tail.slice(-8).map((x) => `  ${secs(t - x.at)} ago  ${x.what}`));
  if (live(j) && j.queue?.length) lines.push('waiting its turn (planned, not started):', ...j.queue.map((q) => `  ${q.slice(0, 160)}`));
  if (j.dropped?.length) lines.push('not run – dropped by the cancel while waiting its turn (it will not run later):', ...j.dropped.map((q) => `  ${q.slice(0, 160)}`));
  if (j.state === 'done') lines.push('', 'Its answer:', j.result || '(empty)');
  if (j.state === 'failed') lines.push('', `It failed: ${j.error}`);
  if (j.state === 'interrupted') lines.push('', 'The app stopped while it ran (restarted or closed by Android); its steps up to then are above, its files stay as they were left.');
  return lines.join('\n');
}

/** ask_model_status without an id: the chat's jobs, newest first. */
export function jobListText(list, t = now()) {
  if (!list.length) return 'No ask_model jobs in this chat (this app run).';
  return list.map((j) => `${j.id}  ${j.state.padEnd(10)} ${secs((live(j) ? t : j.endedAt) - j.startedAt).padStart(6)}  ${j.model || 'helper'} – ${clip(j.task, 70)}`).join('\n') + '\n\nask_model_status with a job_id shows one in full (its answer when done).';
}

// ---------- kept on the phone (decision 181) ----------
const plain = (j) => ({ shellJobs: j.shellJobs, dropped: j.dropped, id: j.id, seq: j.seq, conv: j.conv, model: j.model, task: j.task, tools: j.tools, background: j.background, state: j.state, startedAt: j.startedAt, lastAt: j.lastAt, lastWhat: j.lastWhat, tail: j.tail, changes: [...j.changes], conflicts: j.conflicts, chars: j.chars, result: j.result, error: j.error, endedAt: j.endedAt, readAt: j.readAt });
let saveTimer = null;
/** Write the jobs out (shortly after a change; a running job is saved too, as "interrupted" if the app stops). */
export function saveJobs({ now: soon = false } = {}) {
  clearTimeout(saveTimer);
  const write = () => {
    try {
      globalThis.localStorage?.setItem(STORE, JSON.stringify([...jobs.values()].map(plain)));
    } catch {
      /* storage full: the jobs still work for this app run */
    }
  };
  if (soon) write();
  else saveTimer = setTimeout(write, 300);
}
/** At start: the jobs of earlier app runs; one that was still running then is "interrupted" now. */
export function loadJobs() {
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(STORE) || '[]');
    for (const p of Array.isArray(list) ? list : []) {
      if (!p?.id || jobs.has(p.id)) continue;
      const ctrl = new AbortController();
      const j = { ...p, changes: new Map(p.changes || []), conflicts: p.conflicts || [], tail: p.tail || [], ctrl, signal: ctrl.signal };
      if (live(j)) Object.assign(j, { state: 'interrupted', endedAt: j.lastAt || j.startedAt, lastWhat: 'interrupted: the app stopped' });
      seq = Math.max(seq, j.seq || 0);
      jobs.set(j.id, j);
    }
  } catch {
    /* nothing kept */
  }
}
/** ask_model_status showed this finished job's answer: its "done" message in the chat would be old news. */
export const markRead = (j) => {
  if (j && !live(j) && !j.readAt) {
    j.readAt = now();
    saveJobs();
  }
};

/** For tests. */
export const _clearJobs = () => {
  jobs.clear();
  recent.clear();
  steps.length = 0;
};
