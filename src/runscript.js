// run_script: the assistant writes a short JavaScript program that calls its tools in a loop (read 40 files, grep,
// edit each, run the tests) and gets back only what the program prints – one step instead of forty, and the bulky
// intermediate results never enter the context. The program runs in a sandboxed iframe (opaque origin, no network,
// no storage, no access to the app); every tool call goes through postMessage to the same runTool the assistant uses,
// with the same checks.

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const SCRIPT_MAX_CALLS = 200;
export const SCRIPT_TIMEOUT_S = 300;
// what a script cannot call: talking to the user, nesting scripts or helpers, changing the plan or what is installed
export const SCRIPT_BLOCKED = new Set(['run_script', 'claude_code', 'ask_user', 'propose_plan', 'delegate', 'ralph_loop', 'goal', 'todo_write', 'schedule_task', 'save_tool', 'save_mod', 'save_skill', 'edit_skill', 'save_persona', 'save_character', 'save_lorebook', 'edit_persona', 'edit_lorebook', 'manage_mod', 'memory', 'saved_tools', 'shortcuts', 'manage_mcp', 'phone_folder', 'reload_tools']);

export const scriptDefs = () => [
  fn(
    'run_script',
    'Run a short JavaScript program (async, in a sandbox without network) that calls your tools and prints a compact result – for repetitive work across many files or items: `for (const f of (await tools.glob_files({pattern:"src/**/*.js"})).paths) { … }` (glob_files also gives `paths`, the matching files as a list; its result text ends with notes after the "path<TAB>size" lines, so do not parse that text as file names). Call a tool with `await tools.NAME(args)` → `{ ok, result }` (result is the text you would get). print(...) / console.log(...) is what you get back; a returned value is printed too. Independent calls can run at once: `await Promise.all(paths.map((path) => tools.read_file({ path })))`. Use it when you would otherwise make three or more similar calls, or to keep only the part you need of a big result (a long listing, a large file, JSON); for one or two calls just call the tool.',
    {
      code: { type: 'string', description: 'The body of an async function. Example: const r = await tools.grep_files({ pattern: "TODO" }); print(r.result.split("\\n").length + " hits")' },
      timeout_s: { type: 'integer', description: `Most seconds it may run (default 120, at most ${SCRIPT_TIMEOUT_S})` },
    },
    ['code'],
  ),
];

export const scriptPrompt = () =>
  '- Code mode: when you would make three or more similar tool calls (go through 30 files, check every link, rename across a project), or a call would return much more than you need (a long listing, a big file, raw JSON), write one run_script instead: it loops, filters and prints only what you need – fewer steps and a much smaller context. Run independent calls together with Promise.all. Keep scripts simple; for one or two calls, call the tool directly.';

/** The page the sandbox loads: a CSP that allows only this inline script; tools are proxied to the parent. */
export function scriptDocument(token, code) {
  // The script talks to the app only through a MessagePort the app hands over before the script starts (decision 273):
  // a sandboxed frame can still load another page into itself (location = …), and that page – the same window to
  // the app, origin "null" like this one – could otherwise keep calling tools with the token it was sent along. The new
  // page never gets the port. Loading another page is also cancelled (Navigation API, where the WebView has it), and
  // a page that goes anyway says so on its way out, so the run is stopped.
  const shim = `(() => {
  const T = ${JSON.stringify(token)};
  const pending = new Map();
  let seq = 0;
  let send = null;
  const out = (m) => send && send(Object.assign({ __script: T }, m));
  try { if (typeof navigation !== 'undefined') navigation.addEventListener('navigate', (e) => { if (e.cancelable) e.preventDefault(); }); } catch (e) { /* no Navigation API: the pagehide below tells the app */ }
  addEventListener('pagehide', () => out({ type: 'left' }));
  const fmt = (v) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v, null, 1); } catch (e) { return String(v); } })());
  const print = (...a) => out({ type: 'print', text: a.map(fmt).join(' ') });
  const console = { log: print, info: print, warn: print, error: (...a) => print('[error]', ...a), debug: print };
  const gotPort = new Promise((resolve) => {
    const take = (e) => {
      const m = e.data;
      if (e.source !== parent || !m || m.__host !== T || m.type !== 'port' || !e.ports || !e.ports[0]) return;
      removeEventListener('message', take);
      resolve(e.ports[0]);
    };
    addEventListener('message', take);
  });
  parent.postMessage({ __script: T, type: 'hello' }, '*');
  const call = (name, args) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); out({ type: 'call', id, name: String(name), args: args || {} }); });
  const tools = new Proxy({}, { get: (_, name) => (name === 'then' ? undefined : (args) => call(name, args)) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  gotPort.then((port) => {
    send = port.postMessage.bind(port);
    port.onmessage = (e) => {
      const m = e.data;
      if (!m || m.__host !== T) return;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      p(m.res);
    };
    return (async () => { /*CODE*/ })();
  }).then(
    (v) => out({ type: 'done', value: v === undefined ? undefined : fmt(v) }),
    (err) => out({ type: 'error', error: String((err && err.stack) || err).slice(0, 1500) }),
  );
})();`;
  const body = shim.replace('/*CODE*/', () => String(code));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'"></head><body><script>${body.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}

/**
 * The app's side of a sandboxed frame's MessagePort (decision 273; mods use it too). The frame's first message, a
 * "hello" from its own page (sent before any of its code runs), is answered with a port; from then on only the port
 * counts – window messages are not listened to any more, so a page the frame navigated to can neither send nor
 * receive anything. tag: the key carrying the token ('__script', '__mod'). A "left" message (the frame's page went
 * away) goes to onLeft. → { post, close }
 */
export function frameChannel(frame, { tag, token, onMessage, onLeft, win = window }) {
  let port = null;
  let closed = false;
  const hello = (e) => {
    const m = e.data;
    if (port || closed || !frame.contentWindow || e.source !== frame.contentWindow || !m || m[tag] !== token || m.type !== 'hello') return;
    win.removeEventListener('message', hello);
    const ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = (ev) => {
      const d = ev.data;
      if (closed || !d || d[tag] !== token) return;
      if (d.type === 'left') {
        close();
        onLeft?.();
      } else onMessage(d);
    };
    frame.contentWindow.postMessage({ __host: token, type: 'port' }, '*', [ch.port2]);
  };
  const close = () => {
    closed = true;
    win.removeEventListener('message', hello);
    port?.close();
  };
  win.addEventListener('message', hello);
  return { post: (m) => !closed && port?.postMessage(m), close };
}

/** Runs the document in a hidden sandboxed iframe; → a handle the bridge talks to. (Browser only.) */
function iframeRunner(doc, onMessage, token) {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
  const ch = frameChannel(f, { tag: '__script', token, onMessage, onLeft: () => onMessage({ __script: token, type: 'left' }) });
  f.srcdoc = doc;
  document.body.append(f);
  return {
    post: ch.post,
    stop: () => {
      ch.close();
      f.remove();
    },
  };
}

/**
 * Run a script. callTool({ name, arguments }) runs one tool like the assistant would. `runner` is the sandbox
 * (an iframe in the app; tests pass their own).
 * → { ok, result, display }
 */
export async function runScript(args, { callTool, signal, onStatus, runner = iframeRunner } = {}) {
  const code = String(args.code || '');
  if (!code.trim()) throw new Error('code is required');
  const limitS = Math.max(1, Math.min(SCRIPT_TIMEOUT_S, Number(args.timeout_s) || 120));
  const token = 's' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const printed = [];
  let size = 0;
  const calls = [];
  const steps = []; // what the card shows: each call, what it was about, and whether it worked
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    let handle = null;
    let finished = false;
    const finish = (ok, tail) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      handle?.stop();
      const used = calls.length ? `[${calls.length} tool call${calls.length === 1 ? '' : 's'}: ${summarize(calls)}]` : '[no tool calls]';
      const text = [printed.join('\n').trim(), tail].filter(Boolean).join('\n') || '(the script printed nothing – print() what you need back)';
      resolve({ ok, result: `${text}\n\n${used}`, display: { code, output: text.slice(0, 6000), ms: Date.now() - startedAt, calls: calls.length, steps: steps.slice(0, STEPS_SHOWN), more: Math.max(0, steps.length - STEPS_SHOWN) } });
    };
    const onAbort = () => finish(false, '[stopped]');
    signal?.addEventListener?.('abort', onAbort);
    const timer = setTimeout(() => finish(false, `[stopped: the script ran longer than ${limitS}s]`), limitS * 1000);
    const onMessage = async (m) => {
      if (!m || m.__script !== token || finished) return;
      if (m.type === 'print') {
        if (size < 200000) printed.push(m.text);
        size += m.text.length;
      } else if (m.type === 'done') finish(true, m.value !== undefined ? m.value : '');
      else if (m.type === 'error') finish(false, `[error] ${m.error}`);
      else if (m.type === 'left') finish(false, '[stopped: the script loaded another page into its sandbox – a script runs only in its own page, so it was ended]');
      else if (m.type === 'call') {
        const name = String(m.name || '');
        let res;
        if (SCRIPT_BLOCKED.has(name)) res = { ok: false, result: `${name} cannot be called from a script – call it directly.` };
        else if (calls.length >= SCRIPT_MAX_CALLS) res = { ok: false, result: `A script may make at most ${SCRIPT_MAX_CALLS} tool calls.` };
        else {
          calls.push(name);
          const step = { name, label: stepLabel(m.args), status: 'running' };
          steps.push(step);
          onStatus?.(`script · ${calls.length} call${calls.length === 1 ? '' : 's'} · ${name}`);
          try {
            const r = await callTool({ id: `${token}-${calls.length}`, name, arguments: JSON.stringify(m.args ?? {}) });
            res = { ok: !!r.ok, result: String(r.result ?? '').replace(/\n*\[surface=[^\]]*\]\s*$/, '') };
            if (Array.isArray(r.paths)) res.paths = r.paths; // glob_files: the files as a list, so a script need not parse the text
          } catch (e) {
            res = { ok: false, result: `Error: ${e?.message || e}` };
          }
          step.status = res.ok ? 'done' : 'error';
        }
        if (!finished) handle.post({ __host: token, id: m.id, res });
      }
    };
    try {
      handle = runner(scriptDocument(token, code), onMessage, token);
    } catch (e) {
      finish(false, `[could not start the sandbox: ${e?.message || e}]`);
    }
  });
}

const STEPS_SHOWN = 60;
/** One line about a call: its path, pattern, command, address or query – what the card lists. */
function stepLabel(a) {
  if (!a || typeof a !== 'object') return '';
  const v = a.path ?? a.pattern ?? a.command ?? a.url ?? a.query ?? a.urls?.[0] ?? a.name ?? '';
  const t = String(v).replace(/\s+/g, ' ').trim();
  return t.length > 70 ? t.slice(0, 69) + '…' : t;
}

const summarize = (names) => {
  const n = new Map();
  for (const x of names) n.set(x, (n.get(x) || 0) + 1);
  return [...n].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join(', ');
};
