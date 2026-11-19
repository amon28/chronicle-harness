import { describe, it, expect } from 'vitest';
import { anthropicParams } from '../../src/anthropic.js';

// The cache point at the end of the chat history (decision 209): per-turn notes (memories, the scene sheet) come
// after the history and change every turn, so the automatic point on them never matched again.
const points = (params) => {
  const n = [];
  (params.system || []).forEach((b) => b.cache_control && n.push('system'));
  params.messages.forEach((m, i) => m.content.forEach((b) => b.cache_control && n.push(`${i}:${b.type}:${(b.text || b.tool_use_id || '').slice(0, 20)}`)));
  return n;
};

describe('cache points for Claude', () => {
  it('a note after the history: a point at the end of the history, before the note', () => {
    const { params } = anthropicParams({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second question' },
        { role: 'system', content: 'Memories: likes tea' },
      ],
    });
    expect(points(params)).toEqual(['system', '2:text:second question']);
    const last = params.messages.at(-1).content;
    expect(last.at(-1).text).toContain('[System note]'); // the note is still sent, after the point
    expect(last.at(-1).cache_control).toBeUndefined();
    expect(params.cache_control).toEqual({ type: 'ephemeral' }); // the automatic one stays
  });
  it('the next turn starts the same up to that point (so it is read from the cache)', () => {
    const turn = (extra) => anthropicParams({ model: 'm', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'second question' }, ...extra] }).params;
    const a = turn([{ role: 'system', content: 'Memories: A' }]);
    const b = turn([{ role: 'assistant', content: 'second answer' }, { role: 'user', content: 'third' }, { role: 'system', content: 'Memories: B' }]);
    // (the cache point marker is not part of what the cache compares)
    const upTo = (p) => JSON.stringify(p.messages.slice(0, 3).map((m, i) => (i === 2 ? { ...m, content: m.content.slice(0, 1) } : m)), (k, v) => (k === 'cache_control' ? undefined : v));
    expect(upTo(b)).toBe(upTo(a));
  });
  it('in a tool loop the point is on the last tool result', () => {
    const { params } = anthropicParams({
      model: 'm',
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'file text' },
        { role: 'system', content: 'Memories: x' },
      ],
    });
    expect(points(params)).toEqual(['system', '2:tool_result:t1']);
  });
  it('nothing after the history: no extra point (the automatic one is already at the end); never more than 4', () => {
    const { params } = anthropicParams({ model: 'm', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }] });
    expect(points(params)).toEqual(['system']);
  });
});
