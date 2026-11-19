// Smart memory's embedding model runs here, off the main thread, so the app never freezes while it works.
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/+esm';
const MODEL = 'onnx-community/embeddinggemma-300m-ONNX';
const DIMS = 256;
const PREFIX = { query: 'task: search result | query: ', document: 'title: none | text: ' };
let ready = null;

function load(report) {
  ready ||= (async () => {
    const { AutoModel, AutoTokenizer, env } = await import(/* @vite-ignore */ LIB);
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
    const tok = await AutoTokenizer.from_pretrained(MODEL, { progress_callback });
    const model = await AutoModel.from_pretrained(MODEL, { dtype: 'q4', progress_callback });
    return { tok, model };
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

async function embed(texts, kind) {
  const { tok, model } = await load(() => {});
  const out = [];
  for (let i = 0; i < texts.length; i += 8) {
    const batch = texts.slice(i, i + 8).map((t) => PREFIX[kind] + t);
    const { sentence_embedding } = await model(await tok(batch, { padding: true, truncation: true, max_length: 512 }));
    const n = sentence_embedding.dims[1];
    for (let r = 0; r < batch.length; r++) out.push(Array.from(sentence_embedding.data.slice(r * n, r * n + DIMS)));
  }
  return out;
}

self.onmessage = async (e) => {
  const { id, type, texts, kind } = e.data;
  try {
    if (type === 'load') {
      await load((progress) => self.postMessage({ id, progress }));
      self.postMessage({ id, ok: true });
    } else if (type === 'embed') self.postMessage({ id, ok: true, vecs: await embed(texts, kind || 'document') });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
