import { describe, it, expect } from 'vitest';
import { trimLocalMessages } from '../../src/localllm.js';

// Decision 275: the on-device model's prompt walked newest-first and stopped at 9,000 characters before it reached
// the system message – one system message and six 2,500-character turns came out as assistant, user, assistant.
describe('the on-device model keeps its system prompt', () => {
  const turn = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(2500) });
  it('keeps messages[0] and fills the rest from the newest turns', () => {
    const msgs = [{ role: 'system', content: 'You are Alex, a helpful tutor.' }, ...[0, 1, 2, 3, 4, 5].map(turn)];
    const out = trimLocalMessages(msgs);
    expect(out[0]).toEqual({ role: 'system', content: 'You are Alex, a helpful tutor.' });
    expect(out.at(-1).content).toBe(msgs.at(-1).content);
    expect(out.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(9000);
  });
  it('never starts the kept history on an assistant turn', () => {
    const msgs = [{ role: 'system', content: 'sys' }, ...[0, 1, 2, 3, 4, 5].map(turn)];
    expect(trimLocalMessages(msgs)[1].role).toBe('user');
    const noSys = [0, 1, 2, 3, 4, 5].map(turn);
    expect(trimLocalMessages(noSys)[0].role).toBe('user');
  });
  it('cuts a system message that alone is too long, and still keeps the last turn', () => {
    const out = trimLocalMessages([{ role: 'system', content: 's'.repeat(12000) }, { role: 'user', content: 'hi' }]);
    expect(out[0].content).toHaveLength(9000);
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });
  it('flattens tool results and content parts as before', () => {
    const out = trimLocalMessages([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, { role: 'tool', content: 'r' }]);
    expect(out).toEqual([{ role: 'user', content: 'a\nb' }, { role: 'user', content: 'r' }]);
  });
});
