// Where Claude Code (installed by the user in the app's Linux) keeps its sign-in, and how to recognise its tokens.
// Chronicle never reads, copies, stores, backs up or shows these: the Linux files browser hides them (linuxfiles.js),
// the shell guard asks before a command touches them (shellguard.js, permissions.js), backups leave them out
// (backup.js). Pure – no imports – so every one of those can use it. See docs/DECISIONS.md 163.

/** Paths under the Linux home (normally /root) that hold or copy Claude Code's sign-in. */
export const claudePrivate = (home = '/root') => ({
  files: [home + '/.claude/.credentials.json'], // the OAuth access + refresh token on Linux
  trees: [home + '/.claude/backups'], // copies of ~/.claude.json that newer versions keep
  prefix: home + '/.claude.json', // ~/.claude.json and its .backup / .lock siblings (account and settings)
});

const norm = (p) => {
  const out = [];
  for (const part of String(p || '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
};

/** Is this absolute path one of Claude Code's sign-in files (or inside its backups folder)? */
export function isClaudePrivate(p, home = '/root') {
  const n = norm(p);
  const c = claudePrivate(home);
  if (c.files.includes(n)) return true;
  if (c.trees.some((t) => n === t || n.startsWith(t + '/'))) return true;
  return n === c.prefix || n.startsWith(c.prefix + '.');
}

/** A file name (anywhere, e.g. copied into a workspace) that is a copy of Claude Code's sign-in. */
export const CLAUDE_SECRET_NAME = /(^|\/)(\.credentials\.json|\.claude\.json(\.[^/]*)?)$/;

/** Claude's OAuth tokens (sk-ant-oat…, sk-ant-ort…) and API keys (sk-ant-api…), or the JSON key that holds them. */
export const CLAUDE_TOKEN = /sk-ant-(oat|ort|api|admin)\d{0,3}-[A-Za-z0-9_-]{16,}|"claudeAiOauth"\s*:/;

/** Text that carries a Claude sign-in token. */
export const hasClaudeToken = (text) => CLAUDE_TOKEN.test(String(text || ''));

const OAUTH = /sk-ant-o[ar]t\d{0,3}-[A-Za-z0-9_-]{16,}|"claudeAiOauth"\s*:/;
/**
 * Is this file (a chat workspace's, on its way into a backup) a copy of Claude Code's sign-in? By name in a .claude
 * place (…/.claude/.credentials.json, …/.claude.json), or by content: a Claude OAuth token. bytes: Uint8Array | string.
 */
export function isClaudeSignInCopy(path, bytes) {
  const p = String(path || '');
  if (CLAUDE_SECRET_NAME.test(p) && /(^|\/)\.claude(\/|\.json)/.test(p)) return true;
  if (/(^|\/)\.credentials\.json$/.test(p) && /(^|\/)\.claude\//.test(p)) return true;
  if (bytes == null) return false;
  const size = typeof bytes === 'string' ? bytes.length : bytes.byteLength || 0;
  if (!size || size > 2 * 1024 * 1024) return false; // a sign-in file is small; big files are not decoded for this
  const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return OAUTH.test(text);
}
