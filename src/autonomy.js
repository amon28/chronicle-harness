// Letting the assistant work on its own for longer, safely:
//  - a goal: it keeps going past the usual step limit until it says the goal is done (with evidence) or blocked;
//  - a repeat guard: the same call with the same arguments and the same answer, again and again, is stopped;
//  - a Ralph loop: fresh helper agents take turns on one big job, handing over through a progress file;
//  - scheduled tasks: a message the assistant (or you) sends to a chat later, once or every N minutes.
// Pure logic here; engine.js wires it to the chat.
import { parseTrigger, describeTrigger, confirmTrigger, PER_HOUR, MIN_RADIUS } from './triggers.js';

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

// ---------- goal ----------
export const GOAL_STEPS = 200; // most tool steps in one turn while a goal is open
export const GOAL_NUDGES = 3; // times in a row it may stop talking without finishing before the turn really ends

export const goalDefs = () => [
  fn(
    'goal',
    'The goal you are working towards in this chat. While a goal is open you are not stopped after the usual number of tool steps, and you are reminded of it if you stop early. set: start one (for a long job the user wants finished, e.g. "build and test the whole app"). done: it is finished – give the evidence (tests run, files written, what you checked). blocked: you cannot go on without the user – say exactly what you need. status: see it.',
    {
      action: { type: 'string', enum: ['set', 'done', 'blocked', 'status'] },
      text: { type: 'string', description: 'set: the goal, with what "done" means' },
      summary: { type: 'string', description: 'done / blocked: the evidence, or what is needed' },
    },
    ['action'],
  ),
];

export function goalPrompt(goal) {
  if (!goal) return '- For a long job the user wants carried through (many steps, "finish it", "keep going until it works"), call goal with action set: you can then work past the usual step limit. Close it with goal done (with the evidence) or blocked.';
  if (goal.status !== 'active') return '';
  return `## Goal (open)\n${goal.text}\nKeep working until it is really done – do not stop to report progress or ask whether to continue. When it is finished and checked, call goal with action "done" and the evidence. If you cannot go on without the user, call goal with action "blocked" and say exactly what you need. Steps so far: ${goal.steps || 0}.`;
}

export function runGoalTool(args, ctx) {
  const g = ctx.goal;
  if (!g) return { ok: false, result: 'Goals are not available here.', display: { error: 'unavailable' } };
  const cur = g.get();
  const action = String(args.action || 'status');
  if (action === 'set') {
    const text = String(args.text || '').trim();
    if (!text) throw new Error('text is required: the goal, with what "done" means');
    g.set({ text: text.slice(0, 2000), status: 'active', steps: 0, startedAt: Date.now(), by: 'assistant' });
    return { ok: true, result: `Goal set: ${text}\nYou may now work past the usual step limit (up to ${GOAL_STEPS} steps a turn). Close it with goal done or blocked.`, display: { path: text.slice(0, 80) } };
  }
  if (action === 'status') return { ok: true, result: cur ? `Goal (${cur.status}): ${cur.text}\nSteps: ${cur.steps || 0}${cur.summary ? `\n${cur.summary}` : ''}` : 'No goal is set.', display: { path: cur?.status || 'none' } };
  if (action === 'done' || action === 'blocked') {
    if (!cur) return { ok: false, result: 'No goal is set.', display: { error: 'no goal' } };
    const summary = String(args.summary || '').trim();
    if (action === 'done' && summary.length < 10) throw new Error('summary is required: the evidence that the goal is done (what you ran and checked)');
    g.set({ ...cur, status: action, summary: summary.slice(0, 3000), endedAt: Date.now() });
    return { ok: true, result: action === 'done' ? 'Goal closed as done. Now give the user a short final answer.' : 'Goal marked blocked. Tell the user exactly what you need.', display: { path: action } };
  }
  throw new Error('action must be set, done, blocked or status');
}

/** What the assistant is told when it stops talking while the goal is still open. */
export const goalNudge = (goal, n) =>
  `[Goal check ${n}/${GOAL_NUDGES}] Your goal is still open: ${goal.text}\nIf it is finished, check it (run it, test it) and call goal with action "done" and the evidence. If you cannot continue without the user, call goal with action "blocked" and say what you need. Otherwise continue working now – do not ask whether to continue.`;

// ---------- repeat guard ----------
const FREE = new Set(['shell_job', 'todo_write', 'ask_user', 'goal', 'schedule_task']); // waiting on a job, updating a plan: repeating is the point
/**
 * Stops loops: the third identical call (same tool, same arguments) whose result came back the same twice is not run;
 * the assistant is told to change approach. Any call that is identical for the sixth time is stopped too.
 */
export function repeatGuard() {
  const seen = new Map(); // key → { n, results: [] }
  const order = []; // [{ k, r }] the calls of this turn in order (for cycles: A, B, A, B, …)
  const keyOf = (name, args) => {
    let a = args;
    try {
      a = JSON.stringify(JSON.parse(args || '{}'));
    } catch {
      /* keep as is */
    }
    return name + ' ' + a;
  };
  return {
    check(name, args) {
      if (FREE.has(name)) return null;
      const cyc = cycleOf(order, name);
      if (cyc) return `Not run: you are going round in a circle – the same ${cyc.length} calls (${cyc.join(' → ')}) ${CYCLE_REPS} times in a row, with the same results each time – only the details of the calls changed. Repeating them again will not change anything. Change the approach: look at what the results say, try something different, or tell the user what is blocking you.`;
      const s = seen.get(keyOf(name, args));
      if (!s) return null;
      const r = s.results;
      const stuck = r.length >= 2 && r.at(-1) === r.at(-2);
      // a call whose result keeps changing (npm test in a fix loop, scrolling a page) is progress, not a loop
      const changing = r.length >= 2 && r.at(-1) !== r.at(-2);
      if (!stuck && (s.n < 5 || (changing && s.n < 40))) return null;
      return `Not run: you already made this exact ${name} call ${s.n} times in this turn${stuck ? ' and got the same result each time' : ''}. Doing it again will not change anything. Change the approach: different arguments, another tool, read the error, or check your assumptions. If you are stuck, say so (or call goal blocked).`;
    },
    record(name, args, result) {
      if (FREE.has(name)) return;
      const k = keyOf(name, args);
      const s = seen.get(k) || { n: 0, results: [] };
      s.n++;
      s.results.push(String(result ?? '').replace(/\[surface=[^\]]*\]/g, '').replace(/ms=\d+/g, '').slice(0, 4000));
      if (s.results.length > 3) s.results.shift();
      seen.set(k, s);
      order.push({ k: name, r: s.results.at(-1) });
      if (order.length > 40) order.shift();
    },
  };
}

/**
 * Loop detection for calls going round in a circle (decision 201): the last calls plus the next one are the same
 * 2–5 tools repeated CYCLE_REPS times, each with the same result as the time before (no progress) – even when their
 * arguments changed a little (an edit that fails the same way, a file read again in between). The exact same call
 * again is the single-call rule above. → the cycle's tool names, or null.
 */
export const CYCLE_REPS = 3;
export function cycleOf(order, nextKey) {
  for (let len = 2; len <= 5; len++) {
    const n = len * CYCLE_REPS;
    if (order.length + 1 < n) break;
    const win = [...order.slice(-(n - 1)), { k: nextKey, r: null }];
    if (new Set(win.slice(0, len).map((x) => x.k)).size < 2) continue;
    let same = true;
    for (let i = 0; i + len < n && same; i++) {
      if (win[i].k !== win[i + len].k) same = false;
      else if (win[i + len].r != null && win[i].r !== win[i + len].r) same = false; // its result changed: progress
    }
    if (same) return win.slice(0, len).map((x) => x.k);
  }
  return null;
}

/**
 * A model repeating the same words over and over while it writes (decision 201): the reply ENDS with the same passage
 * (up to 400 characters) ten or more times back to back – not a sentence that comes back now and then in a long
 * answer. Not inside a code block, and not a passage that is only spaces, dashes or the like. → the passage, or ''.
 */
const CHANT_REPS = 10;
function chantUnit(t) {
  if (t.length < 300) return '';
  if (((t.match(/```/g) || []).length & 1) === 1) return ''; // inside a code block: code repeats on purpose
  for (let p = 1; p <= 400 && p * CHANT_REPS <= t.length; p++) {
    const unit = t.slice(-p);
    if (t.slice(-p * CHANT_REPS) !== unit.repeat(CHANT_REPS)) continue;
    // too little to be words (a rule of dashes, a row of dots): not this kind of loop
    if ((unit.match(/[\p{L}\p{N}]/gu) || []).length < 3 || unit.length * CHANT_REPS < 200) continue;
    return unit;
  }
  return '';
}
export const chanting = (text) => !!chantUnit(String(text || ''));
/** The reply up to where the repetition began (one copy of it kept). */
export function cutChant(text) {
  const t = String(text || '');
  const unit = chantUnit(t);
  if (!unit) return t;
  let end = t.length;
  while (end - unit.length >= 0 && t.slice(end - unit.length, end) === unit) end -= unit.length;
  return t.slice(0, end + unit.length);
}

// ---------- Ralph loop ----------
export const RALPH_DONE = 'STATUS: DONE';
export const ralphDefs = () => [
  fn(
    'ralph_loop',
    `Work through a big job with a series of fresh helper agents (tools="full": shell, Python, files). Each one starts with a clean context, reads the progress file, does the next piece, and updates the file – so the job can be much longer than one context. It ends when the progress file contains the line "${RALPH_DONE}", or after max_rounds. Use it for long mechanical jobs (convert 200 files, implement a list of features with tests); write a clear task with how to check the work.`,
    {
      task: { type: 'string', description: 'The whole job, with how to check each piece (tests to run, what done means)' },
      progress_file: { type: 'string', description: 'Workspace file the helpers keep up to date (default PROGRESS.md)' },
      max_rounds: { type: 'integer', description: 'Most helpers to run (default 5, at most 20)' },
      steps_per_round: { type: 'integer', description: 'Tool steps each helper may take (default 15, at most 20)' },
    },
    ['task'],
  ),
];

export const ralphPrompt = (task, file, round, max) =>
  `You are helper ${round} of at most ${max} working on one job in turns. You start with no memory: the file ${file} in the workspace is the shared progress log.\n\n## The job\n${task}\n\n## How to work\n1. Read ${file} first (it may not exist yet in round 1 – then create it with a checklist of the job's pieces).\n2. Pick the next unfinished piece and do it properly. Check it (run the tests / the script / look at the output).\n3. Update ${file}: tick what is done (with how it was checked), note problems and what the next helper should do first.\n4. If the whole job is finished and checked, put the line "${RALPH_DONE}" at the top of ${file}.\nWork only on this job, and finish your piece before you run out of steps. Reply with two or three lines: what you did and what is next.`;

const decode = (f) => (f ? new TextDecoder().decode(f.data) : '');

export async function runRalph(args, ctx) {
  const task = String(args.task || '').trim();
  if (!task) throw new Error('task is required');
  if (!ctx.delegate) return { ok: false, result: 'Helper agents are not available here.', display: { error: 'unavailable' } };
  const w = ctx.workspace;
  if (!w) return { ok: false, result: 'Ralph loops need the workspace (turn on files or Python).', display: { error: 'no workspace' } };
  const file = String(args.progress_file || 'PROGRESS.md').replace(/^\/?workspace\//, '').replace(/^\//, '');
  const max = Math.max(1, Math.min(20, Number(args.max_rounds) || 5));
  const steps = Math.max(3, Math.min(20, Number(args.steps_per_round) || 15));
  const log = [];
  let finished = false;
  for (let round = 1; round <= max; round++) {
    if (ctx.signal?.aborted) break;
    if (decode(w.files[file]).includes(RALPH_DONE)) {
      finished = true;
      break;
    }
    ctx.onStatus?.(`Ralph loop · helper ${round}/${max}`);
    const onStep = (s) => ctx.onStatus?.(`Ralph loop · helper ${round}/${max} · step ${s.length}: ${s.at(-1)?.name || ''}`);
    let r;
    try {
      r = await ctx.delegate(ralphPrompt(task, file, round, max), ctx.signal, { mode: 'full', maxSteps: steps, onStep });
    } catch (e) {
      if (e?.name === 'AbortError' || ctx.signal?.aborted) break;
      log.push({ round, text: `failed: ${e?.message || e}`, steps: 0 });
      continue;
    }
    log.push({ round, text: String(r.text || '').trim().slice(0, 600), steps: (r.steps || []).length, limit: !!r.stoppedAtLimit });
    if (decode(w.files[file]).includes(RALPH_DONE)) {
      finished = true;
      break;
    }
  }
  const progress = decode(w.files[file]);
  const result =
    `${finished ? `Done – ${file} says ${RALPH_DONE}` : ctx.signal?.aborted ? 'Stopped' : `Not finished after ${log.length} helper${log.length === 1 ? '' : 's'}`}.\n\n` +
    log.map((l) => `Helper ${l.round} (${l.steps} steps${l.limit ? ', hit its step limit' : ''}): ${l.text}`).join('\n') +
    `\n\n--- ${file} ---\n${progress.slice(0, 5000) || '(missing)'}\n\nCheck the work yourself before telling the user it is done.`;
  return { ok: true, result, display: { path: file, files: w.files[file] ? [file] : [], task: task.slice(0, 300), output: log.map((l) => `#${l.round}: ${l.text.split('\n')[0]}`).join('\n') } };
}

// ---------- scheduled tasks ----------
export const scheduleDefs = (priv = false) => [
  fn(
    'schedule_task',
    'Send a message to this chat later – once, or again every N minutes – so you (the assistant) do something then: check a job, re-run a report, remind the user. On Android the app is woken for it, also while it is in the background; if Android has closed the app, a notification brings the user back and it runs then. action add (default), list (also tells you the current time on the phone and time zone – call it first when the user names a clock time), or cancel.',
    {
      action: { type: 'string', enum: ['add', 'list', 'cancel'] },
      prompt: { type: 'string', description: 'add: the message to send then (written as an instruction to yourself)' },
      in_minutes: { type: 'number', description: 'add: run this many minutes from now' },
      at: { type: 'string', description: 'add: or at this local time, e.g. "2026-11-12 08:00" or "08:00" (the next one)' },
      every_minutes: { type: 'number', description: 'add: repeat every N minutes (at least 5)' },
      times: { type: 'integer', description: 'add: with every_minutes, stop after this many runs' },
      quiet: { type: 'boolean', description: 'add: a check that only speaks when there is something new (a price drop, a page that changed, a build that finished). When the run finds nothing, answer exactly NOTHING_NEW: that run leaves no message in the chat and sends no notification – so it leaves no memory either: keep the last value in a workspace file (e.g. watch/price.txt) and compare with it each run.' },
      id: { type: 'string', description: 'cancel: the task id' },
      ...(priv?.notifications || priv?.places ? { when: triggerDef(priv) } : {}),
    },
  ),
];
/** schedule_task's `when` (an event instead of a time), only while a trigger switch is on. */
const triggerDef = (priv) => ({
  type: 'object',
  description: `add: run when this happens instead of at a time (a quiet check; the user confirms it; at most ${PER_HOUR} runs an hour)`,
  properties: {
    ...(priv.notifications ? { notification: { type: 'object', description: 'a notification from an allowed app arrives', properties: { app: { type: 'string', description: 'app name or package' }, contains: { type: 'string', description: 'only when its title or text contains this' } } } } : {}),
    ...(priv.places ? { place: { type: 'object', description: 'the phone arrives at or leaves a place', properties: { lat: { type: 'number' }, lon: { type: 'number' }, radius_m: { type: 'number', description: `at least ${MIN_RADIUS} (default 200)` }, on: { type: 'string', enum: ['arrive', 'leave'] }, label: { type: 'string', description: 'e.g. Home' } } } } : {}),
  },
});
export const schedulePrompt = () => '- To do something later (check a long job in an hour, a daily report, a reminder), call schedule_task: the prompt comes back to this chat as a message at that time. For a repeated check that should only speak up when something changed ("tell me if the price drops"), add quiet: true.';

/** The answer of a quiet scheduled check that found nothing to report. */
export const QUIET_TOKEN = 'NOTHING_NEW';
export const isNothingNew = (text) => /^\s*\**\s*NOTHING[_ ]NEW\b[\s.*]*$/i.test(String(text || ''));
/**
 * A quiet check the app was closed during (the check takes its message back out only when its run ends): the index
 * of its message when nothing came after it but a reply that never finished, or one that found nothing new; else -1.
 */
export function unfinishedQuietCheck(messages = []) {
  const i = messages.findLastIndex((m) => m.role === 'user');
  const m = messages[i];
  if (!m?.quiet || !m.scheduled) return -1;
  const after = messages.slice(i + 1);
  const last = after.at(-1);
  if (!last) return i;
  if (!after.every((x) => x.role === 'assistant') || last.error) return -1;
  return last.streaming || isNothingNew(last.content) ? i : -1;
}
/** A run of a task, kept on it (the last 10): { at, result }. */
export function recordRun(t, result, at = Date.now()) {
  if (t) t.history = [...(t.history || []), { at, result: String(result).slice(0, 200) }].slice(-10);
}

/** "in_minutes" / "at" → the first run time (ms), or throws. */
export function firstRun(args, now = Date.now()) {
  if (args.in_minutes != null && args.in_minutes !== '') {
    const m = Number(args.in_minutes);
    if (!(m > 0)) throw new Error('in_minutes must be more than 0');
    return now + m * 60000;
  }
  const at = String(args.at || '').trim();
  if (!at) {
    if (Number(args.every_minutes) > 0) return now + Number(args.every_minutes) * 60000;
    throw new Error('give in_minutes, at or every_minutes');
  }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = new Date(at.replace(' ', 'T')).getTime();
  if (!Number.isFinite(t)) throw new Error(`Could not read the time "${at}" – use "YYYY-MM-DD HH:MM" or "HH:MM"`);
  if (t <= now) throw new Error(`${at} is in the past`);
  return t;
}

/** The phone's time and zone: the model only knows the date, and "at 08:00" or "in an hour" need the clock. */
export const nowLine = (now = new Date()) => `Now: ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} (${Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'})`;
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const describeTask = (t) => t.when ? `${t.id}: "${t.prompt.slice(0, 300)}" – ${describeTrigger(t.when)}, quiet${t.history?.length ? `; last run ${when(t.history.at(-1).at)}: ${t.history.at(-1).result}` : ''}` : `${t.id}: "${t.prompt.slice(0, 300)}" – next ${when(t.next)}${t.every ? `, then every ${t.every} min${t.left != null ? ` (${t.left} runs left)` : ''}` : ''}${t.quiet ? ', quiet (only speaks when something is new)' : ''}${t.history?.length ? `; last run ${when(t.history.at(-1).at)}: ${t.history.at(-1).result}` : ''}`;

export function runScheduleTool(args, ctx) {
  const s = ctx.schedules;
  if (!s) return { ok: false, result: 'Scheduling is not available here.', display: { error: 'unavailable' } };
  const action = String(args.action || 'add');
  if (action === 'list') {
    const l = s.list();
    return { ok: true, result: (l.length ? l.map(describeTask).join('\n') : 'Nothing is scheduled in this chat.') + '\n' + nowLine(), display: { path: `${l.length} scheduled` } };
  }
  if (action === 'cancel') {
    const ok = s.remove(String(args.id || ''));
    return { ok, result: ok ? `Cancelled ${args.id}.` : `No scheduled task ${args.id} in this chat – call schedule_task with action list.`, display: { path: String(args.id || '') } };
  }
  if (action !== 'add') throw new Error('action must be add, list or cancel');
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');
  if (args.when != null && args.when !== '') return addTrigger(args, prompt, ctx);
  const every = args.every_minutes != null && args.every_minutes !== '' ? Math.max(5, Number(args.every_minutes) || 0) : 0;
  if (s.list().length >= 20) throw new Error('This chat already has 20 scheduled tasks – cancel some first.');
  const t = { id: 'st_' + Math.random().toString(36).slice(2, 8), prompt: prompt.slice(0, 4000), next: firstRun(args), every: every || undefined, left: every && Number(args.times) > 0 ? Math.floor(Number(args.times)) : undefined, quiet: args.quiet === true || undefined, created: Date.now() };
  s.add(t);
  const clamped = args.every_minutes != null && args.every_minutes !== '' && Number(args.every_minutes) < 5 ? ' (every_minutes was raised to 5, the shortest allowed)' : '';
  return { ok: true, result: `Scheduled ${describeTask(t)}.${clamped} ${nowLine()}. The app is woken for it (if Android closed the app, a notification asks the user to open it).`, display: { path: when(t.next) } };
}

/** A task that runs on an event (src/triggers.js): asked first, every time; never set up where nobody can say yes. */
async function addTrigger(args, prompt, ctx) {
  const s = ctx.schedules;
  if (!ctx.ask || ctx.unattended) throw new Error('A trigger can only be set up while the user is at the phone to confirm it.');
  const w = parseTrigger(args.when, ctx);
  if (s.list().length >= 20) throw new Error('This chat already has 20 scheduled tasks – cancel some first.');
  ctx.onStatus?.('waiting for your OK…');
  const yes = 'Set it up';
  const ans = await ctx.ask(confirmTrigger(w, prompt), [yes, 'Not now'], ctx.signal);
  if (ans !== yes) return { ok: false, result: `The user said no (${ans}).`, display: { error: 'declined', path: 'trigger' } };
  const t = { id: 'st_' + Math.random().toString(36).slice(2, 8), prompt: prompt.slice(0, 4000), when: w, quiet: true, created: Date.now() };
  s.add(t);
  return { ok: true, result: `Set up ${describeTask(t)}. It runs as a quiet check each time (at most ${PER_HOUR} an hour)${w.place ? '. Android needs location "Allow all the time" for it; if that is not allowed yet, Settings › Tools › 🔒 Sensitive phone access shows how' : ''}.`, display: { path: describeTrigger(w) } };
}

/** The tasks due now, and the list after running them (repeating ones move on; finished ones go). A trigger task is due
 * when an event is waiting on it (task.pending): it runs with the first one (as task.event) and stays. */
export function takeDue(tasks, now = Date.now()) {
  const due = [];
  const keep = [];
  for (const t of tasks) {
    if (t.when) {
      if (t.pending?.length) {
        due.push({ ...t, event: t.pending[0] });
        keep.push({ ...t, pending: t.pending.slice(1) });
      } else keep.push(t);
      continue;
    }
    if (t.next > now) {
      keep.push(t);
      continue;
    }
    due.push(t);
    if (t.every && (t.left == null || t.left > 1)) {
      let next = t.next + t.every * 60000;
      if (next <= now) next = now + t.every * 60000; // missed several while closed: run once, then carry on from now
      keep.push({ ...t, next, left: t.left == null ? undefined : t.left - 1 });
    }
  }
  return { due, keep };
}
