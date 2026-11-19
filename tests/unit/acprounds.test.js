import { describe, it, expect } from 'vitest';
import { acpCall, acpRounds } from '../../src/acp.js';

describe('an agent reply as the app draws it', () => {
  it('tool calls become cards with plain-text titles (a shell command with \\( and * is not markdown or math)', async () => {
    const cmd = "cd /root/.claude; ls -la plugins/synced/* ; find / \\( -path /proc -o -path /x \\) -prune -o -name SKILL.md -print";
    const { rounds, content } = acpRounds([
      { t: 'text', s: 'Let me look.\n' },
      { t: 'tool', id: 't1', title: 'ls -la /root/.claude/skills', kind: 'execute', status: 'completed', output: 'skills\ncommands' },
      { t: 'tool', id: 't2', title: cmd, kind: 'execute', status: 'pending' },
      { t: 'text', s: 'Found 3 skills.' },
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].content).toBe('Let me look.\n');
    const [a, b] = rounds[0].calls;
    expect(a).toMatchObject({ name: 'shell', status: 'done', display: { output: 'skills\ncommands' } });
    expect(JSON.parse(a.arguments).path).toBe('ls -la /root/.claude/skills');
    expect(b).toMatchObject({ name: 'shell', status: 'running', statusText: 'waiting…' });
    expect(JSON.parse(b.arguments).path).toBe(cmd); // exactly the command, shown as text
    expect(b.result).toContain(cmd); // a long command is whole in the opened card
    expect(content).toBe('Found 3 skills.');
  });
  it('kinds map to the app\'s cards; unknown kinds are a generic tool; failures are errors', async () => {
    expect(acpCall({ title: 'Read a.js', kind: 'read', status: 'completed' }).name).toBe('read_file');
    expect(acpCall({ title: 'Edit a.js', kind: 'edit', status: 'failed' })).toMatchObject({ name: 'edit_file', status: 'error' });
    expect(acpCall({ title: 'https://x.dev', kind: 'fetch', status: 'in_progress' })).toMatchObject({ name: 'fetch_url', status: 'running' });
    expect(acpCall({ title: 'Think', kind: 'think' }).name).toBe('agent_tool');
  });
});

describe('an agent reply as text for another model', () => {
  it('what it said, and what it did in brackets – not tool calls', async () => {
    const { agentReplyText } = await import('../../src/acp.js');
    const t = agentReplyText([
      { t: 'text', s: 'Let me look.\n' },
      { t: 'tool', id: 't1', title: 'ls -la', kind: 'execute', status: 'completed', output: 'a\nb' },
      { t: 'tool', id: 't2', title: 'Edit main.py', kind: 'edit', status: 'failed' },
      { t: 'text', s: 'Done.' },
    ]);
    expect(t).toBe('Let me look.\n\n[Ran: ls -la]\n\n[Tool: Edit main.py – failed]\nDone.');
  });
});
