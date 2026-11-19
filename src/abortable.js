/** Stop must work even when a tool is stuck: race it against the abort signal and (for tools that can hang) a time limit. */
export function abortable(p, signal, ms, cleanup) {
  return new Promise((resolve, reject) => {
    let t = null;
    const fail = (e) => {
      clearTimeout(t);
      try { cleanup?.(); } catch { /* best effort */ }
      reject(e);
    };
    if (ms) t = setTimeout(() => fail(new Error(`The tool did not finish within ${Math.round(ms / 1000)} s and was stopped.`)), ms);
    if (signal.aborted) return fail(new Error('Stopped'));
    const onAbort = () => fail(new Error('Stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort); // no listener left behind on a signal that lives a whole reply
    };
    p.then((v) => { settle(); resolve(v); }, (e) => { settle(); reject(e); });
  });
}
