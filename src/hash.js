// SHA-256 in one place: proofs, toolkit manifests and the two-way file bridge all use it, so a
// "verified" claim means the same thing everywhere.
const HEX = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-256 of a string or raw bytes, lowercase hex. */
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 is not available here, so this cannot be verified');
  return HEX(await subtle.digest('SHA-256', bytes));
}

/** The first n characters of a hash - enough to recognise a file in a log line. */
export const shortHash = (h, n = 12) => String(h || '').slice(0, n);
