// Offline mode: a small chat model that runs on the phone (see local.worker.js). It shows up in the model list as
// "On-device" once switched on in Settings. Slow and small – good for short questions, rewriting and titles, not for tools.
export const LOCAL_PREFIX = 'local:';
export const LOCAL_ID = 'local:qwen2.5-0.5b';
export const isLocalModel = (id) => String(id || '').startsWith(LOCAL_PREFIX);

export const localModels = (enabled) =>
  enabled
    ? [
        {
          id: LOCAL_ID,
          name: 'On-device Qwen2.5 0.5B (offline)',
          source: 'local',
          description: 'Runs on this phone, works without internet after a one-time ~400 MB download. Small and slow – no tools, short context.',
          limit: { context: 4096, output: 512 },
          capabilities: { tools: { supported: false }, reasoning: { supported: false } },
          modalities: { input: ['text'] },
          type: 'chat',
        },
      ]
    : [];

let worker = null;
let seq = 0;
const waiting = new Map();
function call(msg, handlers) {
  worker ||= (() => {
    const w = new Worker(new URL('./local.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const { id, token, progress, error } = e.data;
      const h = waiting.get(id);
      if (!h) return;
      if (token != null) return h.onToken?.(token);
      if (progress != null) return h.onProgress?.(progress);
      waiting.delete(id);
      if (error) h.reject(new Error(error));
      else h.resolve();
    };
    w.onerror = (e) => {
      for (const h of waiting.values()) h.reject(new Error(e.message || 'The on-device model stopped'));
      waiting.clear();
      worker = null;
    };
    return w;
  })();
  const id = ++seq;
  return {
    id,
    promise: new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, ...handlers });
      worker.postMessage({ id, ...msg });
    }),
  };
}

const LOCAL_BUDGET = 9000;
const flat = (m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join('\n') });

/**
 * What the on-device model gets: small models choke on long prompts, so about 9,000 characters. The system message
 * (messages[0]) is always kept – cut to the budget if it alone is longer – and the rest is filled from the newest
 * turns back; the kept history never starts on an assistant turn. It used to walk newest-first and stop at the
 * budget before reaching the system message, so a long chat lost its persona and instructions (decision 275).
 */
export function trimLocalMessages(messages) {
  const all = (messages || []).map(flat);
  const sys = all[0]?.role === 'system' ? { ...all[0] } : null;
  if (sys && sys.content.length > LOCAL_BUDGET) sys.content = sys.content.slice(0, LOCAL_BUDGET);
  const rest = sys ? all.slice(1) : all;
  let size = sys ? sys.content.length : 0;
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const len = rest[i].content.length;
    if (kept.length && size + len > LOCAL_BUDGET) break;
    kept.unshift(rest[i]);
    size += len;
  }
  while (kept.length > 1 && kept[0].role === 'assistant') kept.shift();
  return sys ? [sys, ...kept] : kept;
}

/** Same shape as streamChat's handlers: onContent, onDone, onError. Returns { cancel }. */
export function streamLocal({ messages, temperature }, handlers, onProgress) {
  let cancelled = false;
  const trimmed = trimLocalMessages(messages);
  if (globalThis.__ocmLocalLLM) {
    Promise.resolve(globalThis.__ocmLocalLLM(trimmed, (t) => !cancelled && handlers.onContent?.(t)))
      .then(() => !cancelled && handlers.onDone?.('stop', {}))
      .catch((e) => handlers.onError?.(e));
    return { cancel: () => (cancelled = true) };
  }
  const { id, promise } = call({ type: 'generate', messages: trimmed, temperature }, { onToken: (t) => !cancelled && handlers.onContent?.(t), onProgress });
  promise.then(() => !cancelled && handlers.onDone?.('stop', {})).catch((e) => !cancelled && handlers.onError?.(e));
  return {
    cancel: () => {
      cancelled = true;
      worker?.postMessage({ id, type: 'stop' });
    },
  };
}

/** Download the model now (Settings). onProgress gets 0–100. */
export function preloadLocal(onProgress) {
  if (globalThis.__ocmLocalLLM) return Promise.resolve();
  return call({ type: 'load' }, { onProgress }).promise;
}
