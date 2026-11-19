/**
 * Recipes: a workflow in one Markdown file – typed parameters, numbered steps, sub-recipes, an optional schedule.
 *
 *   ---
 *   name: weekly-report
 *   description: News on a topic, summarised into report.md
 *   params: topic (required), days = 7
 *   schedule: daily 08:00            (or: every 90 – minutes)
 *   ---
 *   ## Find the news
 *   Search the web for {{topic}} news from the last {{days}} days.
 *   ## Use: summarise-file path=/workspace/news.md      ← a sub-recipe step
 *   ## Write it up
 *   Write the summary to /workspace/report.md.
 *
 * Each step is sent to the chat as a message once the previous reply has finished. Imported recipes are shown with
 * hidden characters revealed before they are saved (prompt injection likes invisible Unicode).
 */
import { frontMatter } from './projectfiles.js';

const NAME_RX = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** "topic (required), days = 7, style=short" → [{ name, required, def }] */
export function parseParams(s) {
  return String(s || '')
    .split(/,(?![^"]*"\s*(?:,|$))/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const req = /\(required\)|\*$/.test(x);
      const m = /^([A-Za-z_][\w-]*)\s*(?:=\s*(.*?))?\s*(?:\(required\)|\*)?$/.exec(x.replace(/\s*\(required\)\s*/, ' ').trim());
      if (!m) throw new Error(`Can't read the parameter "${x}"`);
      return { name: m[1], required: req, def: m[2] != null ? m[2].replace(/^"(.*)"$/, '$1') : '' };
    });
}

/** "daily 08:00" | "every 90" → { at?: 'HH:MM', every?: minutes } | null */
export function parseSchedule(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return null;
  let m = /^daily\s+(\d{1,2}):(\d{2})$/.exec(t);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return { at: `${m[1].padStart(2, '0')}:${m[2]}`, every: 1440 };
  m = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?)?$/.exec(t);
  if (m) {
    const n = Number(m[1]) * (/^h/.test(m[2] || '') ? 60 : 1);
    if (n >= 5) return { every: n };
  }
  throw new Error(`Can't read the schedule "${s}" – use "daily 08:00" or "every 90" (minutes, at least 5)`);
}

/** The text of a recipe file → { name, description, params, schedule, steps: [{ title, text, use? }] }. Throws on errors. */
export function parseRecipe(text, fallbackName = '') {
  const { meta, body } = frontMatter(text);
  const name = String(meta.name || fallbackName || '').trim().toLowerCase();
  if (!NAME_RX.test(name)) throw new Error('A recipe needs a name: lowercase letters, digits, - or _ (front matter "name:")');
  const steps = [];
  const parts = body.split(/^##\s+/m);
  const intro = parts.shift().trim();
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const title = (nl < 0 ? p : p.slice(0, nl)).trim();
    const txt = nl < 0 ? '' : p.slice(nl + 1).trim();
    const use = /^use:\s*([a-z0-9_-]+)(.*)$/i.exec(title);
    if (use) steps.push({ title, use: use[1].toLowerCase(), args: parseArgs(use[2]), text: txt });
    else if (txt) steps.push({ title, text: txt });
  }
  if (!steps.length && intro) steps.push({ title: 'Do it', text: intro });
  if (!steps.length) throw new Error('A recipe needs at least one step ("## Step title" followed by what to do)');
  if (steps.length > 30) throw new Error('A recipe can have at most 30 steps');
  return { name, description: String(meta.description || '').slice(0, 200), params: parseParams(meta.params), schedule: parseSchedule(meta.schedule), steps, intro: parts.length ? intro : '' };
}

/** 'topic="new phones" days=3' → { topic: 'new phones', days: '3' }; a bare first word goes to the first parameter. */
export function parseArgs(s, params = []) {
  const out = {};
  const rest = [];
  for (const m of String(s || '').matchAll(/([A-Za-z_][\w-]*)=("([^"]*)"|'([^']*)'|\S+)|("([^"]*)"|\S+)/g)) {
    if (m[1]) out[m[1]] = m[3] ?? m[4] ?? m[2];
    else rest.push(m[6] ?? m[5]);
  }
  // words without a name fill the parameters in order (the last one takes what is left)
  const free = params.filter((p) => !(p.name in out));
  if (rest.length && free.length) {
    free.slice(0, -1).forEach((p, i) => rest[i] != null && (out[p.name] = rest[i]));
    const tail = rest.slice(free.length - 1);
    if (tail.length) out[free[free.length - 1].name] = tail.join(' ');
  }
  return out;
}

/** Fill {{param}} in a step. Unknown {{…}} are left alone (they may be chat macros). */
export const fill = (text, values) => String(text).replace(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g, (m, k) => (k in values ? String(values[k]) : m));

/**
 * The messages to send, sub-recipes expanded (at most 3 deep, no loops). lookup(name) → parsed recipe or null.
 * → [{ label, text }]; throws on a missing required parameter or an unknown sub-recipe.
 */
export function plan(recipe, args, lookup, depth = 0, seen = new Set()) {
  if (depth > 3) throw new Error('Sub-recipes go more than 3 deep');
  if (seen.has(recipe.name)) throw new Error(`Recipe "${recipe.name}" calls itself`);
  const values = {};
  for (const p of recipe.params) {
    const v = args[p.name] ?? (p.def !== '' ? p.def : undefined);
    if (v == null || v === '') {
      if (p.required) throw new Error(`"${recipe.name}" needs ${p.name}`);
      values[p.name] = '';
    } else values[p.name] = v;
  }
  const out = [];
  const n = recipe.steps.length;
  recipe.steps.forEach((s, i) => {
    if (s.use) {
      const sub = lookup(s.use);
      if (!sub) throw new Error(`"${recipe.name}" uses the recipe "${s.use}", which is not installed`);
      const subArgs = Object.fromEntries(Object.entries(s.args).map(([k, v]) => [k, fill(v, values)]));
      for (const x of plan(sub, subArgs, lookup, depth + 1, new Set([...seen, recipe.name]))) out.push({ label: `${recipe.name} ${i + 1}/${n} › ${x.label}`, text: x.text });
      if (s.text) out.push({ label: `${recipe.name} ${i + 1}/${n}`, text: fill(s.text, values) });
    } else out.push({ label: `${recipe.name} ${i + 1}/${n} · ${s.title}`, text: fill(s.text, values) });
  });
  return out;
}

// ---------- reviewing an imported recipe ----------
// zero-width and joiners, bidi controls, invisible formatters, Unicode tag characters, variation selectors
const HIDDEN = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿︀-️]|\uDB40[\uDC00-\uDDEF]/g;
/** → { count, text: with every hidden character shown as ⟦U+XXXX⟧, clean: without them } */
export function revealHidden(s) {
  let count = 0;
  const text = String(s || '').replace(HIDDEN, (c) => {
    count++;
    return `⟦U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`;
  });
  return { count, text, clean: String(s || '').replace(HIDDEN, '') };
}
