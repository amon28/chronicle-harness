import { describe, it, expect } from 'vitest';
import { parseStChat, toStChat, toReadable } from '../../src/stchat.js';

const st = [
  { user_name: 'Alex', character_name: 'Seraphina', create_date: '2025-03-01@10h20m30s', chat_metadata: {} },
  { name: 'Seraphina', is_user: false, is_system: false, send_date: 'March 1, 2025 10:20am', mes: '*She kneels.* Easy now.', swipes: ['*She kneels.* Easy now.', 'Who are you?'], swipe_id: 0 },
  { name: 'Alex', is_user: true, is_system: false, send_date: 'March 1, 2025 10:21am', mes: 'Where am I?' },
  { name: 'System', is_user: false, is_system: true, mes: 'hidden note' },
  { name: 'Seraphina', is_user: false, send_date: 'March 1, 2025 10:22am', mes: 'In my glade.' },
]
  .map((r) => JSON.stringify(r))
  .join('\n');

describe('SillyTavern chats', () => {
  it('parses header, messages, swipes and skips system notes', () => {
    const c = parseStChat(st);
    expect(c.user).toBe('Alex');
    expect(c.character).toBe('Seraphina');
    expect(c.messages.map((m) => `${m.role}:${m.content}`)).toEqual(['assistant:*She kneels.* Easy now.', 'user:Where am I?', 'assistant:In my glade.']);
    expect(c.messages[0].swipes).toHaveLength(2);
    expect(typeof c.messages[1].at).toBe('number');
  });
  it('rejects files that are not chats', () => {
    expect(() => parseStChat('not json')).toThrow(/not valid JSON/);
    expect(() => parseStChat(JSON.stringify({ user_name: 'x' }))).toThrow(/No messages/);
  });
  it('round-trips a chat (with swipes) through the ST format', () => {
    const conv = {
      createdAt: Date.UTC(2025, 0, 2),
      messages: [
        { role: 'user', content: 'hi', at: Date.UTC(2025, 0, 2) },
        { role: 'assistant', content: 'second', alts: [{ content: 'first' }, { content: 'second' }], altIndex: 1, personaId: 's' },
      ],
    };
    const back = parseStChat(toStChat(conv, { user: 'Alex', character: 'Seraphina' }));
    expect(back.user).toBe('Alex');
    expect(back.messages.map((m) => m.content)).toEqual(['hi', 'second']);
    expect(back.messages[1].swipes).toEqual(['first', 'second']);
    expect(back.messages[1].swipeIndex).toBe(1);
  });
  it('exports readable Markdown and text', () => {
    const conv = { messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: '**Hi** there' }] };
    const md = toReadable(conv, { title: 'Test', user: 'Alex', nameOf: () => 'Lia' });
    expect(md).toContain('# Test');
    expect(md).toContain('**Alex**');
    expect(md).toContain('**Hi** there');
    const txt = toReadable(conv, { title: 'Test', user: 'Alex', nameOf: () => 'Lia', markdown: false });
    expect(txt).toContain('Lia:\n**Hi** there');
  });
});
