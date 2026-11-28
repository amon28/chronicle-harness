import { describe, it, expect } from 'vitest';
import { NONINTERACTIVE_ENV, withNonInteractive, promptHint, killedHint } from '../../src/shellhints.js';

describe('killedHint (decision 274)', () => {
  it('on exit 137 or "Killed" at the end of a failed command: Android, fewer workers, the developer option', () => {
    const h = killedHint('building…\n', 137);
    expect(h).toMatch(/^Hint: the command was killed from outside.*phantom process.*--maxsockets.*maxForks=1.*make -j1.*Disable child process restrictions/s);
    expect(killedHint('npm ERR!\nsh: line 1: 4242 Killed                  node build.js\n', 1)).toMatch(/^Hint/);
    expect(killedHint('Killed\n', 2)).toMatch(/^Hint/);
  });
  it('silent otherwise', () => {
    expect(killedHint('all good\n', 0)).toBeNull();
    expect(killedHint('Killed 3 stale processes\nDone\n', 0)).toBeNull();
    expect(killedHint('error: not found\n', 1)).toBeNull();
    expect(killedHint('', null)).toBeNull();
  });
  it('a password prompt names the full terminal for a one-time setup', () => expect(promptHint('alex@nas password: ')).toMatch(/ssh-copy-id.*full terminal/));
});

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
