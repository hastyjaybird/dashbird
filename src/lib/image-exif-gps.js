/**
 * Extract GPS + capture time from JPEG EXIF when present.
 * Telegram "Photo" sends often strip EXIF; document/file sends may keep it.
 * Minimal TIFF/EXIF reader — no external dependency.
 */

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @param {boolean} le
 */
function u16(buf, offset, le) {
  return le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
}

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @param {boolean} le
 */
function u32(buf, offset, le) {
  return le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @param {boolean} le
 */
function readRational(buf, offset, le) {
  const num = u32(buf, offset, le);
  const den = u32(buf, offset + 4, le);
  if (!den) return NaN;
  return num / den;
}

/**
 * @param {number[]} dms  [deg, min, sec]
 * @param {string} [ref]  N/S/E/W
 */
function dmsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return NaN;
  const [d, m, s] = dms.map(Number);
  if (![d, m, s].every(Number.isFinite)) return NaN;
  let dec = Math.abs(d) + m / 60 + s / 3600;
  const r = String(ref || '').toUpperCase();
  if (r === 'S' || r === 'W') dec = -dec;
  return dec;
}

/**
 * @param {Buffer} tiff
 * @param {number} ifdOffset
 * @param {boolean} le
 * @returns {Map<number, { type: number, count: number, valueOffset: number }>}
 */
function readIfd(tiff, ifdOffset, le) {
  /** @type {Map<number, { type: number, count: number, valueOffset: number }>} */
  const map = new Map();
  if (ifdOffset < 0 || ifdOffset + 2 > tiff.length) return map;
  const count = u16(tiff, ifdOffset, le);
  for (let i = 0; i < count; i += 1) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    const tag = u16(tiff, entry, le);
    const type = u16(tiff, entry + 2, le);
    const cnt = u32(tiff, entry + 4, le);
    const valueOffset = entry + 8;
    map.set(tag, { type, count: cnt, valueOffset });
  }
  return map;
}

/**
 * @param {Buffer} tiff
 * @param {{ type: number, count: number, valueOffset: number }} entry
 * @param {boolean} le
 */
function entryDataOffset(tiff, entry, le) {
  const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const size = (typeSizes[entry.type] || 1) * entry.count;
  if (size <= 4) return entry.valueOffset;
  const off = u32(tiff, entry.valueOffset, le);
  return off;
}

/**
 * @param {Buffer} tiff
 * @param {{ type: number, count: number, valueOffset: number }} entry
 * @param {boolean} le
 */
function readAscii(tiff, entry, le) {
  const off = entryDataOffset(tiff, entry, le);
  if (off < 0 || off >= tiff.length) return '';
  const len = Math.min(entry.count, tiff.length - off);
  let s = tiff.subarray(off, off + len).toString('ascii');
  const nul = s.indexOf('\0');
  if (nul >= 0) s = s.slice(0, nul);
  return s.trim();
}

/**
 * @param {Buffer} tiff
 * @param {{ type: number, count: number, valueOffset: number }} entry
 * @param {boolean} le
 * @returns {number[]}
 */
function readRationals(tiff, entry, le) {
  const off = entryDataOffset(tiff, entry, le);
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < entry.count; i += 1) {
    const o = off + i * 8;
    if (o + 8 > tiff.length) break;
    out.push(readRational(tiff, o, le));
  }
  return out;
}

/**
 * @param {Buffer} tiff
 * @returns {{ lat: number, lon: number, capturedAtMs?: number } | null}
 */
function parseTiffGps(tiff) {
  if (tiff.length < 8) return null;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return null;
  if (u16(tiff, 2, le) !== 42) return null;
  const ifd0 = u32(tiff, 4, le);
  const tags0 = readIfd(tiff, ifd0, le);

  const gpsPtr = tags0.get(0x8825);
  if (!gpsPtr) return null;
  const gpsIfd = u32(tiff, gpsPtr.valueOffset, le);
  const gps = readIfd(tiff, gpsIfd, le);

  const latEntry = gps.get(0x0002);
  const latRef = gps.get(0x0001);
  const lonEntry = gps.get(0x0004);
  const lonRef = gps.get(0x0003);
  if (!latEntry || !lonEntry) return null;

  const lat = dmsToDecimal(readRationals(tiff, latEntry, le), latRef ? readAscii(tiff, latRef, le) : 'N');
  const lon = dmsToDecimal(readRationals(tiff, lonEntry, le), lonRef ? readAscii(tiff, lonRef, le) : 'E');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  /** @type {{ lat: number, lon: number, capturedAtMs?: number }} */
  const out = { lat, lon };

  // DateTimeOriginal is in Exif IFD (tag 0x8769 → ExifIFD, then 0x9003).
  const exifPtr = tags0.get(0x8769);
  if (exifPtr) {
    const exifIfd = u32(tiff, exifPtr.valueOffset, le);
    const exif = readIfd(tiff, exifIfd, le);
    const dtEntry = exif.get(0x9003) || exif.get(0x0132) || tags0.get(0x0132);
    if (dtEntry) {
      const raw = readAscii(tiff, dtEntry, le);
      // "YYYY:MM:DD HH:MM:SS"
      const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
      if (m) {
        const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
        if (Number.isFinite(ms)) out.capturedAtMs = ms;
      }
    }
  }

  return out;
}

/**
 * @param {Buffer} jpeg
 * @returns {Buffer | null} TIFF payload inside APP1
 */
function findExifTiffInJpeg(jpeg) {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = jpeg[i + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (len < 2 || i + 2 + len > jpeg.length) break;
    if (marker === 0xe1) {
      const start = i + 4;
      const end = i + 2 + len;
      const seg = jpeg.subarray(start, end);
      if (
        seg.length >= 14
        && seg[0] === 0x45
        && seg[1] === 0x78
        && seg[2] === 0x69
        && seg[3] === 0x66
        && seg[4] === 0x00
        && seg[5] === 0x00
      ) {
        return Buffer.from(seg.subarray(6));
      }
    }
    i += 2 + len;
  }
  return null;
}

/**
 * @param {Buffer | Uint8Array | ArrayBuffer} input
 * @returns {Promise<{
 *   lat: number,
 *   lon: number,
 *   accuracyMeters?: number,
 *   capturedAtMs?: number,
 * } | null>}
 */
export async function extractImageGps(input) {
  let buf;
  if (Buffer.isBuffer(input)) buf = input;
  else if (input instanceof ArrayBuffer) buf = Buffer.from(input);
  else if (input instanceof Uint8Array) buf = Buffer.from(input);
  else return null;
  if (!buf.length) return null;

  try {
    const tiff = findExifTiffInJpeg(buf) || (buf[0] === 0x49 || buf[0] === 0x4d ? buf : null);
    if (!tiff) return null;
    return parseTiffGps(tiff);
  } catch {
    return null;
  }
}
