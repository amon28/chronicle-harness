// Recipes: the sheet (list, new, edit, import from a link with hidden characters revealed), running one in a chat
// step by step, and scheduling one in a chat.
import { $, el, hooks, state, toast, uid } from './core.js';
import { saveSettings } from '../store.js';
import { httpGet } from '../api.js';
import { parseRecipe, parseArgs, plan, revealHidden } from '../recipes.js';
import { projectRecipeFiles } from '../projectfiles.js';
import { firstRun } from '../autonomy.js';
import { looksText, bytesToText } from '../sandbox.js';
import { openDrawer, openSheet, persist } from './chatlist.js';
import { renderMessages } from './render.js';
import { runCompletion } from './engine.js';
import { wsMem } from './extras.js';
import { askText } from './choose.js';

const wsFiles = (id) => wsMem.get(id)?.files;

const TEMPLATE = `---
name: my-recipe
description: What it does
params: topic (required), days = 7
# schedule: daily 08:00
---
## Find out
Search the web for {{topic}} news from the last {{days}} days and list the five most important.
## Write it up
Write a short summary of those to /workspace/report.md.
`;

const own = () => (state.settings.recipes ||= []);
const decode = (b) => (looksText(b) ? bytesToText(b) : null);
/** Every recipe this chat can use: the project's first, then your own. → [{ name, text, path?, project?, id? , recipe|error }] */
export function recipesFor(conv = state.current) {
  const out = [];
  for (const f of projectRecipeFiles(wsFiles(conv?.id), decode)) out.push(f);
  for (const r of own()) if (!out.some((x) => x.name === r.name)) out.push(r);
  return out.map((r) => {
    try {
      return { ...r, recipe: parseRecipe(r.text, r.name) };
    } catch (e) {
      return { ...r, error: e.message };
    }
  });
}
const lookupIn = (conv) => (n) => recipesFor(conv).find((x) => x.name === n && x.recipe)?.recipe || null;

/** Run a recipe in a chat: each step as a message, sent when the reply before has finished. Stops on an error or Stop. */
export async function runRecipe(conv, name, argText = '', args = null) {
  const r = lookupIn(conv)(name);
  if (!r) throw new Error(`No recipe "${name}"`);
  if (state.runs.has(conv.id)) throw new Error('Wait for the reply to finish, then run the recipe');
  const steps = plan(r, args || parseArgs(argText, r.params), lookupIn(conv));
  state.stopped.delete(conv.id);
  for (const [i, s] of steps.entries()) {
    conv.messages.push({ role: 'user', content: s.text, at: Date.now(), recipe: { name: r.name, step: i + 1, total: steps.length, label: s.label } });
    persist(conv);
    if (state.current === conv) renderMessages();
    await runCompletion(null, { conv });
    const last = conv.messages[conv.messages.length - 1];
    if (last?.error || state.stopped.has(conv.id)) {
      if (state.current === conv) toast(`Recipe ${r.name} stopped at step ${i + 1} of ${steps.length}`, 4000);
      return false;
    }
  }
  if (state.current === conv) toast(`✓ Recipe ${r.name} done (${steps.length} step${steps.length === 1 ? '' : 's'})`);
  return true;
}
hooks.runRecipe = runRecipe;
hooks.recipeNames = () => recipesFor().filter((x) => x.recipe).map((x) => ({ name: x.name, description: x.recipe.description, project: !!x.project }));

/** Put a recipe on this chat's schedule (its own schedule line). */
function scheduleRecipe(conv, rec, argText) {
  const sch = rec.recipe.schedule;
  if (!sch) return toast('This recipe has no schedule line (e.g. "schedule: daily 08:00")');
  const args = parseArgs(argText, rec.recipe.params);
  plan(rec.recipe, args, lookupIn(conv)); // check the parameters now, not at 8 in the morning
  const next = sch.at ? firstRun({ at: sch.at }) : Date.now() + sch.every * 60000;
  const t = { id: 'st_' + uid().slice(0, 6), prompt: `Recipe ${rec.name}${argText ? ' ' + argText : ''}`, next, every: sch.every, recipe: { name: rec.name, args }, created: Date.now() };
  hooks.schedulesFor?.(conv).add(t);
  toast(`🧪 ${rec.name} scheduled in this chat – first run ${new Date(next).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`, 4000);
}

// ---------- the sheet ----------
let editing = null; // { id?, text, imported? }
function openRecipes() {
  const list = $('#rc-list');
  list.innerHTML = '';
  const all = recipesFor();
  if (!all.length) list.append(el('p', 'hint pad', 'No recipes yet. Make one, or import one from a link.'));
  for (const r of all) {
    const row = el('div', 'persona-item rc-item');
    const t = el('div', 'persona-text');
    const sub = r.error ? `⚠ ${r.error}` : `${r.recipe.steps.length} step${r.recipe.steps.length === 1 ? '' : 's'}${r.recipe.params.length ? ' · ' + r.recipe.params.map((p) => p.name + (p.required ? '*' : '')).join(', ') : ''}${r.recipe.schedule ? ' · ⏰ ' + (r.recipe.schedule.at ? 'daily ' + r.recipe.schedule.at : 'every ' + r.recipe.schedule.every + ' min') : ''}${r.project ? ' · 📁 project' : ''}`;
    t.append(el('div', 'persona-title', '/' + r.name + (r.recipe?.description ? ' – ' + r.recipe.description : '')), el('div', 'persona-desc', sub));
    t.onclick = () => (r.project ? toast(`Edit it in the workspace: ${r.path}`) : edit(r));
    row.append(t);
    if (r.recipe) {
      const run = el('button', 'act', 'Run');
      run.onclick = () => askArgs(r, (argText) => {
        openSheet('#recipes-sheet', false);
        runRecipe(state.current, r.name, argText).catch((e) => toast(e.message, 4500));
      });
      row.append(run);
      if (r.recipe.schedule) {
        const sch = el('button', 'act', 'Schedule');
        sch.onclick = () => askArgs(r, (argText) => {
          try {
            scheduleRecipe(state.current, r, argText);
          } catch (e) {
            toast(e.message, 4500);
          }
        });
        row.append(sch);
      }
    }
    list.append(row);
  }
  $('#rc-main').hidden = false;
  $('#rc-editor').hidden = true;
  openDrawer(false);
  openSheet('#settings-sheet', false);
  openSheet('#recipes-sheet', true);
}
/** Ask for the parameters (only when it has any). */
async function askArgs(r, go) {
  if (!r.recipe.params.length) return go('');
  const hint = r.recipe.params.map((p) => `${p.name}${p.required ? ' (required)' : p.def ? ` (default ${p.def})` : ''}`).join(', ');
  const v = await askText(`Parameters for ${r.name}`, '', { hint: `${hint}\ne.g. ${r.recipe.params.map((p) => `${p.name}="…"`).join(' ')}`, ok: 'Run' });
  if (v != null) go(v);
}
function edit(r, { imported = false, text = null } = {}) {
  editing = { id: r?.id || null, imported };
  const src = text ?? r?.text ?? TEMPLATE;
  const h = revealHidden(src);
  $('#rc-hidden-warn').hidden = !h.count;
  $('#rc-hidden-warn').textContent = h.count ? `⚠ This recipe contains ${h.count} hidden character${h.count === 1 ? '' : 's'} (shown as ⟦U+…⟧). They can hide instructions from you. They are removed when you save.` : '';
  $('#rc-text').value = h.text;
  $('#rc-editor-hint').textContent = imported ? 'Imported – read it before saving: it will send these steps to the assistant, with whatever tools the chat has.' : 'Front matter: name, description, params (name (required), name = default), schedule (daily HH:MM or every N minutes). Then one "## Step" per step; "## Use: other-recipe key=value" runs another recipe.';
  $('#rc-delete').hidden = !r?.id;
  summarize();
  $('#rc-main').hidden = true;
  $('#rc-editor').hidden = false;
}
function summarize() {
  try {
    const r = parseRecipe(revealHidden($('#rc-text').value.replace(/⟦U\+[0-9A-F]{4,6}⟧/g, '')).clean);
    $('#rc-summary').textContent = `✓ /${r.name}: ${r.steps.length} step${r.steps.length === 1 ? '' : 's'}${r.steps.some((s) => s.use) ? ' (with sub-recipes)' : ''}${r.params.length ? ' · parameters ' + r.params.map((p) => p.name).join(', ') : ''}${r.schedule ? ' · schedule ' + (r.schedule.at ? 'daily ' + r.schedule.at : 'every ' + r.schedule.every + ' min') : ''}`;
  } catch (e) {
    $('#rc-summary').textContent = '⚠ ' + e.message;
  }
}
$('#rc-text').addEventListener('input', summarize);
$('#rc-new').onclick = () => edit(null);
$('#rc-back').onclick = openRecipes;
$('#rc-save').onclick = () => {
  const text = revealHidden($('#rc-text').value.replace(/⟦U\+[0-9A-F]{4,6}⟧/g, '')).clean;
  let r;
  try {
    r = parseRecipe(text);
  } catch (e) {
    return toast(e.message, 4000);
  }
  const list = own();
  const clash = list.find((x) => x.name === r.name && x.id !== editing?.id);
  if (clash && !confirm(`Replace your recipe "${r.name}"?`)) return;
  const id = editing?.id || clash?.id || 'rc_' + uid().slice(0, 8);
  const rec = { id, name: r.name, text, at: Date.now(), ...(editing?.imported ? { source: editing.imported } : {}) };
  state.settings.recipes = [...list.filter((x) => x.id !== id && x.name !== r.name), rec];
  saveSettings(state.settings);
  toast(`Saved /${r.name}`);
  openRecipes();
};
$('#rc-delete').onclick = () => {
  if (!editing?.id || !confirm('Delete this recipe?')) return;
  state.settings.recipes = own().filter((x) => x.id !== editing.id);
  saveSettings(state.settings);
  openRecipes();
};
$('#rc-import').onclick = async () => {
  let url = $('#rc-url').value.trim();
  if (!/^https:\/\//.test(url)) return toast('Paste an https:// link to a recipe .md file');
  url = url.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/$2/').replace(/^(https:\/\/gist\.github\.com\/[^/]+\/[0-9a-f]+)\/?$/, '$1/raw');
  try {
    const r = await httpGet(url, {}, 20000);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    if (r.body.length > 100000) throw new Error('That file is too big for a recipe');
    edit(null, { imported: url, text: r.body });
  } catch (e) {
    toast(`Couldn’t import it: ${e.message}`, 4000);
  }
};
$('#settings-recipes').onclick = openRecipes;
hooks.openRecipes = openRecipes;
