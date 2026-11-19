// "# something" in the message box, like Claude Code: remember it instead of sending it.
// With tools on, the line goes into the workspace's AGENTS.md (the project's standing instructions);
// otherwise it becomes a memory for this assistant.

/** "# use tabs" → "use tabs"; null when the message is not a remember line (## headings and #hashtags are not). */
export function rememberText(text) {
  const m = /^#\s+([\s\S]+)$/.exec(String(text || '').trim());
  return m ? m[1].trim() : null;
}

/** AGENTS.md with the line added under "## Notes" (created when missing). */
export function addToAgentsMd(current, line) {
  const item = `- ${line.replace(/\n+/g, ' ')}`;
  const text = String(current || '').replace(/\s+$/, '');
  if (!text) return `# Project instructions\n\n## Notes\n${item}\n`;
  if (/^## Notes\s*$/m.test(text)) {
    const lines = text.split('\n');
    let i = lines.findIndex((l) => /^## Notes\s*$/.test(l)) + 1;
    while (i < lines.length && !/^#{1,2}\s/.test(lines[i])) i++;
    while (i > 0 && !lines[i - 1].trim()) i--;
    lines.splice(i, 0, item);
    return lines.join('\n') + '\n';
  }
  return `${text}\n\n## Notes\n${item}\n`;
}
