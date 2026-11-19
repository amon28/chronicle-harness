// Automatic backups into a phone folder you picked: a backup zip now and then, keeping only the newest few.
import { applyBackup, readBackup, streamBackup } from '../backup.js';
import { canUsePhoneFolder, listFolder, openPhoneWriter, pickFolder, readPhoneFile, removePhoneFile } from '../phonefolder.js';
import { ensurePersonas } from '../personas.js';
import { fmtBytes } from '../files.js';
import { saveSettings } from '../store.js';
import { $, state, toast } from './core.js';

const EVERY = { daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3 };
const NAME_RX = /^chronicle-backup-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/;
const cfg = () => (state.settings.autoBackup ||= { every: 'off', keep: 5, folder: null, last: 0 });
let running = false;

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

export async function backupNow({ quiet = false } = {}) {
  const c = cfg();
  if (!c.folder || running) return false;
  running = true;
  try {
    const name = `chronicle-backup-${stamp()}.zip`;
    const writer = openPhoneWriter(c.folder, name);
    let size;
    let stats;
    try {
      ({ size, stats } = await streamBackup(state.settings, { includeKeys: false, onProgress: (t) => !quiet && ($('#ab-status').textContent = '⏳ ' + t) }, (chunk) => writer.write(chunk)));
    } catch (e) {
      await writer.abort(); // never leave a half-written zip behind
      throw e;
    }
    // keep only the newest few of OUR backups (named exactly like this); nothing else in the folder is touched
    const mine = (await listFolder(c.folder, '', false)).filter((e) => !e.isDir && NAME_RX.test(e.name)).map((e) => e.name).sort();
    const drop = mine.slice(0, Math.max(0, mine.length - Math.max(1, c.keep || 5)));
    for (const n of drop) await removePhoneFile(c.folder, n).catch(() => {});
    c.last = Date.now();
    c.lastInfo = `${stats.chats} chats, ${fmtBytes(size)}`;
    c.error = '';
    saveSettings(state.settings);
    if (!quiet) toast(`Backed up to “${c.folder.name}” (${fmtBytes(size)})`);
    render();
    return true;
  } catch (e) {
    c.error = e.message || String(e);
    saveSettings(state.settings);
    if (!quiet) toast('Backup failed: ' + c.error, 5000);
    render();
    return false;
  } finally {
    running = false;
  }
}

/** Merge the newest backup in the folder into this phone (chats: newer copy wins; memories: newer edit wins; nothing is deleted). */
async function syncNow() {
  const c = cfg();
  if (!c.folder) return;
  const btn = $('#ab-sync');
  btn.disabled = true;
  try {
    const names = (await listFolder(c.folder, '', false)).filter((e) => !e.isDir && NAME_RX.test(e.name)).map((e) => e.name).sort();
    const newest = names.at(-1);
    if (!newest) return toast('No backup found in that folder yet');
    const bytes = await readPhoneFile(c.folder, newest, 500 * 1024 * 1024);
    const parsed = readBackup(bytes);
    if (!confirm(`Merge “${newest}” (${parsed.data.conversations?.length || 0} chats, ${parsed.data.settings?.memories?.length || 0} memories) into this phone?\n\nNewer copies win; nothing here is deleted.`)) return;
    const { settings, stats } = await applyBackup(parsed, 'merge', state.settings);
    ensurePersonas(settings);
    await saveSettings(settings);
    toast(`Merged ${stats.chats} changed chat${stats.chats === 1 ? '' : 's'} – reloading…`);
    setTimeout(() => location.reload(), 700);
  } catch (e) {
    toast('Sync failed: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
  }
}
$('#ab-sync').onclick = syncNow;

function due() {
  const c = cfg();
  return !!c.folder && !!EVERY[c.every] && Date.now() - (c.last || 0) >= EVERY[c.every];
}
const check = () => due() && !document.hidden && backupNow({ quiet: true });

function render() {
  const c = cfg();
  const box = $('#autobackup-box');
  if (!box) return;
  box.hidden = !canUsePhoneFolder();
  $('#ab-folder').textContent = c.folder ? `📱 ${c.folder.name}` : 'No folder chosen';
  $('#ab-every').value = c.every || 'off';
  $('#ab-keep').value = String(c.keep || 5);
  $('#ab-now').hidden = !c.folder;
  $('#ab-sync').hidden = !c.folder;
  $('#ab-status').textContent = c.error ? `✗ ${c.error}` : c.last ? `Last backup: ${new Date(c.last).toLocaleString()} (${c.lastInfo || ''})` : c.folder ? 'No backup made yet.' : '';
}
$('#ab-pick').onclick = async () => {
  try {
    const f = await pickFolder();
    if (!f) return;
    cfg().folder = f;
    if (cfg().every === 'off') cfg().every = 'weekly';
    saveSettings(state.settings);
    render();
    toast(`Backups will go to “${f.name}”`);
  } catch (e) {
    toast('Could not open the folder picker: ' + e.message);
  }
};
$('#ab-every').onchange = (e) => {
  cfg().every = e.target.value;
  saveSettings(state.settings);
};
$('#ab-keep').onchange = (e) => {
  cfg().keep = Number(e.target.value) || 5;
  saveSettings(state.settings);
};
$('#ab-now').onclick = () => backupNow();
document.addEventListener('visibilitychange', () => !document.hidden && setTimeout(check, 3000));
setTimeout(check, 12000);
globalThis.__ocmAutoBackup = { backupNow, render }; // for tests and for the settings page
