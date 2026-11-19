// Commands in the chat shell have nobody to type at a prompt: make them fail instead of hang, and when one still waits
// on a prompt, tell the model which prompt it was and what to do.

export const NONINTERACTIVE_ENV = 'export GIT_TERMINAL_PROMPT=0 DEBIAN_FRONTEND=noninteractive PIP_NO_INPUT=1 NPM_CONFIG_YES=true;';

/** cmd with the non-interactive defaults in front; a command that already starts with them is returned as it is. */
export function withNonInteractive(cmd) {
  const s = String(cmd ?? '');
  return s.trimStart().startsWith(NONINTERACTIVE_ENV) ? s : NONINTERACTIVE_ENV + ' ' + s;
}

const PROMPTS = [
  [/password[^\n]{0,60}:\s*$/i, 'a password prompt', 'there is no one to type it: use a key or token instead (ssh -o BatchMode=yes, GIT_ASKPASS, an env var), or sudo -n'],
  [/passphrase[^\n]{0,60}:\s*$/i, 'a passphrase prompt', 'there is no one to type it: use an unencrypted key or ssh -o BatchMode=yes'],
  [/\[(Y\/n|y\/N|Y\/N|y\/n)\]\??\s*$/, 'a [Y/n] question', 'rerun it with -y (or --yes / --batch / --force)'],
  [/\(yes\/no(\/\[fingerprint\])?\)\??\s*$/i, 'a (yes/no) question (ssh host key?)', 'rerun it with ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'],
  [/Press any key/i, 'a "Press any key" prompt', 'rerun it with a non-interactive flag or pipe input (yes | cmd)'],
  [/Username for\s+\S*\s*$/i, 'a git "Username for" prompt', 'use a token in the URL or GIT_ASKPASS; GIT_TERMINAL_PROMPT=0 makes git fail instead of ask'],
  [/Continue\?\s*(\[[^\]]*\])?\s*$/i, 'a "Continue?" question', 'rerun it with -y (or --yes / --batch)'],
  [/(^|\s)>>> $|^> $/, 'an interactive prompt (">>> " or "> ")', 'it is waiting for input: give it the input with a pipe or heredoc, or pass the script as an argument'],
];

/** One sentence if the output ends on a prompt that waits for someone to type (the last line, no newline after it); else null. */
export function promptHint(tailText) {
  const text = String(tailText ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
  const last = text.slice(-400).split('\n').pop();
  if (!last.trim()) return null;
  for (const [re, what, fix] of PROMPTS) {
    if (re.test(last)) return `Hint: the command seems to be waiting at ${what} (${JSON.stringify(last.trim().slice(-60))}) and nobody can answer it; ${fix}. Stop it with shell_job kill.`;
  }
  return null;
}
