// Background protection said honestly (decision 172): what the user and doctor are told.
import { describe, it, expect } from 'vitest';
import { backgroundNotice, backgroundRow, pausedSince } from '../../src/bgstate.js';

describe('background state', () => {
  it('a refused start is said, with the reason; a started one says nothing', () => {
    expect(backgroundNotice({ started: false, reason: 'refused: Android does not allow it while the app is in the background' })).toBe('Background protection is not running (Android does not allow it while the app is in the background): keep Chronicle open until the reply finishes, or it may be paused.');
    expect(backgroundNotice({ started: true }, { running: true, lastStop: 'finished', lastStopAt: 5 }, 10)).toBe('');
  });
  it('a service refused just after the start is said – but not an older refusal', () => {
    expect(backgroundNotice({ started: true }, { running: false, lastStop: 'refused: ForegroundServiceStartNotAllowedException', lastStopAt: 20 }, 10)).toMatch(/not running \(ForegroundServiceStartNotAllowedException\)/);
    expect(backgroundNotice({ started: true }, { running: false, lastStop: 'refused: x', lastStopAt: 5 }, 10)).toBe('');
    expect(backgroundNotice(undefined, null)).toBe(''); // a plugin without the new answer
  });
  it('a time-limit pause is said once', () => {
    expect(pausedSince({ lastStop: 'time limit', lastStopAt: 50 }, 10)).toBe(true);
    expect(pausedSince({ lastStop: 'time limit', lastStopAt: 50 }, 50)).toBe(false);
    expect(pausedSince({ lastStop: 'finished', lastStopAt: 50 }, 10)).toBe(false);
  });
  it("doctor's row: running, refused, paused, idle, with notifications and battery", () => {
    const now = 10 * 60000;
    expect(backgroundRow(null)).toEqual({ state: 'n/a', detail: 'only in the Android app' });
    expect(backgroundRow({ running: true, lastStop: '', notifications: true, batteryFree: true }, now)).toEqual({ state: 'running', detail: 'a reply is protected now; not used yet in this app run' });
    const r = backgroundRow({ running: false, lastStop: 'time limit', lastStopAt: now - 5 * 60000, notifications: false, batteryFree: false }, now);
    expect(r.state).toBe('paused');
    expect(r.detail).toBe('protects a reply while one runs; last stop: time limit (5 min ago); notifications are off (no "reply finished" or "paused" notice); battery optimisation is on (Android may pause it sooner)');
    expect(backgroundRow({ running: false, lastStop: 'refused: x', lastStopAt: now }, now).state).toBe('refused');
    expect(backgroundRow({ running: false, lastStop: 'finished', lastStopAt: now }, now).state).toBe('idle');
  });
});
