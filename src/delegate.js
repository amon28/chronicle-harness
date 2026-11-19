// Helper agents: the assistant can hand a self-contained side job (summarise a long file, check a list, draft a
// section) to a cheaper model and get just the answer back, which keeps the main chat's context small and cheap.
import { helperMode } from './subagent.js';
import { modelVia } from './models.js';

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

const MAX_FILE = 60000; // characters per file handed to the helper
const MAX_TOTAL = 150000;

/** One line per model for the helper's "model" choice: id, name, price and what it can do. */
export function modelLines(models = []) {
  return models.slice(0, 40).map((m) => {
    const c = m.cost?.text;
    const price = c?.input?.price != null ? `$${c.input.price}/$${c.output?.price ?? '?'} per M` : m.source === 'local' ? 'on device, free' : '';
    const bits = [m.limit?.context ? `${Math.round(m.limit.context / 1000)}K context` : '', m.capabilities?.tools?.supported === false ? 'no tools' : '', m.capabilities?.image?.input?.supported || m.modalities?.input?.includes?.('image') ? 'sees images' : '', price].filter(Boolean);
    return `- ${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ''}${bits.length ? ': ' + bits.join(', ') : ''} · via ${modelVia(m)}`;
  });
}

export function delegateDefs(agents = [], models = [], helper = '') {
  const d = [
    fn(
      'delegate',
      'Hand a self-contained side job to a helper agent (a cheaper model) and get only its final answer back – its steps never fill your context. It cannot see this chat or ask the user anything: put everything it needs in "task", and name workspace files in "files" to give it their text. tools="none" (default): one answer, no tools – summarising, extracting, checking items, drafting, translating. tools="read": it may search the web, read pages and workspace files, look at images – research and reading jobs; several of these run at the same time when you call delegate more than once in one step. tools="full": it may also run Python and the shell and write workspace files – a bounded piece of work (one script, one conversion); one at a time. Write the task as a brief with four parts: (1) the objective, (2) scope and sources (which files, sites or period; what to leave out), (3) the output format and length you want back, (4) what is already known or ruled out. One helper is enough for a single question; use 2-4 for comparisons. You stay responsible for the final answer: check what it returns, and check files it says it wrote.',
      {
        task: { type: 'string', description: 'A complete, self-contained instruction for the helper, including the format you want back' },
        files: { type: 'array', items: { type: 'string' }, description: 'Workspace text files whose contents the helper should read' },
        tools: { type: 'string', enum: ['none', 'read', 'full'], description: 'What the helper may use (default none)' },
        max_steps: { type: 'integer', description: 'With tools: most tool steps the helper may take (default 8, at most 20)' },
        context: { type: 'string', enum: ['fresh', 'fork'], description: 'fresh (default): it sees only the task. fork: it also gets this conversation so far (your recent steps and the user\'s requests), for a side job that needs that background' },
      },
      ['task'],
    ),
  ];
  // which model does the job: the user's helper model unless you name another from their list
  if (models.length) {
    d[0].function.parameters.properties.model = {
      type: 'string',
      // every model of the user's is allowed; with more than 40 the list would be too long for a choice, so it is the
      // first 40 described and any other id taken as it is (it used to be a choice of the first 40 only – decision 214)
      ...(models.length <= 40 ? { enum: models.map((m) => m.id) } : {}),
      description: `Leave out for the user's helper model${helper ? ` (${helper})` : ''} - right for most jobs. Name one only when the job needs it: a stronger model for hard reasoning or code, one that sees images, a bigger context. These ids are also what a project agent file's "model:" takes. Available${models.length > 40 ? ` (40 of ${models.length}; any other id of theirs works too)` : ''}:\n${modelLines(models).join('\n')}`,
    };
  }
  // the project's own named agents (.chronicle/agents/*.md): their prompt, tools and model come from the file
  if (agents.length) {
    const p = d[0].function.parameters.properties;
    p.agent = { type: 'string', enum: agents.map((a) => a.name), description: 'Hand the job to one of this project\'s agents (its own instructions, tools and model; "tools" is then ignored):\n' + agents.map((a) => `- ${a.name}: ${a.description || '(no description)'} [tools: ${a.allow ? a.allow.join(', ') : a.tools}${a.model ? `, model ${a.model}` : ''}]`).join('\n') };
  }
  return d;
}

export const delegatePrompt = () =>
  '- For a bulky side job (summarising a long file, going through many items, a first draft, researching one question, a self-contained script), call delegate: a helper agent does it and returns only the result, so your context stays small. Give it a complete task and the files it needs. Write each task as a brief: objective, scope and sources, output format and length, and what is already ruled out. One helper for a single question, 2-4 for comparisons; give it tools="read" to research or read, tools="full" to also run code and write files. Independent research questions can go to several read helpers in the same step – they run side by side.';

const dec = new TextDecoder();
const FORMAT_RE = /\b(format|bullets?|bulleted|table|json|csv|list|summary|paragraphs?|sentences?|words?|lines?|headings?|reply|respond|return|output|answer with|yes\/no|one line)\b/i;
const SCOPE_RE = /\b(files?|urls?|https?|www|sites?|sources?|pages?|docs?|documentation|folder|director(y|ies)|workspace|repo|only|within|between|since|before|after|ignore|exclude|skip|except|[\w-]+\.[a-z]{1,5})\b|\//i;
const MIN_BRIEF = 120;

/** Short problems with a delegated brief (pure, deterministic). An empty list means the brief looks fine. */
export function briefIssues(task, mode = 'none', files = []) {
  const t = String(task || '').trim();
  const issues = [];
  if (mode !== 'none' && t.length < MIN_BRIEF) issues.push(`the task is short (under ${MIN_BRIEF} characters) for a helper with tools`);
  if (!FORMAT_RE.test(t)) issues.push('no output format or length stated');
  if ((mode === 'read' || mode === 'full') && !(Array.isArray(files) && files.length) && !SCOPE_RE.test(t)) issues.push('no scope or sources stated');
  return issues;
}

/** Builds the helper's prompt from the task and the named workspace files. */
export function buildDelegatePrompt(task, files, workspace) {
  const parts = [];
  let total = 0;
  const missing = [];
  for (const raw of Array.isArray(files) ? files.slice(0, 12) : []) {
    const path = String(raw || '').replace(/^\/?workspace\//, '').replace(/^\//, '');
    const f = workspace?.files?.[path];
    if (!f) {
      missing.push(path);
      continue;
    }
    let text = dec.decode(f.data);
    if (text.includes('\u0000')) {
      missing.push(path + ' (not a text file)');
      continue;
    }
    const room = Math.min(MAX_FILE, MAX_TOTAL - total);
    if (room <= 0) break;
    const cut = text.length > room;
    text = text.slice(0, room);
    total += text.length;
    parts.push(`--- ${path}${cut ? ' (truncated)' : ''} ---\n${text}`);
  }
  const prompt = String(task || '').trim() + (parts.length ? '\n\n' + parts.join('\n\n') : '') + '\n\nReply in at most about 1,500 words unless the task asks for more.';
  return { prompt, missing };
}

export async function runDelegate(args, ctx) {
  const task = String(args.task || '').trim();
  if (!task) throw new Error('task is required');
  if (!ctx.delegate) return { ok: false, result: 'Helper agents are not available here.', display: { error: 'unavailable' } };
  const named = args.agent ? (ctx.agents || []).find((a) => a.name === args.agent) : null;
  if (args.agent && !named) return { ok: false, result: `There is no agent "${args.agent}" in this project (.chronicle/agents/ or .claude/agents/).`, display: { error: 'no such agent' } };
  const mode = helperMode(named ? named.tools : args.tools);
  const maxSteps = Math.max(1, Math.min(20, Number(args.max_steps) || 8));
  const built = buildDelegatePrompt(task, args.files, ctx.workspace);
  const { missing } = built;
  const fork = args.context === 'fork' && ctx.forkContext ? ctx.forkContext() : '';
  const prompt = fork ? `## Background: the conversation so far (you are a helper forked from it; do not continue it, do only your task)\n${fork}\n\n## Your task\n${built.prompt}` : built.prompt;
  ctx.onStatus?.(named ? `${named.name} is working…` : 'Helper is working…');
  const onStep = (steps) => {
    // the step going on now (the calls after it in the same turn are listed as waiting)
    const at = steps.findLastIndex((x) => x.status !== 'waiting');
    const s = steps[Math.max(0, at)];
    ctx.onStatus?.(`Helper · step ${Math.max(0, at) + 1}: ${s.name}${s.label ? ' ' + s.label.slice(0, 40) : ''}`);
  };
  const r = await ctx.delegate(prompt, ctx.signal, { mode, maxSteps, onStep, ...(args.model ? { model: String(args.model) } : {}), ...(named ? { system: named.prompt, model: named.model || args.model, allow: named.allow, label: named.name } : {}) });
  const steps = r.steps || [];
  const notes = [];
  if (r.modelId || r.model) notes.push(`helper model: ${r.modelId || r.model}`); // which model really did the work
  if (missing.length) notes.push(`Could not give the helper: ${missing.join(', ')}`);
  if (steps.length) notes.push(`The helper took ${steps.length} tool step${steps.length === 1 ? '' : 's'}: ${steps.map((s) => s.name + (s.status === 'error' ? ' (failed)' : '')).join(', ')}`);
  if (fork) notes.push('It was given this conversation as background');
  if (r.stoppedAtLimit) notes.push(`It stopped at its limit of ${maxSteps} steps, so the job may be unfinished`);
  const issues = briefIssues(task, mode, args.files);
  if (issues.length) notes.push(`Brief check: ${issues.join('; ')}. A fuller brief (objective, scope and sources, output format and length, what is ruled out) usually gives a better result`);
  const note = notes.length ? '\n\n[' + notes.join('. ') + ']' : '';
  return { ok: true, result: r.text + note, display: { path: r.model, mode, task: task.slice(0, 300), output: r.text.slice(0, 6000), steps: steps.map(({ name, label, status }) => ({ name, label, status })) } };
}
