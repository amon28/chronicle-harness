// Output styles, like Claude Code's: a short instruction that changes how replies are written, picked per chat.
// The project can add its own in .chronicle/styles/<name>.md (or .claude/output-styles is not read: keep it simple).

export const BUILTIN_STYLES = [
  { name: 'default', label: 'Default', prompt: '' },
  { name: 'concise', label: 'Concise', prompt: 'Output style – concise: answer in as few words as will do. No preamble, no recap, no closing offers. Use lists only when they save words.' },
  { name: 'explanatory', label: 'Explanatory', prompt: 'Output style – explanatory: as you work, add short "Insight" notes that explain why you chose an approach, the trade-offs, and how this part of the code or topic works, so the user learns along the way. Keep each insight to 2–3 sentences.' },
  { name: 'learning', label: 'Learning', prompt: 'Output style – learning: teach while doing. For small, meaningful pieces (a function body, a condition, a design choice) leave a clearly marked TODO(human) for the user to write instead of writing it yourself, explain what it should do and why, then wait for them. Do the routine parts yourself.' },
];

/** The instruction for a chat's style ('' for default or an unknown one). */
export function stylePrompt(name, projectStyles = []) {
  if (!name || name === 'default') return '';
  const b = BUILTIN_STYLES.find((s) => s.name === name);
  if (b) return b.prompt;
  const p = projectStyles.find((s) => s.name === name);
  return p ? `Output style – ${p.name}: ${p.prompt}` : '';
}
