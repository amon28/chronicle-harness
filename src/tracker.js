// 📊 Scene tracker: a small "Field: value" sheet (time, place, clothes, mood…) kept up to date after each roleplay reply
// and sent with every message, so the model stops forgetting what someone wears or where they are.
// Its values are also chat variables: {{getvar::Location}} works in any prompt.

export const DEFAULT_TRACKER_FIELDS = 'Time & date, Location, Weather, What each character wears, Mood of each character, Notable items, Current goal';

export const fieldList = (s) =>
  String(s || DEFAULT_TRACKER_FIELDS)
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 20);

/** "Field: value" lines → [[field, value]] (other lines ignored; ** and - bullets tolerated). */
export function parseTracker(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^\s*[-*•]\s*/, '').replace(/\*\*/g, '').trim();
    const m = /^([^:]{1,60}):\s*(.*)$/.exec(line);
    if (m && m[2] !== undefined) out.push([m[1].trim(), m[2].trim()]);
  }
  return out;
}

/** The sheet as the model's answer → a clean sheet, only the known fields when the answer had them, in order. */
export function cleanTracker(answer, fields) {
  const got = parseTracker(answer);
  if (!got.length) return '';
  const byName = new Map(got.map(([k, v]) => [k.toLowerCase(), v]));
  const known = fields.filter((f) => byName.has(f.toLowerCase()));
  const lines = known.length ? fields.map((f) => `${f}: ${byName.get(f.toLowerCase()) || '–'}`) : got.map(([k, v]) => `${k}: ${v}`);
  return lines.join('\n').slice(0, 3000);
}

/** Put the sheet into chat variables: "Time & date" → {{getvar::Time & date}} and {{getvar::time_date}}. */
export function trackerToVars(text, vars) {
  for (const [k, v] of parseTracker(text)) {
    vars[k] = v;
    vars[k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')] = v;
  }
  return vars;
}
