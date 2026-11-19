import { describe, it, expect } from 'vitest';
import { cacheBreak, cacheBreakText, requestShape } from '../../src/cachediag.js';

const req = (msgs, tools = [{ function: { name: 'read_file' } }], model = 'm') => ({ model, tools, messages: msgs });
const S = { role: 'system', content: 'You are helpful.' };
const u = (t) => ({ role: 'user', content: t });
const a = (t) => ({ role: 'assistant', content: t });
const late = (t) => ({ role: 'system', content: t });

describe('where the prompt cache stopped matching', () => {
  it('a request that continues the one before: no break, even when the per-turn context at the end changed', () => {
    const one = requestShape(req([S, u('hi'), late('Memories: A')]));
    const two = requestShape(req([S, u('hi'), a('hello'), u('more'), late('Memories: B')]));
    expect(cacheBreak(one, two)).toBeNull();
    expect(cacheBreakText(null)).toMatch(/reuse/);
  });
  it('a changed system prompt, tool list or model is named', () => {
    const one = requestShape(req([S, u('hi')]));
    expect(cacheBreak(one, requestShape(req([{ role: 'system', content: 'Memories moved in here' }, u('hi')]))).at).toBe('system');
    expect(cacheBreak(one, requestShape(req([S, u('hi')], [])))).toMatchObject({ at: 'tools', reused: 0 });
    expect(cacheBreak(one, requestShape(req([S, u('hi')], undefined, 'other'))).at).toBe('model');
  });
  it('an older message that changed (a trimmed tool result) says how much is still reused', () => {
    const one = requestShape(req([S, u('a'), a('long result'), u('b')]));
    const b = cacheBreak(one, requestShape(req([S, u('a'), a('trimmed'), u('b'), a('x'), u('c')])));
    expect(b).toMatchObject({ at: 'message', index: 2, reused: 2 });
    expect(cacheBreakText(b)).toBe('Cache: changed from message #3 of 6 – the 2 before it can be reused');
  });
});
