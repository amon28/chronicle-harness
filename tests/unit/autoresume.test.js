import { describe, it, expect } from 'vitest';
import { resumeTime, dueResumes } from '../../src/autoresume.js';

describe('auto-resume', () => {
  const now = 1_000_000;
  it('waits for every limited meter to reset', () => {
    expect(resumeTime({ rolling: { limited: true, resetsAt: now + 5000 }, weekly: { limited: true, resetsAt: now + 9000 }, monthly: { limited: false, resetsAt: now + 1 } }, now)).toBe(now + 9000 + 30000);
  });
  it('plans nothing when no meter is limited or the time is unknown', () => {
    expect(resumeTime({ rolling: { limited: false, resetsAt: now + 5000 } }, now)).toBe(0);
    expect(resumeTime({ rolling: { limited: true, resetsAt: NaN } }, now)).toBe(0);
    expect(resumeTime(null, now)).toBe(0);
  });
  it('picks chats whose time passed and whose last reply still failed', () => {
    const fail = { role: 'assistant', error: 'limit' };
    const convs = [
      { id: 'a', resumeAt: now - 1, messages: [{ role: 'user' }, fail] },
      { id: 'b', resumeAt: now + 1, messages: [fail] },
      { id: 'c', resumeAt: now - 1, messages: [{ role: 'assistant', content: 'ok' }] },
      { id: 'd', messages: [fail] },
    ];
    expect(dueResumes(convs, now).map((c) => c.id)).toEqual(['a']);
  });
});

import { ageNote, isStale, memoryBlock } from '../../src/memory.js';
describe('memory age', () => {
  const now = Date.UTC(2026, 10, 1);
  it('says how old a note is once it is a month old', () => {
    expect(ageNote({ updatedAt: now - 5 * 864e5 }, now)).toBe('');
    expect(ageNote({ updatedAt: now - 95 * 864e5 }, now)).toBe('noted 3 months ago');
    expect(ageNote({ updatedAt: now - 800 * 864e5 }, now)).toBe('noted 2 years ago');
    expect(ageNote({ updatedAt: now - 800 * 864e5, pinned: true }, now)).toBe('');
  });
  it('marks notes not confirmed for half a year', () => {
    expect(isStale({ updatedAt: now - 200 * 864e5 }, now)).toBe(true);
    expect(isStale({ updatedAt: now - 20 * 864e5 }, now)).toBe(false);
  });
  it('puts the age in the prompt', () => {
    const b = memoryBlock([{ id: '1', text: 'Works at a bakery', scope: 'global', updatedAt: Date.now() - 100 * 864e5 }], 'p1', 'c1');
    expect(b).toMatch(/Works at a bakery \(noted 3 months ago\)/);
  });
});
