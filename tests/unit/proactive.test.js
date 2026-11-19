import { describe, it, expect } from 'vitest';
import { inQuiet, afterQuiet, nextProactive, dueProactive, proactiveToday } from '../../src/proactive.js';

const at = (h, m = 0, day = 12) => new Date(2026, 10, day, h, m).getTime();
const quiet = { from: '22:00', to: '08:00' };

describe('proactive messages', () => {
  it('knows quiet hours, also across midnight', () => {
    expect(inQuiet(at(23), quiet)).toBe(true);
    expect(inQuiet(at(7, 59), quiet)).toBe(true);
    expect(inQuiet(at(8), quiet)).toBe(false);
    expect(inQuiet(at(13), { from: '12:00', to: '14:00' })).toBe(true);
    expect(afterQuiet(at(23), quiet)).toBe(at(8, 0, 13));
    expect(afterQuiet(at(15), quiet)).toBe(at(15));
  });
  it('writes after the silence, outside quiet hours, once per silence', () => {
    const conv = { proactive: { hours: 4 }, messages: [{ role: 'user', content: 'hi', at: at(10) }, { role: 'assistant', content: 'hey', at: at(10, 1) }] };
    expect(nextProactive(conv, { quiet })).toBe(at(14, 1));
    conv.messages[1].at = at(20);
    expect(nextProactive(conv, { quiet })).toBe(at(8, 0, 13)); // 00:00 is quiet → next morning
    conv.messages.push({ role: 'assistant', content: 'still there?', at: at(21), proactive: true });
    expect(nextProactive(conv, { quiet })).toBe(0);
    expect(nextProactive({ messages: conv.messages })).toBe(0); // not switched on
  });
  it('respects the daily cap and busy chats', () => {
    const mk = (id, t) => ({ id, proactive: { hours: 1 }, messages: [{ role: 'assistant', content: 'x', at: t }] });
    const convs = [mk('a', at(9)), mk('b', at(8)), mk('c', at(10))];
    expect(dueProactive(convs, { now: at(12), quiet, cap: 2 }).map((c) => c.id)).toEqual(['b', 'a']);
    expect(dueProactive(convs, { now: at(12), quiet, cap: 3, busy: (c) => c.id === 'b' }).map((c) => c.id)).toEqual(['a', 'c']);
    convs[0].messages.push({ role: 'assistant', content: 'y', at: at(11), proactive: true });
    expect(proactiveToday(convs, at(12))).toBe(1);
    expect(dueProactive(convs, { now: at(12), quiet, cap: 1 })).toEqual([]);
    expect(dueProactive(convs, { now: at(23), quiet, cap: 5 })).toEqual([]);
  });
});

import { wakePlan, planKey } from '../../src/wakeplan.js';
describe('wake plan', () => {
  it('lists tasks, retries and proactive times, soonest first, never in the past', () => {
    const now = at(12);
    const convs = [
      { id: 'a', title: 'A', schedules: [{ next: at(15), prompt: 'report' }], messages: [] },
      { id: 'b', title: 'B', resumeAt: at(11), proactive: { hours: 2 }, messages: [{ role: 'assistant', content: 'x', at: at(12) }] },
    ];
    const p = wakePlan(convs, { proactiveOn: true, now });
    expect(p.map((x) => `${x.kind}:${x.convId}`)).toEqual(['resume:b', 'proactive:b', 'task:a']);
    expect(p[0].at).toBe(now + 60000);
    expect(wakePlan(convs, { proactiveOn: false, now }).some((x) => x.kind === 'proactive')).toBe(false);
    expect(planKey(p)).toBe(planKey(wakePlan(convs, { proactiveOn: true, now: now + 1000 })));
  });
});
