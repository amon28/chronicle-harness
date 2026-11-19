// The on-device chat model runs here, off the main thread (transformers.js + ONNX in WASM). Experimental: a small
// model (Qwen2.5 0.5B) that works offline once downloaded.
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/+esm';
const MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';
let lib = null;
let ready = null;
let stopper = null;

function load(report) {
  ready ||= (async () => {
    lib = await import(/* @vite-ignore */ LIB);
    const { pipeline, env } = lib;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    const files = new Map();
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, [p.loaded, p.total]);
        let l = 0;
        let t = 0;
        for (const [a, b] of files.values()) (l += a), (t += b);
        report(Math.min(99, Math.round((l / t) * 100)));
      }
    };
    return pipeline('text-generation', MODEL, { dtype: 'q4', progress_callback });
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

self.onmessage = async (e) => {
  const { id, type, messages, maxTokens, temperature } = e.data;
  try {
    if (type === 'stop') return stopper?.interrupt();
    const gen = await load((progress) => self.postMessage({ id, progress }));
    if (type === 'load') return self.postMessage({ id, done: true });
    const { TextStreamer, InterruptableStoppingCriteria } = lib;
    stopper = new InterruptableStoppingCriteria();
    const streamer = new TextStreamer(gen.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: (token) => self.postMessage({ id, token }) });
    await gen(messages, { max_new_tokens: maxTokens || 512, do_sample: (temperature ?? 0.7) > 0, temperature: temperature || 0.7, streamer, stopping_criteria: stopper });
    self.postMessage({ id, done: true });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
