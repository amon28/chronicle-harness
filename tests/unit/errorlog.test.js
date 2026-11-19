// The app's error log (decision 177).
import { describe, it, expect, beforeEach } from 'vitest';
import { MAX, _resetLogForTest, clearLog, flushLog, formatLog, isErrorText, logError, readLog } from '../../src/errorlog.js';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

describe('error log', () => {
  beforeEach(() => {
    store.clear();
    _resetLogForTest();
  });
  it('keeps entries newest first, with kind, tool and chat; survives a restart', () => {
    logError('tool', 'places: search server busy (HTTP 502)', { tool: 'places', conv: 'c1', title: 'Trip', model: 'GLM-5.3' });
    logError('reply', new Error('HTTP 429: rate limited'), { conv: 'c1' });
    flushLog();
    _resetLogForTest(); // a new app run
    const l = readLog();
    expect(l.map((e) => e.kind)).toEqual(['reply', 'tool']);
    expect(l[1]).toMatchObject({ tool: 'places', conv: 'c1', title: 'Trip', model: 'GLM-5.3' });
    expect(readLog('tool')).toHaveLength(1);
  });
  it('counts the same error repeated within a minute instead of filling the log', () => {
    for (let i = 0; i < 5; i++) logError('app', 'x is undefined', { where: 'engine.js:10:2' });
    expect(readLog()).toHaveLength(1);
    expect(readLog()[0].n).toBe(5);
    expect(formatLog()).toMatch(/x is undefined \(×5\)\n {4}at engine\.js:10:2/);
  });
  it('keeps the newest 500, and never secrets', () => {
    for (let i = 0; i < MAX + 20; i++) logError('app', 'error ' + i);
    expect(readLog()).toHaveLength(MAX);
    expect(readLog()[0].msg).toBe('error 519');
    clearLog();
    logError('reply', 'HTTP 401 for key sk-abcdefghijklmnop12345 with Bearer abcdefghijklmnopqrstuv and ghp_abcdefghijklmnop');
    expect(readLog()[0].msg).toBe('HTTP 401 for key [secret] with Bearer [secret] and [secret]');
  });
  it('tells error toasts from the others', () => {
    for (const t of ['Export failed: disk full', 'Could not load models: Failed to fetch', 'Claude Code did not start', 'Background protection is not running (refused)', 'Not allowed here']) expect(isErrorText(t), t).toBe(true);
    for (const t of ['Copied', 'Tools on for this chat', 'Installed: Claude Code 2.1.325', 'Polished – type /unpolish to put your words back']) expect(isErrorText(t), t).toBe(false);
  });
});
