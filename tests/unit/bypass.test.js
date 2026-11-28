import { describe, it, expect } from 'vitest';
import { gateDecision, guardKeptInBypass, effectivePhoneMode, isBypass, BYPASS_KEEPS, BYPASS_SKIPS } from '../../src/permissions.js';
import { shellDanger } from '../../src/shellguard.js';
import { asksFirst } from '../../src/planmode.js';
import { toolsSystemPrompt, BYPASS_PROMPT, chatDate } from '../../src/tools.js';

// the same inputs gateToolCall (engine.js) puts together for one call
const decide = (name, args, { perms = {}, mode = '', allowed = [], guard = true, askPush = false } = {}) => {
  const command = name === 'shell' ? String(args.command || '') : '';
  const found = name === 'shell' ? shellDanger(command, { askPush }) : null;
  return gateDecision({ perm: perms[name] || 'allow', mode, writes: mode === 'ask' && asksFirst(name, args), allowed: allowed.includes(name), found, command, guard });
};

describe('gateDecision: today\'s modes are unchanged', () => {
  it('Never is never, Ask me asks until allowed for the chat, the rest runs', () => {
    expect(decide('delete_file', { path: 'a' }, { perms: { delete_file: 'deny' } })).toBe('deny');
    expect(decide('write_file', { path: 'a' }, { perms: { write_file: 'ask' } })).toBe('ask');
    expect(decide('write_file', { path: 'a' }, { perms: { write_file: 'ask' }, allowed: ['write_file'] })).toBe('allow');
    expect(decide('read_file', { path: 'a' })).toBe('allow');
  });
  it('🛡 Ask first asks for every change, not for reading', () => {
    expect(decide('write_file', { path: 'a' }, { mode: 'ask' })).toBe('ask');
    expect(decide('mcp_x__y', {}, { mode: 'ask' })).toBe('ask');
    expect(decide('read_file', { path: 'a' }, { mode: 'ask' })).toBe('allow');
    expect(decide('write_file', { path: 'a' }, { mode: 'ask', perms: { write_file: 'deny' } })).toBe('deny');
  });
  it('the shell guard asks in Auto and Ask first, replaces the permission question, and can be switched off', () => {
    expect(decide('shell', { command: 'rm -rf /phone/Pictures' })).toBe('ask-danger');
    expect(decide('shell', { command: 'git reset --hard' }, { mode: 'ask' })).toBe('ask-danger');
    expect(decide('shell', { command: 'rm -rf /phone/Pictures' }, { guard: false })).toBe('allow');
    expect(decide('shell', { command: 'rm -rf /phone/Pictures' }, { guard: false, perms: { shell: 'ask' } })).toBe('ask');
    expect(decide('shell', { command: 'git push origin main' }, { guard: false, askPush: true })).toBe('ask-danger'); // the key's own setting
  });
});

describe('gateDecision: ⚡ Bypass', () => {
  const B = { mode: 'bypass' };
  it('skips Ask me, Ask first-style changes, MCP / mod / saved tools and the per-chat allow list', () => {
    expect(decide('write_file', { path: 'a' }, { ...B, perms: { write_file: 'ask' } })).toBe('allow');
    expect(decide('shell', { command: 'ls' }, { ...B, perms: { shell: 'ask' } })).toBe('allow');
    for (const n of ['mcp_github__create_issue', 'mod_dice__roll', 'tool_cleanup']) expect(decide(n, {}, { ...B, perms: { [n]: 'ask' } })).toBe('allow');
  });
  it('skips the destructive-command guard', () => {
    for (const c of ['rm -rf /workspace', 'rm -rf /phone/Pictures', 'git reset --hard', 'git push --force origin main', 'find /phone -delete', 'dd if=/dev/zero of=/dev/sda']) expect(decide('shell', { command: c }, B)).toBe('allow');
  });
  it('never skips Never – for the shell too', () => {
    expect(decide('delete_file', { path: 'a' }, { ...B, perms: { delete_file: 'deny' } })).toBe('deny');
    expect(decide('shell', { command: 'rm -rf /workspace' }, { ...B, perms: { shell: 'deny' } })).toBe('deny');
    expect(gateDecision({ perm: 'deny', mode: 'bypass' })).toBe('deny');
  });
  it('keeps the SSH push question, also with the guard off', () => {
    expect(decide('shell', { command: 'git push origin main' }, { ...B, askPush: true })).toBe('ask-danger');
    expect(decide('shell', { command: 'git push origin main' }, { ...B, askPush: true, guard: false })).toBe('ask-danger');
    expect(decide('shell', { command: 'git push origin main' }, B)).toBe('allow'); // no SSH push question set: an ordinary push
  });
  it('keeps the questions that protect secrets while the guard is on', () => {
    expect(decide('shell', { command: 'ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N ""' }, B)).toBe('ask-danger');
    expect(decide('shell', { command: 'rm -rf /root/.config/chronicle' }, B)).toBe('ask-danger');
    expect(decide('shell', { command: 'rm -rf ~/.ssh' }, B)).toBe('ask-danger');
    // with the guard off Bypass is not stricter than Auto
    expect(decide('shell', { command: 'rm -rf /root/.config/chronicle' }, { ...B, guard: false })).toBe('allow');
  });
  it('guardKeptInBypass: only for a finding', () => {
    expect(guardKeptInBypass(null, 'rm -rf ~/.ssh')).toBe(false);
    expect(guardKeptInBypass({ rule: 'rm-recursive' }, 'rm -rf /workspace/x')).toBe(false);
    expect(guardKeptInBypass({ rule: 'rm-recursive' }, 'rm -rf /workspace/.sshkeys-notes')).toBe(false);
    expect(guardKeptInBypass({ rule: 'credentials' }, 'gh auth token')).toBe(true);
  });
});

describe('phone folder and the model', () => {
  it('in Bypass Review acts like Auto; Read-only stays read-only', () => {
    expect(effectivePhoneMode('ask', true)).toBe('auto');
    expect(effectivePhoneMode(undefined, true)).toBe('auto');
    expect(effectivePhoneMode('auto', true)).toBe('auto');
    expect(effectivePhoneMode('readonly', true)).toBe('readonly');
    expect(effectivePhoneMode('ask', false)).toBe('ask');
    expect(effectivePhoneMode('', false)).toBe('ask');
  });
  it('isBypass only for the chat mode', () => {
    expect(isBypass({ permMode: 'bypass' })).toBe(true);
    expect(isBypass({ permMode: 'ask' })).toBe(false);
    expect(isBypass(null)).toBe(false);
  });
  it('the system prompt says so in one line, not in plan mode', () => {
    expect(toolsSystemPrompt({ bypass: true }, 0, null)).toContain(BYPASS_PROMPT);
    expect(toolsSystemPrompt({}, 0, null)).not.toContain('Bypass permissions');
    expect(toolsSystemPrompt({ bypass: true, planMode: true }, 0, null)).not.toContain('Bypass permissions');
    expect(BYPASS_PROMPT).toMatch(/say plainly what you did/);
  });
  it('the warning names what still asks', () => {
    const keeps = BYPASS_KEEPS.join(' ');
    for (const w of ['Never', 'SSH', 'location', 'contacts', 'calendar', 'texts', 'tokens']) expect(keeps).toContain(w);
    expect(BYPASS_SKIPS.join(' ')).toContain('Read-only stays read-only');
  });
});

describe('what is switched off, with where to turn it on (decision 270)', () => {
  it('every group that is off is named with its Settings path; a helper is not told', () => {
    const t = toolsSystemPrompt({ web: true, files: true }, 0, null);
    const line = t.split('\n').find((l) => l.startsWith('- Switched off right now:'));
    expect(line).toContain('Python (Settings › Tools & agent › Tools)');
    expect(line).toContain('calendar, contacts, location and places (Settings › Tools & agent › Phone › Phone data)');
    expect(line).toContain("files on the user's PC (Settings › Connections › Files on my PC)");
    expect(line).toContain('texts, call log, notifications and place triggers (Settings › Tools & agent › Phone › Sensitive phone access)');
    expect(line).not.toContain('web search');
    expect(toolsSystemPrompt({ files: true, helper: true }, 0, null)).not.toContain('Switched off right now');
  });
});

describe('dates for search_chats', () => {
  it('reads a day, or days / weeks / months back', () => {
    const now = Date.parse('2026-11-27T12:00:00');
    expect(chatDate('7d', now)).toBe(now - 7 * 864e5);
    expect(chatDate('2w', now)).toBe(now - 14 * 864e5);
    expect(chatDate('2026-11-01', now)).toBe(Date.parse('2026-11-01T00:00:00'));
    expect(chatDate('', now)).toBe(0);
    expect(chatDate('soon', now)).toBeNaN();
  });
});
