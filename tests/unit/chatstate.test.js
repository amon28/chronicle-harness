import { describe, it, expect, beforeEach } from 'vitest';
import { rememberChat, recallChat } from '../../src/chatstate.js';

const mem = {};
globalThis.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => (mem[k] = String(v)), removeItem: (k) => delete mem[k] };

describe('per-chat draft and reading position', () => {
  beforeEach(() => Object.keys(mem).forEach((k) => delete mem[k]));
  it('keeps each chat’s own draft and place, and forgets when both are empty', () => {
    rememberChat('a', { draft: 'half a thought', at: 12 });
    rememberChat('b', { draft: '' , at: null });
    expect(recallChat('a')).toEqual({ draft: 'half a thought', at: 12 });
    expect(recallChat('b')).toEqual({ draft: '', at: null });
    rememberChat('a', {});
    expect(recallChat('a')).toEqual({ draft: '', at: null });
  });
  it('keeps only the 60 most recent chats', () => {
    for (let i = 0; i < 70; i++) rememberChat('c' + i, { draft: 'x' }, i);
    expect(recallChat('c0').draft).toBe('');
    expect(recallChat('c69').draft).toBe('x');
  });
});
