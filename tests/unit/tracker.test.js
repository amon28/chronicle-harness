import { describe, it, expect } from 'vitest';
import { cleanTracker, fieldList, parseTracker, trackerToVars } from '../../src/tracker.js';

describe('scene tracker', () => {
  it('reads Field: value lines, tolerating bullets and bold', () => {
    expect(parseTracker('- **Location**: the old mill\nnoise\nTime: dusk')).toEqual([['Location', 'the old mill'], ['Time', 'dusk']]);
  });
  it('keeps the configured fields in order, unknown ones as –', () => {
    const f = fieldList('Time, Location, Mood');
    expect(cleanTracker('Location: mill\nTime: dusk\nExtra: x', f)).toBe('Time: dusk\nLocation: mill\nMood: –');
    expect(cleanTracker('Sorry, I cannot.', f)).toBe('');
  });
  it('becomes chat variables', () => {
    expect(trackerToVars('Time & date: day 2, noon', {})).toEqual({ 'Time & date': 'day 2, noon', time_date: 'day 2, noon' });
  });
});
