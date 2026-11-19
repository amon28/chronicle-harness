// Planning tools for the agent: a visible to-do list (todo_write) and a way to stop and ask you (ask_user).
const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export function planDefs() {
  return [
    fn(
      'todo_write',
      'Keep a visible to-do list for a multi-step task. Send the WHOLE list every time (it replaces the old one): each item has text and a status – pending, in_progress (only one at a time) or done. Create it before starting work that has three or more steps, and update it as you finish steps, so the user can follow progress.',
      { items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['text', 'status'] } } },
      ['items'],
    ),
    fn(
      'ask_user',
      'Stop and ask the user a question with a few tappable choices. Use it when a requirement is ambiguous and guessing wrong would waste work (which design, which file, which approach), not for things you can reasonably decide yourself. Give 2–4 short, distinct options; the user can also type their own answer. Returns what they chose. Several open questions? Send them together in "questions" (up to 6): the user sees them as pages with back/next arrows and answers once.',
      {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: '2–4 short choices' },
        questions: { type: 'array', description: 'Instead of question/options: several questions at once', items: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] } },
      },
      [],
    ),
  ];
}

export const planPrompt = () =>
  '- For a task with three or more steps, call todo_write first and update it as you go. When something is genuinely ambiguous, call ask_user with 2–4 options instead of guessing; otherwise decide and carry on.';

const STATUS = ['pending', 'in_progress', 'done'];
export function cleanTodos(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const text = String(it?.text || '').trim().slice(0, 200);
    if (!text) continue;
    out.push({ text, status: STATUS.includes(it.status) ? it.status : 'pending' });
  }
  let seen = false; // only one item is "in progress"
  for (const t of out) if (t.status === 'in_progress') (seen ? (t.status = 'pending') : (seen = true));
  return out.slice(0, 30);
}

export async function runPlanTool(name, args, ctx) {
  if (name === 'todo_write') {
    const items = cleanTodos(args.items);
    if (!items.length) throw new Error('items must be a list of { text, status }');
    ctx.todos?.set(items);
    const done = items.filter((i) => i.status === 'done').length;
    return { ok: true, result: `To-do list updated (${done}/${items.length} done).`, display: { todos: items, path: `${done}/${items.length}` } };
  }
  if (name === 'ask_user') {
    const clean = (q, o) => ({ question: String(q || '').trim(), options: (Array.isArray(o) ? o : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 5) });
    const list = Array.isArray(args.questions) && args.questions.length ? args.questions.slice(0, 6).map((x) => clean(x?.question, x?.options)) : [clean(args.question, args.options)];
    if (!list.every((x) => x.question)) throw new Error('question is required');
    if (!ctx.ask) throw new Error('Asking is not available here – decide for yourself and say what you chose.');
    ctx.onStatus?.('waiting for your answer…');
    if (list.length === 1) {
      const answer = await ctx.ask(list[0].question, list[0].options, ctx.signal);
      return { ok: true, result: `The user answered: ${answer}`, display: { path: list[0].question.slice(0, 60), answer } };
    }
    const answers = await ctx.ask(list, null, ctx.signal);
    return { ok: true, result: list.map((x, i) => `Q${i + 1}. ${x.question}\nAnswer: ${answers[i]}`).join('\n\n'), display: { path: `${list.length} questions`, answer: answers.join(' · ').slice(0, 200) } };
  }
  return null;
}
