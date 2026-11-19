import { describe, it, expect } from 'vitest';
import { NONINTERACTIVE_ENV, withNonInteractive, promptHint } from '../../src/shellhints.js';

describe('promptHint', () => {
  it.each([
    ['[sudo] Password: '],
    ['Enter passphrase for key /root/.ssh/id: '],
    ['Do you want to continue? [Y/n] '],
    ['Are you sure you want to continue connecting (yes/no/[fingerprint])? '],
    ['Press any key to continue'],
    ["Username for 'https://github.com': "],
    ['Continue? '],
    ['Python 3.11\n>>> '],
    ['> '],
  ])('hints on %j', (t) => expect(promptHint('some output\n' + t)).toMatch(/^Hint:/));
  it.each([
    ['the password: was rejected, retrying\nnext line\n'],
    ['Password: ok\nDone\n'],
    ['all good\n'],
    [''],
    ['a > b'],
    ['Do you want to continue? [Y/n]\nyes\n'],
  ])('is silent on %j', (t) => expect(promptHint(t)).toBeNull());
  it('names the fix', () => {
    expect(promptHint('Proceed [Y/n] ')).toContain('-y');
    expect(promptHint('(yes/no) ')).toContain('BatchMode');
    expect(promptHint('Password: ')).toContain('shell_job kill');
  });
});

describe('withNonInteractive', () => {
  it('prefixes once', () => {
    const a = withNonInteractive('ls');
    expect(a).toBe(NONINTERACTIVE_ENV + ' ls');
    expect(withNonInteractive(a)).toBe(a);
  });
});
