// Bytes from the native side: small answers come as base64, big ones as the path of a cache file (see BigBytes.java),
// read straight from there instead of as a huge string in a message.
import { Capacitor, registerPlugin } from '@capacitor/core';

const fromB64 = (s) => Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0));
const folder = Capacitor.isNativePlatform() ? registerPlugin('Folder') : null;
/** The page has the bytes: the cache file goes now (the native side deletes only files in cache/bridge). Tests: __ocmReleaseBytes. */
const release = (path) => {
  try {
    if (globalThis.__ocmReleaseBytes) globalThis.__ocmReleaseBytes(path);
    else folder?.releaseBytes({ path })?.catch?.(() => {});
  } catch {
    /* an old app without the call: the 15-minute sweep still removes it */
  }
};

/** { base64 } or { path } (keys can be renamed: b64Key / pathKey) → Uint8Array */
export async function bridgeBytes(r, { b64Key = 'base64', pathKey = 'path' } = {}) {
  const path = r?.[pathKey];
  if (path) {
    const url = Capacitor.convertFileSrc(path.startsWith('file://') ? path : 'file://' + path);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not read the received file (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    release(path.replace(/^file:\/\//, ''));
    return bytes;
  }
  return fromB64(r?.[b64Key]);
}
