// Reading a QR code from a photo (decision 230): the phone's own detector when the WebView has one, else jsQR.
import jsQR from 'jsqr';

/** A photo (File / Blob) → the QR code's text, or '' when none is found. */
export async function decodeQr(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    if (globalThis.BarcodeDetector) {
      try {
        const found = await new globalThis.BarcodeDetector({ formats: ['qr_code'] }).detect(bmp);
        if (found?.[0]?.rawValue) return found[0].rawValue;
      } catch {
        /* not supported here: jsQR below */
      }
    }
    // jsQR on a copy at most 1200 px wide (bigger is slow and no more readable)
    const k = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const img = g.getImageData(0, 0, c.width, c.height);
    return jsQR(img.data, c.width, c.height, { inversionAttempts: 'attemptBoth' })?.data || '';
  } finally {
    bmp.close?.();
  }
}
