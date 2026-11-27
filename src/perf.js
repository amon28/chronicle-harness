// "🩺 Timings": an optional trace of what happens after you press send, measured on the phone itself.
// Marks are cheap no-ops unless a trace is running.
let trace = null;
// the trace's own timers are not tracked (a 20 ms heartbeat would be matched to every slow frame)
const raw = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval };

export function perfStart(label = 'send', { ms = 6000, extra = null } = {}) {
  perfEnd();
  const t0 = performance.now();
  trace = { label, t0, marks: [], stalls: [], longTasks: [], frames: [], keys: [], extra };
  // event-loop stalls: a 20 ms heartbeat that notices when it was held up (works even without the long-task API)
  let last = performance.now();
  trace.beat = raw.setInterval.call(globalThis, () => {
    const now = performance.now();
    if (now - last > 80) trace?.stalls.push([Math.round(last - t0), Math.round(now - last - 20)]);
    last = now;
  }, 20);
  try {
    trace.obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => trace?.longTasks.push([Math.round(e.startTime - t0), Math.round(e.duration)])));
    trace.obs.observe({ type: 'longtask', buffered: false });
  } catch {
    /* not supported */
  }
  // long animation frames (decision 242): which code held a frame up – what started it (a timer, an event, a message
  // from a worker), its function and place in the file, and how long it took, layout it forced included
  try {
    trace.loaf = new PerformanceObserver((l) =>
      l.getEntries().forEach((e) =>
        trace?.frames.push({
          at: Math.round(e.startTime - t0),
          dur: Math.round(e.duration),
          block: Math.round(e.blockingDuration || 0),
          render: e.renderStart ? Math.round(e.startTime + e.duration - e.renderStart) : 0,
          layout: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : 0,
          scripts: [...(e.scripts || [])]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 4)
            .map((x) => ({ inv: String(x.invoker || x.invokerType || '').slice(0, 60), fn: x.sourceFunctionName || '', src: `${String(x.sourceURL || '').split('/').pop()}:${x.sourceCharPosition ?? ''}`, dur: Math.round(x.duration), forced: Math.round(x.forcedStyleAndLayoutDuration || 0), from: siteFor(x) })),
        }),
      ),
    );
    trace.loaf.observe({ type: 'long-animation-frame', buffered: false });
  } catch {
    /* not supported (older WebView) */
  }
  // how long each key or tap waited before the app got to it, and until the screen showed it
  try {
    trace.ev = new PerformanceObserver((l) => l.getEntries().forEach((e) => trace?.keys.push({ n: e.name, wait: Math.round(e.processingStart - e.startTime), shown: Math.round(e.duration) })));
    trace.ev.observe({ type: 'event', durationThreshold: 16, buffered: false });
  } catch {
    /* not supported */
  }
  trace.timer = raw.setTimeout.call(globalThis, () => perfEnd(), ms);
}
export const perfRunning = () => !!trace;

/** name: the step's label, or a function that makes it – called only while a trace runs (a costly label, decision 258). */
export function perfMark(name) {
  if (trace) trace.marks.push([typeof name === 'function' ? name() : name, Math.round(performance.now() - trace.t0)]);
}

/** Stop and hand the report to whoever asked for it. */
let onReport = null;
export const onPerfReport = (fn) => (onReport = fn);
/** A report made elsewhere (a Claude Code reply's steps, decision 251), into the same history. */
export const perfReport = (text, meta) => onReport?.(text, meta);
export function perfEnd() {
  if (!trace) return;
  const t = trace;
  trace = null;
  clearInterval(t.beat);
  clearTimeout(t.timer);
  t.obs?.disconnect();
  t.loaf?.disconnect();
  t.ev?.disconnect();
  const text = formatPerf(t);
  const meta = perfSummary(t);
  // something more to say, looked up once the trace is over (which programs in Linux were using the CPU)
  if (t.extra) Promise.resolve().then(t.extra).then((x) => onReport?.(x ? `${text}\n${x}` : text, meta), () => onReport?.(text, meta));
  else onReport?.(text, meta);
}

/** One line for the history (decision 245): the worst wait, the longest freeze, and whose code it was. */
export function perfSummary(t) {
  const keys = (t.keys || []).filter((k) => KEYISH.includes(k.n));
  const worstKey = keys.reduce((m, k) => Math.max(m, k.shown), 0);
  const worstFreeze = Math.max(0, ...(t.frames || []).map((f) => f.dur), ...(t.stalls || []).map(([, d]) => d), ...(t.longTasks || []).map(([, d]) => d));
  const appMs = (t.frames || []).reduce((n, f) => n + f.scripts.reduce((m, x) => m + x.dur, 0), 0);
  const slow = worstKey >= 100 || worstFreeze >= 100;
  const parts = [];
  if (worstKey >= 100) parts.push(`a key or tap waited ${fmtMs(worstKey)}`);
  if (worstFreeze >= 100) parts.push(`longest freeze ${fmtMs(worstFreeze)}`);
  if (slow) parts.push(appMs >= 300 ? "the app's own code" : 'not the app\'s code');
  const send = t.marks?.findLast?.(([n]) => /on screen/.test(n)) || t.marks?.find(([n]) => /on screen/.test(n));
  return { label: t.label, slow, worstKey, worstFreeze, line: parts.length ? parts.join(' · ') : send ? `no freezes · on screen after ${fmtMs(send[1])}` : 'no freezes' };
}
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const KEYISH = ['keydown', 'input', 'beforeinput', 'pointerdown', 'click', 'compositionupdate'];

export function formatPerf(t) {
  const lines = [`${t.label}:`];
  for (const [n, ms] of t.marks) lines.push(`  ${String(ms).padStart(5)} ms  ${n}`);
  const stalls = t.stalls.filter(([, d]) => d >= 60);
  const frames = (t.frames || []).filter((f) => f.dur >= 100).sort((a, b) => b.dur - a.dur).slice(0, 8);
  // the frame list below says the same with the code that ran: the plain lists only when it is not there (older WebView)
  if (stalls.length && !frames.length) lines.push('frozen (main thread busy):', ...stalls.slice(0, 12).map(([at, d]) => `  at ${at} ms for ${d} ms`));
  if (t.longTasks.length && !frames.length) lines.push('long tasks:', ...t.longTasks.slice(0, 12).map(([at, d]) => `  at ${at} ms, ${d} ms`));
  const keys = (t.keys || []).filter((k) => KEYISH.includes(k.n));
  if (keys.length) {
    const worst = [...keys].sort((a, b) => b.shown - a.shown).slice(0, 5);
    lines.push(`keys/taps slower than a frame: ${keys.length}; worst: ${worst.map((k) => `${k.n} waited ${k.wait} ms, on screen after ${k.shown} ms`).join(' · ')}`);
  }
  if (frames.length) {
    lines.push('slow frames (what ran):');
    for (const f of frames) {
      lines.push(`  at ${f.at} ms: ${f.dur} ms (blocking ${f.block}, drawing ${f.render}, style+layout ${f.layout})`);
      for (const x of f.scripts) {
        lines.push(`    ${x.dur} ms ${x.inv}${x.fn ? ` → ${x.fn}` : ''} @${x.src}${x.forced ? ` (forced layout ${x.forced} ms)` : ''}`);
        if (x.from) lines.push(`      started from: ${x.from}`);
      }
    }
  }
  if (!stalls.length && !t.longTasks.length && !frames.length) lines.push('no freezes over 60 ms');
  // whose fault: the app's own code, or something it does not run (drawing, another program using the CPU)
  const appMs = (t.frames || []).reduce((n, f) => n + f.scripts.reduce((m, x) => m + x.dur, 0), 0);
  const slowKeys = keys.filter((k) => k.shown >= 100).length;
  if (slowKeys || stalls.length || frames.length)
    lines.push(appMs >= 300 ? `→ mostly the app's own code (${appMs} ms in the slow frames above)` : `→ the app's own code ran fast (${appMs} ms in slow frames): the time went elsewhere – drawing the screen, or another program using the phone's CPU`);
  return lines.join('\n');
}

// ---------- where a timer or a database read was started from (decision 247) ----------
// A long frame from a timer says only "TimerHandler:setTimeout" when the code waited on a timer first (await sleep): no
// file, no function. While 🩺 is on, each timer and database request notes the code that started it, and a slow frame
// is matched to it by the time its callback began.
let tracking = false;
let installed = false;
const notes = []; // { t, kind, site }
const clean = (l) => l.trim().replace(/^at /, '').replace(/\(?(?:https?|capacitor|file):\/\/[^/]+\/(?:assets\/)?/, '').replace(/\)$/, '');
/** The code that called (a few frames up the stack), or '' when not tracking. */
export function callSite(skip = 3) {
  if (!tracking) return '';
  const st = String(new Error().stack || '').split('\n').slice(skip, skip + 4).map(clean).filter((l) => l && !/perf[-\w]*\.js|^Promise|^new Promise/.test(l));
  return st.slice(0, 3).join(' ← ');
}
/** A callback started that a slow frame may be (kind: 'timer' | 'database'). */
export function noteSite(kind, site) {
  if (!tracking || !site) return;
  const t = performance.now();
  notes.push({ t, kind, site });
  while (notes.length && t - notes[0].t > 20000) notes.shift();
  if (notes.length > 2000) notes.splice(0, 1000);
}
function siteFor(x) {
  const kind = /^TimerHandler/.test(x.invoker || '') ? 'timer' : /^IDB/.test(x.invoker || '') ? 'database' : '';
  if (!kind || !notes.length) return '';
  let best = null;
  for (const n of notes) if (n.kind === kind && Math.abs(n.t - x.startTime) < 8 && (!best || Math.abs(n.t - x.startTime) < Math.abs(best.t - x.startTime))) best = n;
  return best?.site || '';
}
/** Turn the tracking on or off (it follows the 🩺 setting). The timers are wrapped once, then only note while on. */
export function trackSites(on) {
  tracking = !!on;
  if (!tracking || installed || typeof globalThis.setTimeout !== 'function') return;
  installed = true;
  for (const name of ['setTimeout', 'setInterval']) {
    const orig = globalThis[name];
    globalThis[name] = function (fn, ms, ...a) {
      if (!tracking || typeof fn !== 'function') return orig.call(this, fn, ms, ...a);
      const at = callSite(3);
      const site = `${fn.name ? fn.name + '(), ' : ''}${name} set at ${at || '?'}`;
      return orig.call(
        this,
        function (...b) {
          noteSite('timer', site);
          return fn.apply(this, b);
        },
        ms,
        ...a,
      );
    };
  }
}
