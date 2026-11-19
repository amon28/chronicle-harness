// A folder on the phone, chosen with Android's folder picker. The app can only touch inside that one folder.
import { bridgeBytes } from './bridgebytes.js';
import { Capacitor, registerPlugin } from '@capacitor/core';

const native = Capacitor.isNativePlatform() ? registerPlugin('Folder') : null;
/** Tests can install globalThis.__ocmPhoneFolder with the same methods. */
const impl = () => globalThis.__ocmPhoneFolder || native;
export const canUsePhoneFolder = () => !!impl();

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function pickFolder() {
  const r = await impl().pick();
  return r?.uri ? { uri: r.uri, name: r.name || 'folder' } : null;
}
export async function listFolder(f, path = '', recursive = false, max = 1000) {
  return (await impl().list({ uri: f.uri, path, recursive, max })).entries || [];
}
export async function readPhoneFile(f, path, maxBytes) {
  const r = await impl().read({ uri: f.uri, path, ...(maxBytes ? { maxBytes } : {}) });
  return r.path ? bridgeBytes(r) : b64ToBytes(r.base64); // a big file comes as a cache file, not base64
}
/**
 * A file from the Linux shell's disk saved on the phone without passing through the app's memory (a 500 MB
 * recording): into the linked folder f at path, or into Download/Chronicle when f is null. guest = its real path in
 * Linux. onProgress(done, total). → { name, folder, bytes }
 */
export async function exportLinuxFile(guest, { folder = null, path = '', name = '', base = '' } = {}, onProgress = null) {
  const h = onProgress ? await impl().addListener?.('exportProgress', (e) => onProgress(e.done, e.total)) : null;
  try {
    // base 'shell': guest is under the app's shell storage (a chat's /workspace or /phone copy: work/…, phone/…)
    return await impl().exportLinuxFile({ guest, ...(base ? { base } : {}), ...(folder ? { uri: folder.uri, path } : {}), ...(name ? { name } : {}) });
  } finally {
    h?.remove?.();
  }
}
export const canExportLinux = () => typeof impl()?.exportLinuxFile === 'function';
/** A file the user picks on the phone, streamed into Linux at guest (only under /var/tmp/chronicle-move/). → { bytes, name } or {} */
export async function pickIntoLinux(guest, onProgress = null) {
  const h = onProgress ? await impl().addListener?.('importProgress', (e) => onProgress(e.done, e.total)) : null;
  try {
    return await impl().pickIntoLinux({ guest });
  } finally {
    h?.remove?.();
  }
}
export const writePhoneFile = (f, path, bytes) => impl().write({ uri: f.uri, path, base64: bytesToB64(bytes) });
/** A big file written in pieces (about 1 MB each): write(bytes) as often as you like; a failure removes the half-written file. */
export function openPhoneWriter(f, path) {
  let first = true;
  return {
    async write(bytes) {
      await impl().write({ uri: f.uri, path, base64: bytesToB64(bytes), append: !first });
      first = false;
    },
    async abort() {
      if (!first) await impl().remove({ uri: f.uri, path }).catch(() => {});
    },
  };
}
/**
 * The folder's real path on disk, when Android lets the app see it (a plain directory it can read).
 * Then the built-in Linux can bind it and there is one copy, not two. null means: mirror instead.
 */
export async function folderLocalPath(f, path = '') {
  try {
    const r = await impl().localPath?.({ uri: f.uri, path });
    return r?.path || null;
  } catch {
    return null;
  }
}
export const removePhoneFile = (f, path) => impl().remove({ uri: f.uri, path });
/** A file into the phone's Downloads/Chronicle folder. → { name, folder } */
export const saveToDownloads = (name, mime, bytes) => impl().saveToDownloads({ name, mime, data: bytesToB64(bytes) });
/** Android's "save to" screen (any folder, Drive…). → { saved, name } */
export const saveAsOnPhone = (name, mime, bytes) => impl().saveAs({ name, mime, data: bytesToB64(bytes) });
export const phoneExists = (f, path) => impl().exists({ uri: f.uri, path });
/** Tests can stub this too: globalThis.__ocmPhoneFolder.localPath({ uri, path }) -> { path }. */
