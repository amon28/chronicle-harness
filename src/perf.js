// "🩺 Timings": an optional trace of what happens after you press send, measured on the phone itself.
// Marks are cheap no-ops unless a trace is running.
let trace = null;

export function perfStart(label = 'send') {
  perfEnd();
  const t0 = performance.now();
  trace = { label, t0, marks: [], stalls: [], longTasks: [] };
  // event-loop stalls: a 20 ms heartbeat that notices when it was held up (works even without the long-task API)
  let last = performance.now();
  trace.beat = setInterval(() => {
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
  trace.timer = setTimeout(() => perfEnd(), 6000);
}

export function perfMark(name) {
  if (trace) trace.marks.push([name, Math.round(performance.now() - trace.t0)]);
}

/** Stop and hand the report to whoever asked for it. */
let onReport = null;
export const onPerfReport = (fn) => (onReport = fn);
export function perfEnd() {
  if (!trace) return;
  const t = trace;
  trace = null;
  clearInterval(t.beat);
  clearTimeout(t.timer);
  t.obs?.disconnect();
  onReport?.(formatPerf(t));
}

export function formatPerf(t) {
  const lines = [`${t.label}:`];
  for (const [n, ms] of t.marks) lines.push(`  ${String(ms).padStart(5)} ms  ${n}`);
  const stalls = t.stalls.filter(([, d]) => d >= 60);
  if (stalls.length) lines.push('frozen (main thread busy):', ...stalls.map(([at, d]) => `  at ${at} ms for ${d} ms`));
  if (t.longTasks.length) lines.push('long tasks:', ...t.longTasks.map(([at, d]) => `  at ${at} ms, ${d} ms`));
  if (!stalls.length && !t.longTasks.length) lines.push('no freezes over 60 ms');
  return lines.join('\n');
}
