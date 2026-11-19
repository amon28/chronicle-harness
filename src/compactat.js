// When auto-compact runs: a share of the model's context (0.8 = 80 %) or a fixed number of tokens (64000),
// set once for every model and optionally per model (like Claude Code's auto-compact threshold).

export const COMPACT_CHOICES = [
  ['0.5', '50 % of the model’s context'],
  ['0.6', '60 %'],
  ['0.7', '70 %'],
  ['0.8', '80 % (default)'],
  ['0.9', '90 %'],
  ['32000', '32K tokens'],
  ['64000', '64K tokens'],
  ['100000', '100K tokens'],
  ['128000', '128K tokens'],
  ['200000', '200K tokens'],
  ['400000', '400K tokens'],
];

/** The setting for a model: its own, else the default. */
export const compactSettingFor = (settings, modelId, fallback = 0.8) => {
  const own = settings?.compactAtModel?.[modelId];
  return own != null && own !== '' ? Number(own) : Number(settings?.prefs?.compactAt ?? fallback) || fallback;
};

/** Tokens at which to compact, or Infinity when it can't be worked out. A fixed number never exceeds 95 % of the model. */
export function compactThreshold(value, max) {
  const v = Number(value);
  if (!(v > 0)) return Infinity;
  if (v <= 1) return max ? Math.floor(max * v) : Infinity;
  return max ? Math.min(v, Math.floor(max * 0.95)) : v;
}

/** The label of a setting for the UI. */
export const compactLabel = (v) => COMPACT_CHOICES.find(([k]) => Number(k) === Number(v))?.[1].replace(' (default)', '') || (Number(v) > 1 ? `${Math.round(Number(v) / 1000)}K tokens` : `${Math.round(Number(v) * 100)} %`);
