// Claude Code update notice (decision 248). Claude Code's own auto-updater stays off (an update cut short under proot
// left no `claude` at all); the app asks the npm registry, at most about once a day, which version is newest, and says
// so when it is newer than the one installed. Updating stays the card's Update button.
import { CLI_PKG } from './claudecode.js';

export const LATEST_URL = `https://registry.npmjs.org/${CLI_PKG}/latest`;
export const CHECK_EVERY_MS = 20 * 3600 * 1000;

/** "2.1.325 (Claude Code)" → [2, 1, 325]; null when there is no version in it. */
export function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
  return m ? m.slice(1, 4).map(Number) : null;
}
/** Is `latest` a newer version than `installed`? (false when either cannot be read) */
export function isNewer(latest, installed) {
  const a = parseVersion(latest);
  const b = parseVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
/**
 * The newest version: the remembered one when it is recent, else asked of the registry (`http(url, opts)` →
 * { status, body }). → { version, at } or the remembered one (or null) when the registry did not answer.
 */
export async function latestVersion({ http, known = null, now = Date.now(), force = false }) {
  if (!force && known?.version && now - (known.at || 0) < CHECK_EVERY_MS) return known;
  try {
    const r = await http(LATEST_URL, { method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: 15000 });
    const v = r?.status === 200 ? JSON.parse(r.body || '{}').version : '';
    if (parseVersion(v)) return { version: String(v), at: now };
  } catch {
    /* offline, or the registry is slow: try again next time */
  }
  return known;
}
