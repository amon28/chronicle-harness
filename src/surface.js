// Every tool result says which surface answered, how big it was, how long it took - and, when it
// claims success, carries proof. A check that reports ok without exercising the path is the bug this
// exists to stop: an untested "ok" reads the same as a tested one otherwise.
import { sha256Hex, shortHash } from './hash.js';

/** tool name -> the surface that actually did the work. */
export const SURFACES = {
  shell: 'linux-shell',
  shell_job: 'linux-shell',
  doctor: 'harness',
  run_python: 'pyodide',
  fetch_url: 'http',
  web_search: 'http',
  screenshot_page: 'render-service',
  browser: 'android-webview',
  preview_page: 'android-webview',
  phone_folder: 'phone-folder',
  phone_list: 'phone-folder',
  phone_read: 'phone-folder',
  phone_import: 'phone-folder',
  phone_write: 'phone-folder',
  phone_delete: 'phone-folder',
  read_file: 'workspace',
  write_file: 'workspace',
  edit_file: 'workspace',
  grep_files: 'workspace',
  glob_files: 'workspace',
  list_files: 'workspace',
  delete_file: 'workspace',
  view_images: 'workspace',
  reload_tools: 'harness',
};

export function surfaceOf(tool) {
  if (SURFACES[tool]) return SURFACES[tool];
  if (tool.startsWith('mcp_')) return 'mcp';
  if (tool.startsWith('tool_')) return 'pyodide';
  if (tool.startsWith('phone_')) return 'phone-folder';
  if (tool.startsWith('mod_')) return 'mod';
  return 'app';
}

const enc = new TextEncoder();

/**
 * Add the evidence line to a tool result. Tools pass what they know in `meta`:
 *   { surface, bytes, proof, exit, job, extra }
 * Anything missing is filled in honestly: bytes = the result we are returning, proof = its hash,
 * and time is measured here, around the call.
 * Returns the same shape as runTool: { ok, result, display, images? }.
 */
export async function finishSurface(res, { tool, startedAt = Date.now() } = {}) {
  const out = res && typeof res === 'object' ? res : { ok: true, result: String(res ?? '') };
  const result = typeof out.result === 'string' ? out.result : String(out.result ?? '');
  if (/\[surface=/.test(result)) return out; // the tool already said it (job polling and similar)
  const meta = out.meta || {};
  const ms = Math.max(0, Date.now() - startedAt);
  const bytes = Number.isFinite(meta.bytes) ? meta.bytes : enc.encode(result).byteLength;
  let proof = meta.proof || '';
  if (!proof && out.ok !== false && result) proof = 'sha256:' + shortHash(await sha256Hex(result));
  const bits = [`surface=${meta.surface || surfaceOf(tool)}`, `ok=${out.ok === false ? 0 : 1}`, `bytes=${bytes}`, `ms=${ms}`];
  if (meta.exit != null) bits.push(`exit=${meta.exit}`);
  if (meta.job) bits.push(`job=${meta.job}`);
  if (proof) bits.push(`proof=${proof}`);
  if (meta.extra) bits.push(String(meta.extra));
  const line = `[${bits.join(' ')}]`;
  return {
    ...out,
    result: result ? `${result}\n\n${line}` : line,
    display: { ...(out.display || {}), surface: meta.surface || surfaceOf(tool) },
  };
}
