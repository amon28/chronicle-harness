// Model list helpers: free/contributor detection, "new" tracking and
// replacements for models OpenCode removed or renamed.

export const isFree = (m) => {
  const c = m?.cost?.text;
  // OpenRouter-style ids end in ":free" (deepseek/deepseek-r1:free), OpenCode's in "-free" (decision 275)
  return (c?.input?.price === 0 && (c?.output?.price ?? 0) === 0) || /(^|[-:])free$/.test(m?.id || '');
};

/**
 * Is there any model to chat with (decision 275)? An OpenCode Go key, or – without one – a model from somewhere else
 * in the list (a custom endpoint, Zen's free models, the on-device model: they carry a source; OpenCode Go's do not,
 * and a cached list can still hold them from before the key was removed), or Claude Code set up (ccModels).
 */
export function hasUsableModel(settings = {}, models = [], ccModels = []) {
  if (settings.apiKey) return true;
  if ((models || []).some((m) => m?.source && m.source !== 'claudecode')) return true;
  return (ccModels || []).length > 0;
}

/** "Contributor" models need "Allow paid endpoints that train on request data" in the OpenCode Console. */
export const isContributor = (m) => /contributor/i.test(m?.id || '');

const inPrice = (m) => m?.cost?.text?.input?.price ?? Infinity;

/** Numeric parts of a version-ish id, for "newest first" sorting: glm-5.3-flash → [5,3]. */
const version = (id) => (id.match(/\d+(\.\d+)*/g) || []).join('.').split('.').map(Number);
const cmpVersionDesc = (a, b) => {
  const va = version(a.id);
  const vb = version(b.id);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] || 0) - (va[i] || 0);
    if (d) return d;
  }
  return 0;
};

const base = (id) => id.replace(/[-.]?\d+(\.\d+)*/g, '').replace(/-+/g, '-').replace(/-(free|contributor)$/, '');

/**
 * Best replacement for a model id that's no longer offered:
 * same family → same name stem (e.g. glm-5.2 → glm-5.3) → defaults → first model.
 */
export function replacementFor(oldId, oldModel, models, defaults) {
  const usable = models.filter((m) => !isContributor(m) && m.source !== 'zen');
  const pool = usable.length ? usable : models;
  if (oldModel?.family) {
    const fam = pool.filter((m) => m.family === oldModel.family).sort(cmpVersionDesc);
    if (fam.length) return fam[0];
  }
  const stem = pool.filter((m) => base(m.id) === base(oldId)).sort(cmpVersionDesc);
  if (stem.length) return stem[0];
  for (const id of defaults) {
    const m = pool.find((x) => x.id === id);
    if (m) return m;
  }
  return pool[0];
}

/**
 * Candidates for background memory learning, best first:
 * newest DeepSeek Flash → newest GLM Flash → other cheap "flash" models (never contributor models,
 * which may train on your data).
 */
export function learnModelRanking(models) {
  const ok = models.filter((m) => !isContributor(m) && !supportsOnlyMedia(m) && m.source !== 'zen');
  const flash = ok.filter((m) => /flash/i.test(m.id));
  const pick = (re) => flash.filter((m) => re.test(m.id)).sort(cmpVersionDesc);
  const others = flash.filter((m) => !/deepseek|glm/i.test(m.id)).sort((a, b) => inPrice(a) - inPrice(b));
  return [...pick(/deepseek/i), ...pick(/glm/i), ...others].map((m) => m.id);
}
const supportsOnlyMedia = (m) => m?.modalities?.input && !m.modalities.input.includes('text');

/** Track which ids are new since the last refresh. Returns the updated record. */
export function trackNewModels(models, record) {
  const now = Date.now();
  const WEEK = 7 * 864e5;
  const rec = record && Array.isArray(record.seen) ? { seen: record.seen, fresh: record.fresh || {} } : null;
  if (!rec) return { seen: models.map((m) => m.id), fresh: {} }; // first run: nothing is "new"
  for (const m of models) {
    if (!rec.seen.includes(m.id)) {
      rec.seen.push(m.id);
      rec.fresh[m.id] = now;
    }
  }
  for (const [id, t] of Object.entries(rec.fresh)) if (now - t > WEEK) delete rec.fresh[id];
  return rec;
}

/**
 * Where a model runs and who pays for it (decision 215): the user's own Anthropic API key (billed per token to that
 * key – not their Claude subscription), another provider key of theirs, OpenCode, this phone, or Claude Code (the
 * subscription). For list_models and delegate, so a model can tell an API-key Claude from the subscription one.
 */
export function modelVia(m) {
  if (!m) return '';
  if (m.source === 'claudecode' || String(m.id || '').startsWith('cc:')) return 'Claude Code – the Claude subscription';
  if (m.source === 'local') return 'on this phone – free';
  if (m.anthropic) return `Anthropic API key "${m.providerName || m.providerId || '?'}" – billed per token to that key, not the Claude subscription`;
  if (m.source === 'custom') return `the user's own key at "${m.providerName || m.providerId || '?'}"`;
  return 'OpenCode (Zen / Go)';
}
