// The "done" check: an agent turn that changed files and then finished without running anything that looks at them
// (a test, the script, a preview, a served page in the browser, the user's hook) is sent back once to check them, or
// to say plainly that they are unchecked. Pure logic; engine.js feeds it every tool call of the turn.
import { shellChecks } from './shellguard.js';

const FILE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'move_file']);
const PHONE_TOOLS = new Set(['phone_write']);
const CHECK_TOOLS = new Set(['run_python', 'preview_page', 'shell_job']);
// files nobody runs: notes, docs, captures and spilled output do not need a check
const NOT_CODE = /(^|\/)\.out\/|^output\/screenshots\/|^downloads\/|\.(md|markdown|txt|rst|log)$/i;
const SERVED = /^(https?:\/\/)?(127\.0\.0\.1|localhost|0\.0\.0\.0|[\w-]+\.workspace\.localhost)([:/]|$)|^\/?workspace\//i;

const argsOf = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
};

/** Is this call one that checks work (runs, tests, previews)? `served` = the browser is on a page the agent serves. */
export function isCheckCall(name, rawArgs, { served = false } = {}) {
  const args = argsOf(rawArgs);
  if (CHECK_TOOLS.has(name)) return true;
  if (name === 'shell') return shellChecks(String(args.command || ''));
  if (name === 'browser') return SERVED.test(String(args.url || '')) || (served && !['open', 'close', 'back'].includes(String(args.action || '')));
  return false;
}

/** The evidence line a tool result ends with ([surface=… ok=… exit=…]) as an object, or null. */
export function evidenceOf(result) {
  const m = /\[(surface=[^\]]*)\]\s*$/.exec(String(result || ''));
  if (!m) return null;
  return Object.fromEntries(m[1].split(/\s+/).map((kv) => kv.split('=')).filter((x) => x.length >= 2).map(([k, ...v]) => [k, v.join('=')]));
}

/**
 * Did a check really run? A failing test is a check; a call that never ran (blocked, switched off, no Linux) is not.
 * A shell command ran when its evidence line has an exit code or a job.
 */
export function checkRan(name, result, { blocked = false } = {}) {
  if (blocked) return false;
  const ev = evidenceOf(result);
  if (name === 'shell' || name === 'shell_job') return !!ev && (ev.exit != null || !!ev.job);
  return !ev || ev.ok === '1' || /\bexit code|Traceback|Error:/.test(String(result || '').slice(0, 4000));
}

/**
 * Which workspace files were written or edited between two snapshots ({ path: fileObject }), leaving out ones that need
 * no check. Deleting files is not a change to check (there is nothing left to run), and a file that was only moved or
 * renamed (the same bytes under a new name) is not either.
 */
export function changedPaths(before, after) {
  if (!before || !after) return [];
  // what was there before, by its bytes: a move keeps them (often the same array), a shell `mv` keeps their content
  const bySize = new Map();
  for (const f of Object.values(before)) {
    const d = f?.data;
    if (d?.length == null) continue;
    if (!bySize.has(d.length)) bySize.set(d.length, []);
    bySize.get(d.length).push(d);
  }
  const same = (a, b) => a === b || (a.length <= 1 << 20 && a.every((x, i) => x === b[i]));
  const wasThere = (f) => {
    const d = f?.data;
    return d?.length != null && (bySize.get(d.length) || []).some((o) => same(d, o));
  };
  const out = [];
  for (const [p, f] of Object.entries(after)) if (before[p] !== f && !wasThere(f)) out.push(p);
  return out.filter((p) => !NOT_CODE.test(p));
}

/**
 * Follows one turn. record() each finished call with the workspace paths it changed (changedPaths) and whether the
 * user's post-tool hook ran on it, or whether a check ran inside it (a script's or helper's own calls); checked() when
 * something else checked the work (a stop hook). pending() → the files changed since the last check.
 */
export function workTracker() {
  const changed = new Map(); // path → the tool that changed it
  let served = false;
  return {
    record(name, rawArgs, { ok = true, paths = [], hookRan = false, innerCheck = false, ran = true } = {}) {
      const args = argsOf(rawArgs);
      if (name === 'browser' && args.url && ran) served = SERVED.test(String(args.url));
      if ((ran && isCheckCall(name, args, { served })) || innerCheck) {
        changed.clear();
        return;
      }
      if (hookRan) {
        changed.clear(); // the user's own check ran on it (a formatter, a linter): it was looked at
        return;
      }
      if (PHONE_TOOLS.has(name)) {
        if (ok && args.path && !NOT_CODE.test(String(args.path))) changed.set('/phone/' + String(args.path).replace(/^\/+/, ''), name);
        return;
      }
      // file tools, a shell command that only wrote files, a script or helper that changed files without running any
      for (const p of paths) changed.set(p, name);
      if (FILE_TOOLS.has(name) && !paths.length) return; // it failed or changed nothing
    },
    checked() {
      changed.clear();
    },
    pending() {
      return [...changed.keys()];
    },
  };
}

/** The system note the assistant gets when it finished without checking what it changed. */
export function doneCheckNote(paths) {
  const list = paths.slice(0, 8).join(', ') + (paths.length > 8 ? ` and ${paths.length - 8} more` : '');
  return `[Done check – from the app, not the user] This turn you wrote or edited exactly these files: ${list} – and ran nothing after. These are all of them: do not look for other changes. Check ${paths.length === 1 ? 'it' : 'them'} now (run, test, preview), or tell the user plainly that ${paths.length === 1 ? 'it is' : 'they are'} unchecked. Do not just repeat your answer.`;
}
