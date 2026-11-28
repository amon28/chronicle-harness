// Commands in the chat shell have nobody to type at a prompt: make them fail instead of hang, and when one still waits
// on a prompt, tell the model which prompt it was and what to do.

export const NONINTERACTIVE_ENV = 'export GIT_TERMINAL_PROMPT=0 DEBIAN_FRONTEND=noninteractive PIP_NO_INPUT=1 NPM_CONFIG_YES=true;';

/** cmd with the non-interactive defaults in front; a command that already starts with them is returned as it is. */
export function withNonInteractive(cmd) {
  const s = String(cmd ?? '');
  return s.trimStart().startsWith(NONINTERACTIVE_ENV) ? s : NONINTERACTIVE_ENV + ' ' + s;
}

const PROMPTS = [
  // a one-time setup that needs the password once (ssh-copy-id, a first login) is for the user's own Full terminal (decision 274)
  [/password[^\n]{0,60}:\s*$/i, 'a password prompt', 'there is no one to type it: use a key or token instead (ssh -o BatchMode=yes, GIT_ASKPASS, an env var), or sudo -n; a one-time setup that needs the password once (ssh-copy-id to put a key on a server, a first login) is for the user to run themselves in their own full terminal (☰ › Terminal)'],
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

// Android ends an app's child processes on its own: past its limit on processes (the "phantom process" limit, 32 for
// all apps together) or when memory runs low. The command then dies of SIGKILL – exit 137, or "Killed" – with no error
// of its own, and run again the same way it fails the same way (decision 274).
const KILLED = /(^|\n)[^\n]*\bKilled\b[^\n]*\s*$|\bsignal 9\b|\bSIGKILL\b/;
/** One sentence when a command was ended from outside (exit 137, or "Killed" at the end of a failed command's output); else null. */
export function killedHint(tailText, exit) {
  const text = String(tailText ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-2000);
  if (Number(exit) !== 137 && !(exit != null && Number(exit) !== 0 && KILLED.test(text))) return null;
  return 'Hint: the command was killed from outside (SIGKILL, exit 137) – most likely Android ended it: too many processes at once (its "phantom process" limit) or low memory. Run it again with fewer parallel workers (npm install --maxsockets=1, vitest --pool=forks --poolOptions.forks.maxForks=1, make -j1, pytest without -n) or in smaller parts. If it keeps happening, the user can lift the limit: Android 14+ Settings › Developer options › "Disable child process restrictions"; Android 12–13 from a computer: adb shell settings put global settings_enable_monitor_phantom_procs false.';
}
