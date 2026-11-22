// Plan mode: the assistant looks around (reads, searches, runs read-only checks) and proposes a plan; nothing is
// changed until you approve it. propose_plan shows the plan through the same question sheet as ask_user.
// Also: the per-turn changes card (which files a reply changed, with diffs) and AGENTS.md project instructions.

import { mcpReadOnly } from './mcphints.js';
const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

// tools that change something: blocked while a plan waits for approval
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'delete_file', 'move_file', 'run_python', 'shell', 'shell_job', 'phone_write', 'phone_delete', 'phone_import', 'pc_write', 'pc_import', 'pc_shell', 'save_tool', 'save_mod', 'save_skill', 'edit_skill', 'save_persona', 'save_character', 'save_lorebook', 'edit_persona', 'edit_lorebook', 'manage_mod', 'ralph_loop', 'schedule_task', 'browser', 'claude_code']);
const writesFor = (name, args) => {
  if (name === 'delegate') return String(args?.tools || 'none') === 'full';
  if (name === 'shortcuts') return !['list', 'read'].includes(String(args?.action || 'list'));
  if (name === 'manage_mcp') return !['list', 'search', 'test'].includes(String(args?.action || 'list'));
  if (name === 'memory' || name === 'saved_tools') return !['list', 'read'].includes(String(args?.action || 'list'));
  if (name === 'manage_mod') return true;
  if (name === 'calendar') return args?.action === 'add';
  if (name === 'notifications') return ['dismiss', 'open'].includes(String(args?.action || '')); // dismissing or opening one changes something; listing reads
  if (name === 'phone_control') return String(args?.action || '') !== 'clipboard_get'; // the flashlight, volume, media keys, clipboard: all change something
  if (name.startsWith('mcp_') && mcpReadOnly(name)) return false; // a trusted server says it only reads (decision 201)
  if (name.startsWith('tool_') || name.startsWith('mcp_') || name.startsWith('mod_')) return true; // cannot tell: treated as writing
  return WRITE_TOOLS.has(name);
};
export const isWriteCall = (name, args) => writesFor(String(name || ''), args || {});
/**
 * 🛡 Ask first: does this call wait for the user's OK? Every call that changes something – the same test plan mode
 * uses, so a saved (Python) tool, an MCP or mod tool and a memory edit ask like a file write does. Two ask in their
 * own way already: a helper's calls are asked one by one, and calendar add always shows its own question.
 * `args` may still be the JSON text the model sent.
 */
export function asksFirst(name, args) {
  const n = String(name || '');
  if (n === 'delegate' || n === 'calendar') return false;
  let a = args;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a || '{}');
    } catch {
      a = {};
    }
  }
  return isWriteCall(n, a);
}

export const proposePlanDefs = () => [
  fn(
    'propose_plan',
    'Plan mode: show the user your plan and ask for approval before changing anything. Give the concrete steps (files to change, commands to run, how you will check it). They approve, ask for changes, or reject. After approval you may use every tool.',
    {
      title: { type: 'string', description: 'One line: what the plan does' },
      steps: { type: 'array', items: { type: 'string' }, description: 'The steps, in order' },
      notes: { type: 'string', description: 'Risks, open questions, what you found while looking' },
    },
    ['steps'],
  ),
];

export const planModePrompt = (plan) =>
  plan?.status === 'approved'
    ? `## Plan mode – approved\nThe user approved your plan${plan.title ? ` "${plan.title}"` : ''}. Carry it out step by step and check each step.${plan.feedback ? `\nThey added: ${plan.feedback}` : ''}`
    : `## Plan mode is on\nDo not change anything yet: no writing or editing files, no shell, Python, browser actions or helpers with full tools. Look around with the read-only tools (read_file, grep_files, glob_files, list_files, web_search, fetch_url, doctor, delegate with tools="read") and then call propose_plan with concrete steps. Wait for approval before doing the work.${plan?.status === 'revise' ? `\nThe user asked you to change the plan: ${plan.feedback}` : ''}`;

export const blockedInPlan = (name) => `Not run: plan mode is on and your plan is not approved yet, so ${name} (which changes things) is blocked. Look around with read-only tools, then call propose_plan.`;

export const APPROVE = 'Approve – go ahead';
export const REJECT = 'Reject – do nothing';

/** → { plan, result } from the user's answer to the plan question. */
export function planAnswer(answer, plan) {
  const a = String(answer ?? '').trim();
  if (!a || a === REJECT || /^reject/i.test(a)) return { plan: { ...plan, status: 'rejected' }, result: 'The user rejected the plan. Do not carry it out. Ask what they want instead, or stop.' };
  if (a === APPROVE || /^approve/i.test(a) || /^\(no preference/i.test(a) || /^(yes|ok|okay|go|go ahead|do it|sure|lgtm)\b[.! ]*$/i.test(a)) return { plan: { ...plan, status: 'approved' }, result: 'The user approved the plan. Plan mode is lifted for it: carry it out now, step by step, checking each step.' };
  return { plan: { ...plan, status: 'revise', feedback: a.slice(0, 2000) }, result: `The user wants changes to the plan: ${a}\nRevise it (look further if needed) and call propose_plan again.` };
}

export async function runProposePlan(args, ctx) {
  const pm = ctx.planMode;
  if (!ctx.ask) return { ok: false, result: 'Cannot ask the user here.', display: { error: 'unavailable' } };
  const steps = (Array.isArray(args.steps) ? args.steps : String(args.steps || '').split('\n')).map((s) => String(s).trim()).filter(Boolean).slice(0, 30);
  if (!steps.length) throw new Error('steps is required');
  const title = String(args.title || '').trim().slice(0, 200);
  const text = `${title ? `📋 ${title}\n\n` : '📋 Plan\n\n'}${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${args.notes ? `\n\n${String(args.notes).slice(0, 1500)}` : ''}\n\nOr type what to change.`;
  ctx.onStatus?.('waiting for your approval…');
  const answer = await ctx.ask(text, [APPROVE, REJECT], ctx.signal);
  const base = { title, steps, at: Date.now() };
  const { plan, result } = planAnswer(answer, base);
  pm?.set(plan);
  return { ok: true, result, display: { path: plan.status, answer: String(answer ?? ''), todos: steps.map((s) => ({ text: s, status: 'pending' })) } };
}

// ---------- the changes card ----------
const dec = new TextDecoder();
const isText = (f) => f && f.data.byteLength < 400 * 1024 && !f.data.subarray(0, 4096).includes(0);
/**
 * What a turn changed, for the card under the reply: [{ path, kind, added, removed, diff? }].
 * diff(before, after) → ops ({ t, s }); files under .out/ (spilled output) are left out.
 */
export function changeList(changes, files, diff, { maxFiles = 30, maxOps = 120 } = {}) {
  const out = [];
  for (const c of changes) {
    if (c.path.startsWith('.out/')) continue;
    if (out.length >= maxFiles) break;
    const before = c.before;
    const after = files[c.path] || null;
    const item = { path: c.path, kind: c.kind, added: 0, removed: 0 };
    if ((!before || isText(before)) && (!after || isText(after))) {
      const lines = (f, t) => dec.decode(f.data).replace(/\n$/, '').split('\n').map((s) => ({ t, s }));
      const ops = !before ? lines(after, '+') : !after ? lines(before, '-') : diff(dec.decode(before.data), dec.decode(after.data));
      item.added = ops.filter((o) => o.t === '+').length;
      item.removed = ops.filter((o) => o.t === '-').length;
      item.diff = ops.length > maxOps ? [...ops.slice(0, maxOps), { t: '…', s: `${ops.length - maxOps} more lines` }] : ops;
    } else item.binary = true;
    out.push(item);
  }
  return out;
}

// ---------- AGENTS.md ----------
export const AGENT_FILES = ['AGENTS.md', 'agents.md', 'CLAUDE.md', '.agents/AGENTS.md'];
/** The project's own instructions from the workspace, if there are any. */
export function agentsInstructions(files, max = 8000) {
  for (const p of AGENT_FILES) {
    const f = files?.[p];
    if (!f || !isText(f)) continue;
    const t = dec.decode(f.data).trim();
    if (!t) continue;
    return `## Project instructions (${p} in the workspace)\nFollow these for work in this workspace (the user's instructions in the chat come first):\n${t.length > max ? t.slice(0, max) + `\n… [${t.length - max} more chars – read ${p}]` : t}`;
  }
  return '';
}
