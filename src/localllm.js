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

/** Same shape as streamChat's handlers: onContent, onDone, onError. Returns { cancel }. */
export function streamLocal({ messages, temperature }, handlers, onProgress) {
  let cancelled = false;
  // keep the prompt short: system + the last turns that fit about 3000 characters... small models choke on long prompts
  const trimmed = [];
  let size = 0;
  for (const m of [...messages].reverse()) {
    const len = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
    if (trimmed.length && size + len > 9000 && m.role !== 'system') break;
    trimmed.unshift({ role: m.role === 'tool' ? 'user' : m.role, content: typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join('\n') });
    size += len;
  }
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
