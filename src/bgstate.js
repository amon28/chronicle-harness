// Background protection, said honestly (decision 172): the foreground service that keeps a reply going when the app
// is in the background can be refused by Android, or stopped at its time limit. KeepAlive.start / status report it
// (GenerationService records why the last one ended); these turn it into what the user and doctor are told.
import { Capacitor, registerPlugin } from '@capacitor/core';

/** The KeepAlive plugin (tests install globalThis.__ocmKeepAlive), or null in a browser. */
export const keepAlivePlugin = () => globalThis.__ocmKeepAlive || (Capacitor.isNativePlatform() ? registerPlugin('KeepAlive') : null);

/**
 * What to tell the user once per run when the protection did not come up: the start was refused at once (start
 * result), or the service was refused just after (status, an end recorded since this run started). '' = fine.
 */
export function backgroundNotice(start, status, since = 0) {
  const refused = (r) => /^refused/.test(String(r || ''));
  let why = '';
  if (start && start.started === false) why = String(start.reason || 'refused').replace(/^refused:\s*/, '');
  else if (status && !status.running && refused(status.lastStop) && (status.lastStopAt || 0) >= since) why = status.lastStop.replace(/^refused:\s*/, '');
  if (!why) return '';
  return `Background protection is not running (${why}): keep Chronicle open until the reply finishes, or it may be paused.`;
}

/** Whether Android stopped the protection at its time limit since `seen` (shown once when the app is opened again). */
export const pausedSince = (status, seen = 0) => !!status && status.lastStop === 'time limit' && (status.lastStopAt || 0) > seen;

/** doctor's Background row: { state, detail }. */
export function backgroundRow(status, now = Date.now()) {
  if (!status) return { state: 'n/a', detail: 'only in the Android app' };
  const ago = (t) => {
    const m = Math.round((now - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };
  const last = status.lastStop ? `last stop: ${status.lastStop}${status.lastStopAt ? ` (${ago(status.lastStopAt)})` : ''}` : 'not used yet in this app run';
  const extras = [status.notifications === false ? 'notifications are off (no "reply finished" or "paused" notice)' : '', status.batteryFree === false ? 'battery optimisation is on (Android may pause it sooner)' : ''].filter(Boolean);
  const state = status.running ? 'running' : /^refused/.test(status.lastStop || '') ? 'refused' : status.lastStop === 'time limit' ? 'paused' : 'idle';
  return { state, detail: [status.running ? 'a reply is protected now' : 'protects a reply while one runs', last, ...extras].join('; ') };
}
