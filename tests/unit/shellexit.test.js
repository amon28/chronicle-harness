import { describe, it, expect } from 'vitest';
import { finishedResult } from '../../src/shell.js';

describe('a command that ends the shell itself', () => {
  it('says the exit code it ended with (exit 3 is a failure, exit 0 is not)', () => {
    const bad = finishedResult({ output: 'about to fail', exit: 3, ended: true });
    expect(bad.ok).toBe(false);
    expect(bad.result).toMatch(/^exit code 3 – the command ended the shell itself/);
    expect(finishedResult({ output: '', exit: 0, ended: true }).ok).toBe(true);
    const unknown = finishedResult({ output: '', exit: -1, ended: true });
    expect(unknown.ok).toBe(false);
    expect(unknown.result).toMatch(/^the command ended the shell itself/);
  });
});
