// Tool permissions, like OpenCode's allow / ask / deny: per tool, set in Settings › Tools › Permissions.
// "ask" shows the question sheet before the call ("Allow once", "Allow for this chat", "Deny" – or type what to do instead).

/** The tools worth a rule, grouped for the settings list. [name, label] */
export const PERMISSION_TOOLS = [
  ['shell', '💻 Linux shell'],
  ['shell_job', '💻 Shell jobs (poll / kill)'],
  ['run_python', '🐍 Python'],
  ['browser', '🧭 Browser control'],
  ['write_file', '✏️ Write files'],
  ['edit_file', '✏️ Edit files'],
  ['apply_patch', '🩹 Patch files'],
  ['delete_file', '🗑 Delete files'],
  ['phone_write', '📱 Write to the phone folder'],
  ['phone_delete', '📱 Delete in the phone folder'],
  ['fetch_url', '🌐 Read web pages'],
  ['web_search', '🔍 Web search'],
  ['delegate', '🤝 Helper agents'],
  ['claude_code', '💻 Claude Code tasks'],
  ['schedule_task', '⏰ Schedule tasks'],
  ['save_mod', '🧩 Install mods'],
  ['mcp_*', '🔌 Every MCP tool'],
  ['mod_*', '🧩 Every mod tool'],
];

/** 'allow' | 'ask' | 'deny' for a tool: its own setting, else the MCP / mod default. */
export function toolPermission(perms, name) {
  const p = perms || {};
  const n = String(name || '');
  return p[n] || (n.startsWith('mcp_') ? p['mcp_*'] : '') || (n.startsWith('mod_') ? p['mod_*'] : '') || 'allow';
}

// ---------- ⚡ Bypass permissions (a chat's conv.permMode === 'bypass') ----------
// Like Claude Code's bypassPermissions: the chat's tools run without the app asking first. It skips the *tool
// prompts* only; what is not a prompt about running a tool stays (see BYPASS_KEEPS and docs/DECISIONS.md 161).

export const isBypass = (conv) => conv?.permMode === 'bypass';

/** The phone-folder mode a chat really works in: in Bypass, Review acts like Auto; Read-only is a choice about the folder and stays. */
export const effectivePhoneMode = (mode, bypass) => (bypass && (mode || 'ask') === 'ask' ? 'auto' : mode || 'ask');

// where the app keeps the GitHub token and the SSH key (github.js, linuxfiles.js HIDDEN), SSH keys in general, and
// Claude Code's own sign-in in the app's Linux (claudesecrets.js: ~/.claude/.credentials.json, ~/.claude.json, its token)
export const SECRET_PATH = /\.config\/chronicle(\/|\b|$)|(^|[\s'"=:/~])\.ssh(\/|\b|$)|\bid_(rsa|ed25519|ecdsa|dsa)\b|\.claude\/(\.cred|backups)|\.claude\.json|CLAUDE_CODE_OAUTH_TOKEN|sk-ant-o[ar]t|\bclaude\s+setup-token\b/;

/**
 * A shell-guard finding Bypass never waves through: the SSH push question (it belongs to the key's own setting, and
 * is kept even with the guard off), and – while the guard is on – making or handing out credentials and anything
 * that touches where the app keeps its secrets.
 */
export function guardKeptInBypass(found, command = '', guard = true) {
  if (!found) return false;
  if (found.rule === 'ssh-push') return true;
  return !!guard && (found.rule === 'credentials' || SECRET_PATH.test(String(command || '')));
}

/**
 * The decision for one tool call, before your hooks run – pure, so the rules are tested in one place:
 *   'deny'       the tool is set to Never (in every mode, Bypass too)
 *   'ask-danger' the shell guard's question ("Run this shell command?")
 *   'ask'        the permission question ("Allow once / for this chat / Deny")
 *   'allow'      runs
 * perm: the Settings rule (toolPermission); mode: conv.permMode ('' | 'ask' | 'bypass'); writes: the call changes
 * something (asksFirst); allowed: already allowed for this chat; found: shellDanger() or null; command: the shell
 * command; guard: Settings › "Ask before a dangerous shell command".
 */
export function gateDecision({ perm = 'allow', mode = '', writes = false, allowed = false, found = null, command = '', guard = true } = {}) {
  if (perm === 'deny') return 'deny';
  const bypass = mode === 'bypass';
  if (found && (bypass ? guardKeptInBypass(found, command, guard) : guard || found.rule === 'ssh-push')) return 'ask-danger';
  if (bypass) return 'allow';
  const p = mode === 'ask' && writes ? 'ask' : perm;
  return p === 'ask' && !allowed ? 'ask' : 'allow';
}

/** What Bypass skips and what still asks – the warning sheet and the docs say the same. */
export const BYPASS_SKIPS = [
  'your “Ask me” tool permissions and “Allow for this chat”',
  '🛡 Ask first',
  'the dangerous-shell-command check (rm -rf, git reset --hard, force-push, deleting or overwriting phone files – files on your phone have no undo)',
  'the phone-folder review: changes are saved at once, like ⚡ Auto (Read-only stays read-only)',
  'saving big files from the shell into the phone folder',
  'saved Python tools, MCP and mod tools',
];
export const BYPASS_KEEPS = [
  'tools you set to Never',
  'pushes with your SSH key (its own setting)',
  'commands that make keys or touch where the app keeps your tokens (or Claude Code keeps its sign-in)',
  'reading your personal data: calendar, contacts, location, Wi-Fi names, notifications, texts, calls, clipboard, photos',
  'handing things to other apps (texts, calls, emails, links) – they stay drafts you finish there',
  'phone controls, adding calendar events, creating characters, removing mods, setting up triggers',
];
