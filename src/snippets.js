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
];

// snippets added in later versions: given once to people who already have their own list
const ADDED = { 2: ['s_init'] };
export function ensureSnippets(settings) {
  if (!Array.isArray(settings.snippets)) {
    settings.snippets = DEFAULT_SNIPPETS.map((s) => ({ ...s }));
    settings.snippetsV = 4;
    return true;
  }
  let changed = false;
  for (const [v, ids] of Object.entries(ADDED)) {
    if ((settings.snippetsV || 1) >= Number(v)) continue;
    for (const id of ids) {
      const d = DEFAULT_SNIPPETS.find((x) => x.id === id);
      if (d && !settings.snippets.some((x) => x.id === id || x.cmd === d.cmd)) settings.snippets.push({ ...d });
    }
    settings.snippetsV = Number(v);
    changed = true;
  }
  // v4: "Continue" is no longer put on the roleplay bar (sending an empty message already continues)
  if ((settings.snippetsV || 1) < 4) {
    const c = settings.snippets.find((x) => x.id === 's_continue');
    if (c && c.bar === 'rp' && c.text === 'Continue.') delete c.bar;
    settings.snippetsV = 4;
    changed = true;
  }
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
