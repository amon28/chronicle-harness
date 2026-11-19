// "Smart memory": rank memories by meaning with EmbeddingGemma running on the phone (transformers.js + ONNX/WASM).
// Optional – without it the app ranks by shared words. The model (~200 MB) downloads once and is cached by the browser.
// The model itself runs in a Web Worker (embed.worker.js): on a phone one embedding takes seconds of CPU, which
// on the main thread froze the whole app.
let worker = null;
let seq = 0;
const waiting = new Map();
function call(type, payload = {}, onProgress) {
  worker ||= (() => {
    const w = new Worker(new URL('./embed.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const { id, progress, ok, vecs, error } = e.data;
      const p = waiting.get(id);
      if (!p) return;
      if (progress != null) return p.onProgress?.(progress);
      waiting.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(ok && vecs ? vecs : true);
    };
    w.onerror = (e) => {
      for (const p of waiting.values()) p.reject(new Error(e.message || 'The memory model stopped'));
      waiting.clear();
      worker = null;
      loading = null;
      ready = false;
    };
    return w;
  })();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, ...payload });
  });
}

let loading = null;
let ready = false;
/** Tests can install globalThis.__ocmEmbedder = async (texts, kind) => number[][] */
export const hasTestEmbedder = () => !!globalThis.__ocmEmbedder;
export const embedderReady = () => ready || hasTestEmbedder();

export function loadEmbedder(onProgress) {
  if (globalThis.__ocmEmbedder) return Promise.resolve(globalThis.__ocmEmbedder);
  loading ||= call('load', {}, onProgress)
    .then(() => {
      ready = true;
      return (texts, kind = 'document') => call('embed', { texts, kind });
    })
    .catch((e) => {
      loading = null;
      throw e;
    });
  return loading;
}

const norm = (v) => {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
};
/** Int8 + base64: ~340 characters per memory instead of a 256-number array. */
export function encodeVec(v) {
  const bytes = Int8Array.from(norm(v), (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));
  let s = '';
  for (const b of new Uint8Array(bytes.buffer)) s += String.fromCharCode(b);
  return btoa(s);
}
export function decodeVec(s) {
  const bin = atob(s);
  const v = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) v[i] = ((bin.charCodeAt(i) << 24) >> 24) / 127;
  return norm(v);
}
export const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
};

/** Give every fact that lacks a vector one. Returns how many were added. */
export async function ensureVectors(memories, embed) {
  const todo = memories.filter((m) => m.kind !== 'event' && m.text && !m.vec);
  for (let i = 0; i < todo.length; i += 16) {
    const chunk = todo.slice(i, i + 16);
    const vs = await embed(chunk.map((m) => m.text), 'document');
    chunk.forEach((m, j) => (m.vec = encodeVec(vs[j])));
  }
  return todo.length;
}

/** Similarity of each fact to the conversation: Map(id → cosine). */
export async function similarities(facts, query, embed) {
  const [q] = await embed([query.slice(0, 2000)], 'query');
  const qv = norm(q);
  const map = new Map();
  for (const m of facts) if (m.vec) map.set(m.id, cosine(qv, decodeVec(m.vec)));
  return map;
}
