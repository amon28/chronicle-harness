// A big answer from the native side comes as a file in cache/bridge: once the page has read it, it is deleted (it used
// to stay until a sweep 15 minutes later on the next big answer – 100 MB downloads piled up in the cache).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bridgeBytes } from '../../src/bridgebytes.js';

let released, realFetch;
beforeEach(() => {
  released = [];
  globalThis.__ocmReleaseBytes = (p) => released.push(p);
  realFetch = globalThis.fetch;
});
afterEach(() => {
  delete globalThis.__ocmReleaseBytes;
  globalThis.fetch = realFetch;
});

describe('bytes handed over as a cache file', () => {
  it('are read, then the file is let go', async () => {
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
    const b = await bridgeBytes({ path: '/data/user/0/app/cache/bridge/b1.bin' });
    expect([...b]).toEqual([1, 2, 3]);
    expect(released).toEqual(['/data/user/0/app/cache/bridge/b1.bin']);
  });
  it('a renamed key works the same', async () => {
    globalThis.fetch = async () => new Response(new Uint8Array([9]));
    await bridgeBytes({ bodyPath: '/c/bridge/b2.bin' }, { b64Key: 'bodyB64', pathKey: 'bodyPath' });
    expect(released).toEqual(['/c/bridge/b2.bin']);
  });
  it('base64 has no file to let go', async () => {
    expect([...(await bridgeBytes({ base64: btoa('ab') }))]).toEqual([97, 98]);
    expect(released).toEqual([]);
  });
});
