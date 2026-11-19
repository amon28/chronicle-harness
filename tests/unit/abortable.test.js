import { describe, it, expect, vi } from 'vitest';
import { abortable } from '../../src/abortable.js';

const never = () => new Promise(() => {});
describe('a stuck tool cannot freeze the reply', () => {
  it('Stop (abort) ends the wait at once and runs the cleanup', async () => {
    const ac = new AbortController();
    const cleanup = vi.fn();
    const p = abortable(never(), ac.signal, 0, cleanup);
    ac.abort();
    await expect(p).rejects.toThrow('Stopped');
    expect(cleanup).toHaveBeenCalled();
  });
  it('a time limit ends it too', async () => {
    await expect(abortable(never(), new AbortController().signal, 20)).rejects.toThrow(/did not finish within/);
  });
  it('a normal result passes through', async () => {
    await expect(abortable(Promise.resolve(5), new AbortController().signal, 1000)).resolves.toBe(5);
  });
});
