// Pictures on the clipboard: the browser's paste event covers some keyboards; the phone's clipboard is read natively.
import { Capacitor, registerPlugin } from '@capacitor/core';

const native = Capacitor.isNativePlatform() ? registerPlugin('Clip') : null;
/** Tests can install globalThis.__ocmClip = { hasImage(): {has, stamp}, readImages(): {images:[{mime, base64}]} } */
const impl = () => globalThis.__ocmClip || native;
export const canReadClipboardImages = () => !!impl();

export async function clipboardHasImage() {
  try {
    return (await impl()?.hasImage()) || { has: false, stamp: 0 };
  } catch {
    return { has: false, stamp: 0 };
  }
}

/** [{mime, base64}] → File[] */
export function filesFromBase64(images) {
  return images.map((im, i) => {
    const bin = atob(im.base64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const ext = (im.mime.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^\w]/g, '');
    return new File([bytes], `pasted-${Date.now()}${i ? '-' + i : ''}.${ext}`, { type: im.mime });
  });
}

/** → File[] of the images on the clipboard */
export async function readClipboardImages() {
  const r = await impl().readImages();
  return filesFromBase64(r.images || []);
}
