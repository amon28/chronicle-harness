import { describe, it, expect } from 'vitest';
import { convTime, groupConvs, shortTime, timeGroup } from '../../src/convgroups.js';

// a fixed "now" in local time: Saturday 14 Nov 2026, 15:30
const NOW = new Date(2026, 10, 14, 15, 30).getTime();
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo, d, h, mi).getTime();
const L = 'en-GB';

describe('chat list by time', () => {
  it('puts each time in Today, Yesterday, 7 Days, 30 Days, a month or a year', () => {
    const g = (t) => timeGroup(t, NOW, L).label;
    expect(g(at(2026, 10, 14, 0, 0))).toBe('Today'); // just after midnight
    expect(g(at(2026, 10, 14, 23, 59))).toBe('Today');
    expect(g(at(2026, 10, 20))).toBe('Today'); // another phone's clock ahead
    expect(g(at(2026, 10, 13, 23, 59))).toBe('Yesterday');
    expect(g(at(2026, 10, 13, 0, 0))).toBe('Yesterday');
    expect(g(at(2026, 10, 12, 23, 59))).toBe('7 Days');
    expect(g(at(2026, 10, 8, 0, 0))).toBe('7 Days'); // 6 calendar days back
    expect(g(at(2026, 10, 7, 23, 59))).toBe('30 Days');
    expect(g(at(2026, 9, 16, 0, 0))).toBe('30 Days'); // 29 days back
    expect(g(at(2026, 9, 15, 23, 0))).toBe('Oct 2026');
    expect(g(at(2026, 0, 3))).toBe('Jan 2026');
    expect(g(at(2025, 11, 31))).toBe('Dec 2025'); // 11 months back: still a month
    expect(g(at(2025, 10, 30))).toBe('2025'); // 12 months back: its year
    expect(g(at(2019, 5, 1))).toBe('2019');
    expect(g(0)).toBe('Older');
  });

  it('counts calendar days, also across a month and a year boundary', () => {
    const jan2 = new Date(2027, 0, 2, 9, 0).getTime();
    expect(timeGroup(at(2027, 0, 1, 22), jan2, L).label).toBe('Yesterday');
    expect(timeGroup(at(2026, 11, 27, 8), jan2, L).label).toBe('7 Days');
    expect(timeGroup(at(2026, 11, 4, 8), jan2, L).label).toBe('30 Days');
    expect(timeGroup(at(2026, 11, 3, 8), jan2, L).label).toBe('Dec 2026');
    expect(timeGroup(at(2026, 10, 20), jan2, L).label).toBe('Nov 2026');
  });

  it('groups chats newest first, by updatedAt with createdAt as the fallback', () => {
    const convs = [
      { id: 'old', updatedAt: at(2024, 2, 1) },
      { id: 'today2', updatedAt: at(2026, 10, 14, 9) },
      { id: 'yest', createdAt: at(2026, 10, 13, 9) }, // never updated
      { id: 'today1', updatedAt: at(2026, 10, 14, 15) },
      { id: 'oct', updatedAt: at(2026, 9, 2), createdAt: at(2026, 10, 14) }, // updatedAt wins
      { id: 'week', updatedAt: at(2026, 10, 10) },
      { id: 'none' },
    ];
    const groups = groupConvs(convs, NOW, L);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', '7 Days', 'Oct 2026', '2024', 'Older']);
    expect(groups.map((g) => g.items.map((c) => c.id))).toEqual([['today1', 'today2'], ['yest'], ['week'], ['oct'], ['old'], ['none']]);
    expect(convTime({ createdAt: 5 })).toBe(5);
    expect(groupConvs([], NOW)).toEqual([]);
  });

  it('gives each row a short time: the clock today, the weekday this week, the date before', () => {
    expect(shortTime(at(2026, 10, 14, 14, 5), NOW, L)).toBe('14:05');
    expect(shortTime(at(2026, 10, 9, 8), NOW, L)).toBe('Mon');
    expect(shortTime(at(2026, 10, 13, 8), NOW, L)).toBe('Fri');
    expect(shortTime(at(2026, 9, 12), NOW, L)).toBe('12 Oct');
    expect(shortTime(at(2023, 9, 12), NOW, L)).toBe('12 Oct');
    expect(shortTime(0, NOW, L)).toBe('');
  });
});
