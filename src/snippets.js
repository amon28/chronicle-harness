// Prompt snippets / slash commands. {{text}} is replaced with whatever you typed after the command
// (or appended below the snippet if it has no placeholder).
export const DEFAULT_SNIPPETS = [
  { id: 's_tldr', cmd: 'tldr', title: 'TL;DR', text: 'Give me a TL;DR of this in 3 bullet points:\n\n{{text}}' },
  { id: 's_explain', cmd: 'explain', title: 'Explain simply', text: 'Explain this simply, step by step, with an example:\n\n{{text}}' },
  { id: 's_fix', cmd: 'fix', title: 'Fix code', text: 'Find the bugs in this code, explain the root cause briefly and show the fixed code:\n\n{{text}}' },
  { id: 's_review', cmd: 'review', title: 'Code review', text: 'Review this code for bugs, security issues, performance and readability. Be specific and prioritize:\n\n{{text}}' },
  { id: 's_tr', cmd: 'translate', title: 'Translate to English', text: 'Translate this into natural English (keep the tone):\n\n{{text}}' },
  { id: 's_improve', cmd: 'improve', title: 'Improve writing', text: 'Improve this text: fix grammar, make it clearer and more natural, keep my voice. Show only the improved text:\n\n{{text}}' },
  { id: 's_shorter', cmd: 'shorter', title: 'Make it shorter', text: 'Make your last answer much shorter.', send: true },
  { id: 's_continue', cmd: 'continue', title: 'Continue', text: 'Continue.', send: true },
  { id: 's_ooc', cmd: 'ooc', title: 'Out of character (roleplay)', text: '(( OOC: {{text}} ))' },
  { id: 's_init', cmd: 'init', title: 'Write AGENTS.md (agent)', text: 'Look through this workspace (start with repo_map, then read the key files: README, package/build files, entry points, tests) and write AGENTS.md at the top of the workspace: what the project is, how it is laid out, how to build, run and test it, the code style and conventions you see, and anything a new contributor must not break. Keep it short and factual – it is sent with every message in this chat. {{text}}' },
  // for studying (decision 275): a quiz with ask_user, flashcards as a table and a CSV, a compiler error explained
  { id: 's_quiz', cmd: 'quiz', title: 'Quiz me', text: 'Quiz me on this, one question at a time. Ask each one with ask_user as a multiple-choice question (4 options, one right). After my answer, say whether it was right and explain why in a sentence or two, then ask the next one. After 5 questions (or when I say stop), give my score and what to review. Topic or material:\n\n{{text}}' },
  { id: 's_flashcards', cmd: 'flashcards', title: 'Make flashcards', text: 'Make flashcards from this: one card per key fact, term or idea – a short question or term on the front, a short answer on the back. Show them as a Markdown table (Front | Back), and save the same cards as a CSV with the columns front,back to /workspace/output/flashcards.csv (it imports into Anki and Quizlet):\n\n{{text}}' },
  { id: 's_explain_error', cmd: 'explain-error', title: 'Explain an error', text: 'I am a beginner. Explain this compiler or runtime error step by step: what the message means in plain words, which line and part of my code it points at, the most likely cause, and how to fix it (show the corrected line). If you need more of my code to be sure, say what to paste:\n\n{{text}}' },
];

// snippets added in later versions: given once to people who already have their own list (after the v4 step below:
// the study ones are v5, decision 275)
const ADDED = { 2: ['s_init'] };
const ADDED_LATER = { 5: ['s_quiz', 's_flashcards', 's_explain_error'] };
const LATEST = 5;
export function ensureSnippets(settings) {
  if (!Array.isArray(settings.snippets)) {
    settings.snippets = DEFAULT_SNIPPETS.map((s) => ({ ...s }));
    settings.snippetsV = LATEST;
    return true;
  }
  let changed = false;
  const add = (list) => {
    for (const [v, ids] of Object.entries(list)) {
      if ((settings.snippetsV || 1) >= Number(v)) continue;
      for (const id of ids) {
        const d = DEFAULT_SNIPPETS.find((x) => x.id === id);
        if (d && !settings.snippets.some((x) => x.id === id || x.cmd === d.cmd)) settings.snippets.push({ ...d });
      }
      settings.snippetsV = Number(v);
      changed = true;
    }
  };
  add(ADDED);
  // v4: "Continue" is no longer put on the roleplay bar (sending an empty message already continues)
  if ((settings.snippetsV || 1) < 4) {
    const c = settings.snippets.find((x) => x.id === 's_continue');
    if (c && c.bar === 'rp' && c.text === 'Continue.') delete c.bar;
    settings.snippetsV = 4;
    changed = true;
  }
  add(ADDED_LATER);
  return changed;
}

/** "/fix foo" → { snippet, rest: "foo" } or null. */
export function matchCommand(input, snippets) {
  const m = input.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const s = snippets.find((x) => x.cmd.toLowerCase() === m[1].toLowerCase());
  return s ? { snippet: s, rest: m[2] || '' } : null;
}

export function applySnippet(snippet, rest) {
  const t = snippet.text;
  if (t.includes('{{text}}')) return t.replace(/\{\{text\}\}/g, rest.trim()).trim();
  return rest.trim() ? `${t}\n\n${rest.trim()}` : t;
}
