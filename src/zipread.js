// Reading a zip one entry at a time, straight from the file (a Blob / File), without loading all of it (decision 220).
// An "Export everything" zip can be hundreds of MB: reading it whole and unpacking every entry at once ran a phone out
// of memory, and the restore said "not a valid backup file". Here only the central directory is read up front; an
// entry is read and inflated when it is asked for.
import { inflateSync } from 'fflate';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 0x100000000;
const read = async (blob, from, to) => new Uint8Array(await blob.slice(from, to).arrayBuffer());
const utf8 = new TextDecoder();
let CRC;
/** CRC-32 of bytes (what a zip stores for each file): a damaged entry is caught, not restored as garbage. */
export function crc32(d) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

/** A gzip file (the Linux home archive) instead of a zip. */
export async function isGzip(blob) {
  const h = await read(blob, 0, 2);
  return h[0] === 0x1f && h[1] === 0x8b;
}

/** → { names: string[], has(name), size(name), get(name) → Promise<Uint8Array> }; throws when it is not a zip. */
export async function openZip(blob) {
  const size = blob.size;
  if (size < 22) throw new Error('the file is too small to be a zip');
  // the end-of-central-directory record is in the last 22 bytes + up to 64 KB of comment
  const tailFrom = Math.max(0, size - 65558);
  const tail = await read(blob, tailFrom, size);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      e = i;
      break;
    }
  }
  if (e < 0) throw new Error('no zip directory at its end (the file is not a zip, or it was cut short while saving)');
  let count = u16(tail, e + 10);
  let cdSize = u32(tail, e + 12);
  let cdOff = u32(tail, e + 16);
  // zip64: the real numbers are in the zip64 record the locator points at
  if (e >= 20 && u32(tail, e - 20) === 0x07064b50) {
    const z64 = u64(tail, e - 20 + 8);
    const rec = await read(blob, z64, z64 + 56);
    if (u32(rec, 0) === 0x06064b50) {
      count = u64(rec, 32);
      cdSize = u64(rec, 40);
      cdOff = u64(rec, 48);
    }
  }
  // fflate writes no zip64: past 4 GB its offsets wrap, and past 65535 files the count does. The directory ends where
  // the end record starts, so its real start is known from there; the entries are read until the directory ends
  const eAbs = tailFrom + e;
  if (cdSize > eAbs) throw new Error('the zip directory is damaged');
  if (cdOff !== eAbs - cdSize && (cdOff + cdSize > size || (eAbs - cdSize - cdOff) % 0x100000000 === 0)) cdOff = eAbs - cdSize;
  if (cdOff + cdSize > size) throw new Error('the zip directory points past the end of the file (it was cut short)');
  const cd = await read(blob, cdOff, cdOff + cdSize);
  const entries = new Map();
  let p = 0;
  let lastLocal = -1;
  let wraps = 0;
  for (let n = 0; p + 46 <= cd.length && (n < count || count === (count & 0xffff)); n++) {
    if (u32(cd, p) !== 0x02014b50) throw new Error('the zip directory is damaged');
    const method = u16(cd, p + 10);
    const crc = u32(cd, p + 16);
    let comp = u32(cd, p + 20);
    let plain = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let local = u32(cd, p + 42);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // zip64 sizes and offset, in the order the 0xffffffff fields appear
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(cd, x);
      const len = u16(cd, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (plain === 0xffffffff) (plain = u64(cd, q)), (q += 8);
        if (comp === 0xffffffff) (comp = u64(cd, q)), (q += 8);
        if (local === 0xffffffff) local = u64(cd, q);
      }
      x += 4 + len;
    }
    // files are written one after another: a local offset smaller than the one before wrapped past 4 GB
    if (local < 0x100000000) {
      if (local + wraps * 0x100000000 < lastLocal) wraps++;
      local += wraps * 0x100000000;
    }
    lastLocal = local;
    if (!name.endsWith('/')) entries.set(name, { method, comp, plain, local, crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const get = async (name) => {
    const en = entries.get(name);
    if (!en) throw new Error(`${name} is not in the zip`);
    const h = await read(blob, en.local, en.local + 30);
    if (u32(h, 0) !== 0x04034b50) throw new Error(`the zip entry ${name} is damaged`);
    const start = en.local + 30 + u16(h, 26) + u16(h, 28);
    const raw = await read(blob, start, start + en.comp);
    let out;
    if (en.method === 0) out = raw;
    else if (en.method === 8) {
      try {
        out = inflateSync(raw, { out: new Uint8Array(en.plain) });
      } catch (e) {
        throw new Error(`${name} is damaged in the file (${e.message}, at byte ${start})`);
      }
    } else throw new Error(`${name} uses a compression this app cannot read (method ${en.method})`);
    if (en.crc && crc32(out) !== en.crc) throw new Error(`${name} is damaged in the file (its checksum does not match, at byte ${start})`);
    return out;
  };
  return { names: [...entries.keys()], has: (n) => entries.has(n), size: (n) => entries.get(n)?.plain ?? 0, get };
}
