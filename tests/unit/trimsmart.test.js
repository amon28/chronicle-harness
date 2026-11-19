import { describe, it, expect } from 'vitest';
import { trimResult } from '../../src/context.js';

const ev = '[surface=linux-shell ok=0 bytes=9000 ms=3 proof=sha256:ab]';
const log = (n, err) => Array.from({ length: n }, (_, i) => (i === 300 && err ? 'ERROR: build step failed at module 300' : `line ${i} ok`)).join('\n');

describe('content-aware trimResult', () => {
  it('keeps an error from the middle and the exit code at the end', () => {
    const t = trimResult(`${log(600, true)}\nprocess exit code 2\n\n${ev}`);
    expect(t).toContain('ERROR: build step failed at module 300');
    expect(t).toContain('exit code 2');
    expect(t).toContain('line 0 ok');
    expect(t).toMatch(/older tool result trimmed: \d+ chars/);
  });
  it('keeps head and tail when there are no errors', () => {
    const t = trimResult(log(600, false));
    expect(t.startsWith('line 0 ok')).toBe(true);
    expect(t).toContain('line 599 ok');
    expect(t).not.toContain('line 300 ok');
  });
  it('is deterministic', () => {
    const r = `${log(600, true)}\n${ev}`;
    expect(trimResult(r)).toBe(trimResult(r));
  });
  it('stays within 900 chars plus the note', () => {
    const noisy = Array.from({ length: 200 }, (_, i) => `error ${i}: ${'y'.repeat(300)}`).join('\n');
    const t = trimResult(`${noisy}\n${ev}`);
    const body = t.slice(0, t.indexOf('\n… [older tool result trimmed'));
    expect(body.length).toBeLessThanOrEqual(900);
  });
  it('keeps the evidence line and short results as they are', () => {
    expect(trimResult(`${log(600, true)}\n\n${ev}`).endsWith(ev)).toBe(true);
    expect(trimResult('short')).toBe('short');
    const edge = 'a'.repeat(1500);
    expect(trimResult(edge)).toBe(edge);
  });
});
