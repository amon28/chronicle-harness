// The advisor: a stronger model the assistant can ask for a second opinion when it is stuck or about to do something
// risky. It gets the conversation (shortened the way a forked helper gets it) and the question, has no tools, and
// only answers – it changes nothing, so plan mode lets it run. Settings › Tools & agent › Advisor model turns it on.
// Pure parts here; engine.js supplies ctx.advise (the model request).

export const ADVISOR_CAP = 3; // calls per user message

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const advisorDefs = (modelName = '') => [
  fn(
    'advisor',
    `Ask a stronger model${modelName ? ` (${modelName})` : ''} for advice. It sees this conversation and your question, has no tools and changes nothing; it answers once. Use it when you are stuck (the same step failed three times, the repeat guard stopped you), or before a risky or hard-to-undo decision (deleting or overwriting many files, a big rewrite, a force-push). Ask a precise question and say what you tried. At most ${ADVISOR_CAP} times per user message.`,
    {
      question: { type: 'string', description: 'What you need advice on, with what you tried and what went wrong' },
    },
    ['question'],
  ),
];

export const advisorPrompt = () =>
  '- You have an advisor (the advisor tool: a stronger model, no tools). Ask it when the repeat guard stops a call, when the same step has failed three times, or before deleting or overwriting a lot. Then decide yourself – it advises, you act.';

export const ADVISOR_SYSTEM =
  'You are the advisor of an AI assistant that works with tools inside an Android app (a workspace, a Linux shell, Python, a browser). The assistant is stuck or about to make a risky decision and asks you. You see the conversation so far and its question. You cannot call tools or see more than this. Answer the question directly: the most likely cause, the next concrete step to take (or not to take), and what to check. Be brief and specific; say so when the conversation does not hold enough to tell.';

/** The advisor's request: its instructions, the conversation, the question. */
export function advisorMessages(context, question) {
  return [
    { role: 'system', content: ADVISOR_SYSTEM },
    { role: 'user', content: `## The conversation so far\n${context || '(nothing yet)'}\n\n## The assistant's question\n${question}` },
  ];
}

/** The advisor tool. ctx.advise(question, signal) → { text, model }; ctx.advisorLeft() → calls left this message. */
export async function runAdvisorTool(args, ctx) {
  const question = String(args.question || '').trim();
  if (!question) throw new Error('question is required: what you need advice on');
  if (!ctx.advise) return { ok: false, result: 'The advisor is not available here (no advisor model is set in Settings › Tools & agent).', display: { error: 'unavailable' } };
  const left = ctx.advisorLeft ? ctx.advisorLeft() : ADVISOR_CAP;
  if (left <= 0) return { ok: false, result: `Not asked: you already asked the advisor ${ADVISOR_CAP} times for this message. Decide yourself, or tell the user what you need.`, display: { error: 'limit reached' }, meta: { surface: 'harness' } };
  ctx.onStatus?.('asking the advisor…');
  const r = await ctx.advise(question.slice(0, 4000), ctx.signal);
  const text = String(r?.text || '').trim();
  if (!text) return { ok: false, result: 'The advisor sent no answer.', display: { error: 'empty answer' }, meta: { surface: 'harness' } };
  return { ok: true, result: `Advice from ${r.model || 'the advisor'} (it saw the conversation, not your files – check before you act):\n${text}`, display: { path: r.model || 'advisor', output: text.slice(0, 4000) } };
}
