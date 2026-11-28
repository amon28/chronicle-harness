/* Python sandbox: Pyodide (CPython compiled to WebAssembly) in a Web Worker.
 * It has its own in-memory filesystem with the chat's files under /workspace,
 * no access to the app, the phone's storage or your API key (lockDown below: decision 273).
 * Messages in:  {type:'init', indexURL, files:[{path,data,mode?,exec?}]}
 *               {type:'write', files:[{path,data,mode?,exec?}]} | {type:'delete', paths:[]}
 *               {type:'run', id, code}
 * Messages out: {type:'ready'} | {type:'status', text}
 *               {type:'result', id, stdout, stderr, error, value, changed:[{path,data,mode,exec}], deleted:[], ms}
 *               {type:'wrote', id, path, data, mode, exec, mtime} | {type:'gone', id, path}  (while a run goes, below)
 */
let pyodide = null;
let readyPromise = null;
const ROOT = '/workspace';

// While code runs, every file it finishes writing (closed, renamed into place) or deletes is sent out at once, so a
// run that is stopped mid-way (Stop, a cancelled ask_model job, a time-out) keeps what it had already written – the
// worker is ended then and its own copy is gone (decision 183). A file written over and over (a log appended line by
// line) is sent every time for its first 10 writes, then at most once a second; no more than LIVE_MAX bytes per run in
// all. The run's own result, when it ends normally, has everything anyway.
const LIVE_MAX = 48 * 1024 * 1024;
const LIVE_FILE = 16 * 1024 * 1024;
let live = null; // { id, sent: Map(path -> { at, n }), bytes }
// files the app put in (or took out) while a run went on – another job's file, Claude Code's edit (decision 188): they
// are not what this run wrote, unless the run changed them again afterwards. path -> the file's signature then (null: gone)
let outside = null;
let fromApp = false; // the app is writing files in right now (not the run's own writes)
const inRoot = (p) => typeof p === 'string' && p.startsWith(ROOT + '/') && !p.includes('/__pycache__/');
function sendLive(full) {
  if (!live || fromApp || !inRoot(full)) return;
  try {
    const st = pyodide.FS.stat(full);
    if (pyodide.FS.isDir(st.mode) || st.size > LIVE_FILE || live.bytes + st.size > LIVE_MAX) return;
    const path = full.slice(ROOT.length + 1);
    const t = Date.now();
    const last = live.sent.get(path) || { at: 0, n: 0 };
    if (last.n >= 10 && t - last.at < 1000) return;
    live.sent.set(path, { at: t, n: last.n + 1 });
    live.bytes += st.size;
    const data = pyodide.FS.readFile(full);
    const mode = st.mode & 0o777 & ~0o022;
    const mt = st.mtime?.getTime?.() ?? Number(st.mtime);
    self.postMessage({ type: 'wrote', id: live.id, path, data, mode, exec: (mode & 0o111) !== 0, ...(mt > 0 ? { mtime: mt } : {}) }, [data.buffer]);
  } catch {
    /* gone again, or unreadable: the run's result has it */
  }
}
function watchFiles() {
  const FS = pyodide.FS;
  const abs = (p) => (String(p).startsWith('/') ? String(p) : FS.cwd() + '/' + p);
  const close = FS.close;
  FS.close = function (stream) {
    const path = stream?.path;
    const wrote = !!stream && (stream.flags & 3) !== 0; // O_WRONLY or O_RDWR
    const r = close.apply(this, arguments);
    if (wrote && live) sendLive(path);
    return r;
  };
  const rename = FS.rename;
  FS.rename = function (from, to) {
    const r = rename.apply(this, arguments);
    if (live) {
      const a = abs(from);
      if (inRoot(a)) self.postMessage({ type: 'gone', id: live.id, path: a.slice(ROOT.length + 1) });
      live.sent.delete(abs(to).slice(ROOT.length + 1));
      sendLive(abs(to));
    }
    return r;
  };
  const unlink = FS.unlink;
  FS.unlink = function (p) {
    const r = unlink.apply(this, arguments);
    const a = abs(p);
    if (live && !fromApp && inRoot(a)) self.postMessage({ type: 'gone', id: live.id, path: a.slice(ROOT.length + 1) });
    return r;
  };
}

function mkdirp(path) {
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    try {
      pyodide.FS.mkdir(cur);
    } catch {
      /* exists */
    }
  }
}

function writeFiles(files) {
  for (const f of files) {
    const full = ROOT + '/' + f.path.replace(/^\/+/, '');
    mkdirp(full.slice(0, full.lastIndexOf('/')));
    pyodide.FS.writeFile(full, f.data);
    // the file's own date, not the moment it was copied in (os.stat, os.path.getmtime)
    if (f.mtime > 0) {
      try {
        pyodide.FS.utime(full, f.mtime, f.mtime);
      } catch {
        /* keep the copy time */
      }
    }
    // the permission bits travel with the file: a script the app made executable must run here too,
    // and a 644 or a 600 must arrive as it is (0o666 - emscripten's default - added the write bits
    // back, so a file the shell had protected arrived writable). A caller that only knows the exec
    // bit still gets 755/644.
    if (typeof f.mode === 'number') pyodide.FS.chmod(full, f.mode & 0o777);
    else if (typeof f.exec === 'boolean') pyodide.FS.chmod(full, f.exec ? 0o755 : 0o644);
  }
}

function snapshot() {
  const out = new Map();
  const walk = (dir) => {
    let names = [];
    try {
      names = pyodide.FS.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === '.' || n === '..' || n === '__pycache__') continue;
      const full = dir + '/' + n;
      const st = pyodide.FS.stat(full);
      const isDir = pyodide.FS.isDir(st.mode);
      // the mode is part of the identity, so an os.chmod with the same bytes is still a change
      const mode = st.mode & 0o777;
      if (isDir) walk(full);
      else out.set(full.slice(ROOT.length + 1), `${st.mtime?.getTime?.() ?? st.mtime}:${st.size}:${mode.toString(8)}`);
    }
  };
  walk(ROOT);
  return out;
}

/** One file's signature, as snapshot() writes it (null: not there). */
function sigOf(path) {
  try {
    const st = pyodide.FS.stat(ROOT + '/' + path);
    return `${st.mtime?.getTime?.() ?? st.mtime}:${st.size}:${(st.mode & 0o777).toString(8)}`;
  } catch {
    return null;
  }
}

// What Python can reach of JavaScript (decision 273). This worker runs on the app's own origin, so with Pyodide's
// default (`js` = globalThis) a script could open js.indexedDB – every chat, the settings – or send anything anywhere
// with js.fetch. Two layers: Python's `js` module is a short list (what Pyodide's own Python code imports from it:
// timers for asyncio, the fetch classes for pyodide.http/micropip, a few constructors), and – because any JS object
// leads to the Function constructor (js.Object.constructor('return self')()) – the worker itself is stripped of
// storage and network after Pyodide has loaded: no IndexedDB, Cache Storage, OPFS, BroadcastChannel, XHR, WebSocket,
// EventSource, nested workers or importScripts, and fetch only downloads packages (Pyodide's own from indexURL,
// micropip's from PyPI) with GET. What is left: import() of a remote script (syntax, not a global – only a CSP header
// on this file could stop it); with the storage gone, it can carry nothing but the chat's own files, which Python has
// by design.
const realFetch = typeof self.fetch === 'function' ? self.fetch.bind(self) : null;
const PACKAGE_HOSTS = ['pypi.org', 'files.pythonhosted.org'];
function packageUrl(url, indexURL) {
  let u;
  try {
    u = new URL(String(url), indexURL);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (indexURL && u.href.startsWith(indexURL)) return true;
  return u.protocol === 'https:' && PACKAGE_HOSTS.includes(u.hostname);
}
function packageFetch(indexURL) {
  return function fetch(input, init) {
    const isReq = typeof Request === 'function' && input instanceof Request;
    const url = isReq ? input.url : String(input);
    const method = String((init && init.method) || (isReq ? input.method : '') || 'GET').toUpperCase();
    if (!realFetch || (method !== 'GET' && method !== 'HEAD') || !packageUrl(url, indexURL))
      return Promise.reject(new TypeError(`Python cannot reach ${url.slice(0, 80)} – the sandbox only downloads packages (Pyodide's and PyPI's).`));
    return realFetch(input, { ...(init || {}), credentials: 'omit' });
  };
}
function pythonGlobals(indexURL) {
  const g = Object.create(null);
  const names = ['Object', 'Array', 'ArrayBuffer', 'DataView', 'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Date', 'Map', 'Set', 'WeakRef', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Symbol', 'BigInt', 'Error', 'TypeError', 'Promise', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'AbortController', 'AbortSignal', 'Request', 'Response', 'Headers', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Blob', 'console', 'performance'];
  for (const n of names) if (self[n] !== undefined) g[n] = typeof self[n] === 'function' && /^[a-z]/.test(n) ? self[n].bind(self) : self[n];
  g.fetch = packageFetch(indexURL);
  return g;
}
const CUT = ['indexedDB', 'caches', 'cookieStore', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'BroadcastChannel', 'Worker', 'SharedWorker', 'importScripts'];
const CUT_NAV = ['storage', 'locks', 'serviceWorker'];
function strip(obj, name) {
  for (let o = obj; o; o = Object.getPrototypeOf(o))
    if (Object.prototype.hasOwnProperty.call(o, name))
      try {
        delete o[name];
      } catch {
        /* not configurable: shadowed below */
      }
}
function cut(obj, name) {
  strip(obj, name);
  if (obj[name] !== undefined)
    try {
      Object.defineProperty(obj, name, { value: undefined, writable: false, configurable: false });
    } catch {
      /* left as it is */
    }
}
function lockDown(indexURL) {
  for (const n of CUT) cut(self, n);
  if (self.navigator) for (const n of CUT_NAV) cut(self.navigator, n);
  // Pyodide's loader calls the global fetch for each package: it gets the package-only one, which nothing can replace
  strip(self, 'fetch');
  const guarded = packageFetch(indexURL);
  try {
    Object.defineProperty(self, 'fetch', { value: guarded, writable: false, configurable: false });
  } catch {
    self.fetch = guarded;
  }
  // fail closed: a browser where something could not be taken away gets no Python rather than an open one
  const left = [...CUT.filter((n) => self[n] !== undefined), ...(self.navigator ? CUT_NAV.filter((n) => self.navigator[n] !== undefined) : [])];
  if (self.fetch !== guarded) left.push('fetch');
  if (left.length) throw new Error(`Python could not be shut off from ${left.join(', ')} – it does not run here.`);
}

async function init(indexURL, files) {
  self.postMessage({ type: 'status', text: 'Loading Python…' });
  // module worker: Pyodide 314+ no longer supports classic workers
  const { loadPyodide } = await import(indexURL + 'pyodide.mjs');
  pyodide = await loadPyodide({ indexURL, jsglobals: pythonGlobals(indexURL) });
  lockDown(indexURL);
  mkdirp(ROOT);
  pyodide.FS.chdir(ROOT);
  writeFiles(files || []);
  watchFiles();
  await pyodide.runPythonAsync(`
import sys, os
os.environ['MPLBACKEND'] = 'Agg'
os.chdir('${ROOT}')
sys.path.insert(0, '${ROOT}')
`);
  self.postMessage({ type: 'ready' });
}

async function run(id, code) {
  const t0 = performance.now();
  const stdout = [];
  const stderr = [];
  pyodide.setStdout({ batched: (s) => stdout.push(s) });
  pyodide.setStderr({ batched: (s) => stderr.push(s) });
  const before = snapshot();
  live = { id, sent: new Map(), bytes: 0 };
  outside = new Map();
  let error = null;
  let value = null;
  try {
    pyodide.runPython(`import os; os.chdir('${ROOT}')`);
    self.postMessage({ type: 'status', text: 'Loading packages…' });
    await pyodide.loadPackagesFromImports(code, { messageCallback: (m) => self.postMessage({ type: 'status', text: m }) });
    self.postMessage({ type: 'status', text: 'Running…' });
    const r = await pyodide.runPythonAsync(code);
    if (r !== undefined && r !== null) {
      try {
        value = String(r.toString ? r.toString() : r);
      } catch {
        value = String(r);
      }
      if (r && r.destroy) r.destroy();
    }
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }
  live = null;
  const after = snapshot();
  const theirs = outside;
  outside = null;
  const changed = [];
  for (const [path, sig] of after) {
    // put in by the app while it ran and not changed by the run since: not this run's file
    if (theirs.has(path) && theirs.get(path) === sig) continue;
    if (before.get(path) !== sig) {
      try {
        const st = pyodide.FS.stat(ROOT + '/' + path);
        // emscripten has no umask, so every open() makes a 0o666 file: report it the way a umask of 022
        // would, or each file Python writes would reach the shell group- and world-writable
        const mode = st.mode & 0o777 & ~0o022;
        const mt = st.mtime?.getTime?.() ?? Number(st.mtime);
        changed.push({ path, data: pyodide.FS.readFile(ROOT + '/' + path), mode, exec: (mode & 0o111) !== 0, ...(mt > 0 ? { mtime: mt } : {}) });
      } catch {
        /* unreadable */
      }
    }
  }
  const deleted = [...before.keys()].filter((p) => !after.has(p) && !(theirs.has(p) && theirs.get(p) === null));
  self.postMessage(
    { type: 'result', id, stdout: stdout.join('\n'), stderr: stderr.join('\n'), error, value, changed, deleted, ms: Math.round(performance.now() - t0) },
    changed.map((c) => c.data.buffer),
  );
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      readyPromise = init(m.indexURL, m.files);
      await readyPromise;
    } else if (m.type === 'write') {
      await readyPromise;
      fromApp = true;
      try {
        writeFiles(m.files);
      } finally {
        fromApp = false;
      }
      if (outside) for (const f of m.files) outside.set(f.path.replace(/^\/+/, ''), sigOf(f.path.replace(/^\/+/, '')));
    } else if (m.type === 'delete') {
      await readyPromise;
      if (outside) for (const p of m.paths) outside.set(p, null);
      fromApp = true; // the unlink hook must not report the app's own delete as the run's
      try {
      for (const p of m.paths) {
        try {
          pyodide.FS.unlink(ROOT + '/' + p);
        } catch {
          /* gone */
        }
        // then the directories it was the last file in, so a delete does not leave an empty tree
        let dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        while (dir) {
          try {
            pyodide.FS.rmdir(ROOT + '/' + dir);
          } catch {
            break;
          }
          dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
        }
      }
      } finally {
        fromApp = false;
      }
    } else if (m.type === 'run') {
      await readyPromise;
      await run(m.id, m.code);
    }
  } catch (err) {
    self.postMessage({ type: m.type === 'run' ? 'result' : 'fatal', id: m.id, error: String(err && err.message ? err.message : err), stdout: '', stderr: '', changed: [], deleted: [] });
  }
};
