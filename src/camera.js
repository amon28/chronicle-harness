// The 📎 menu's camera (decision 229): a photo from the camera app attached like a picked picture, or a video recorded
// straight into the chat's folder in Linux (/workspace/videos/…) – videos are too big and too binary to be attachments.
// The camera app takes them, so the app needs no CAMERA permission (PhonePlugin.capture).
import { Capacitor, registerPlugin } from '@capacitor/core';
import { bridgeBytes } from './bridgebytes.js';
import { downscaleJpeg } from './phonectl.js';
import { workDir } from './shellfs.js';

const native = Capacitor.isNativePlatform() ? registerPlugin('Phone') : null;
const phone = () => globalThis.__ocmPhone || native;
export const canUseCamera = () => typeof phone()?.capture === 'function';

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const MB = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
/** A camera-app error as words for a toast; null when the user just closed the camera. */
export function cameraError(e) {
  const code = e?.code || '';
  if (code === 'CANCELLED') return null;
  if (code === 'NO_APP') return 'No camera app on this phone can do that.';
  if (code === 'BACKGROUND') return 'Chronicle was not on screen, so the camera could not open.';
  return `The camera did not work: ${e?.message || e}`;
}

/** → a File (JPEG, at most 1600 px – a phone photo is often over the 10 MB attachment limit), or null when cancelled. */
export async function takePhoto() {
  let r;
  try {
    r = await phone().capture({});
  } catch (e) {
    if (e?.code === 'CANCELLED') return null;
    throw e;
  }
  const raw = r?.bytes instanceof Uint8Array ? r.bytes : await bridgeBytes(r || {});
  if (!raw?.byteLength) return null;
  let bytes = raw;
  try {
    bytes = await downscaleJpeg(raw);
  } catch {
    /* the photo as it came */
  }
  return new File([bytes], `photo-${stamp()}.jpg`, { type: 'image/jpeg' });
}

/**
 * A video recorded into this chat's folder. → { path: '/workspace/videos/…', size } or null when cancelled.
 * The bytes never pass through the app: Android moves the camera app's file into the chat's shell storage.
 */
export async function recordVideo(convId) {
  const name = `video-${stamp()}.mp4`;
  let r;
  try {
    r = await phone().capture({ video: true, dest: `${workDir(convId)}/videos/${name}` });
  } catch (e) {
    if (e?.code === 'CANCELLED') return null;
    throw e;
  }
  if (!r?.size) return null;
  return { path: `/workspace/videos/${name}`, name, size: r.size };
}

/** The attachment for a recorded video: no bytes (they are in the chat's folder), a note the model reads instead. */
export function videoAttachment(v, { hasLinux = true } = {}) {
  const where = hasLinux
    ? `It is in this chat's Linux shell at ${v.path} (also in the workspace as videos/${v.name} when it is small enough) – use the shell (ffprobe, ffmpeg) to look at it, e.g. to cut frames you can view.`
    : `It is saved in this chat's folder as videos/${v.name}; working with it (ffmpeg) needs the built-in Linux, which is not set up yet.`;
  return { kind: 'file', name: v.name, size: v.size, lang: '', note: `video, ${MB(v.size)}`, text: `[A video the user just recorded with the phone's camera: ${v.name}, ${MB(v.size)}. ${where}]`, truncated: false, video: true };
}

/**
 * The attachment for a file of any size put in the chat's folder (📎 › Attach a file or image on the phone, decisions 249, 262): no bytes, a
 * note the model reads instead – where it is, and for a video how to look at it.
 * The note says only what is true (decision 275): the file is on the phone's disk (uploads/), not in the app's workspace,
 * so "work with it in the shell" only when Linux is installed (hasLinux) and this chat has the shell tool (shellOn);
 * run_python sees it only once a shell command has copied it in (files up to 32 MB – LIMITS.fileBytes in bridge.js).
 */
export function folderFileAttachment(f, { hasLinux = true, shellOn = hasLinux } = {}) {
  const video = /\.(mp4|mov|m4v|mkv|webm|3gp|avi)$/i.test(f.name);
  const mirrored = f.size <= 32 * 1024 * 1024;
  const how = video
    ? 'To see it: ffprobe for its length, then ffmpeg to cut frames (e.g. one every few seconds, scaled to 768 px) or the audio, and look at the frames. Install ffmpeg first if it is missing (apk add ffmpeg, or apt-get install -y ffmpeg).'
    : `Work with it in the shell (it is too big to be read into the chat whole).${mirrored ? ` After a shell command has run, a copy is also in the app's workspace as uploads/${f.name}, where run_python can open it.` : " run_python cannot open it (too big for the app's workspace)."}`;
  const where = !hasLinux
    ? `It is saved in this chat's folder as uploads/${f.name}; working with it needs the built-in Linux, which is not set up yet.`
    : shellOn
      ? `It is in this chat's folder as uploads/${f.name} – in the Linux shell /workspace/uploads/${f.name}; Claude Code finds it in its working folder. ${how}`
      : `It is in this chat's folder on the phone as uploads/${f.name} – not in the app's workspace, so read_file and run_python cannot open it, and this chat has no shell tool (Settings › Tools & agent › “Run commands in the built-in Linux” turns it on). Claude Code finds it in its working folder.`;
  return { kind: 'file', name: f.name, size: f.size, lang: '', note: `${video ? 'video' : 'file'}, ${MB(f.size)}, in the chat's folder`, text: `[A ${video ? 'video' : 'file'} the user added from the phone: ${f.name}, ${MB(f.size)}. ${where}]`, truncated: false, video, inFolder: true };
}
