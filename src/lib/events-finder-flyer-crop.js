/**
 * Crop phone screenshots of event pages down to the flyer graphic,
 * dropping browser chrome and text/UI regions below the poster.
 */
import sharp from 'sharp';

/**
 * @param {Buffer} buf
 * @returns {Promise<{
 *   buffer: Buffer,
 *   cropped: boolean,
 *   score: number,
 *   reason?: string,
 *   region?: { top: number, bottom: number, width: number, height: number },
 * }>}
 */
export async function cropFlyerRegion(buf) {
  const input = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (input.length < 800) {
    return { buffer: input, cropped: false, score: 0, reason: 'too_small' };
  }

  let pipeline = sharp(input, { failOn: 'none' }).rotate();
  const meta = await pipeline.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height || width < 40 || height < 80) {
    return { buffer: input, cropped: false, score: 0, reason: 'bad_dims' };
  }

  const { data, info } = await pipeline
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels || 4;
  const chroma = new Float32Array(height);
  const edge = new Float32Array(height);

  for (let y = 0; y < height; y++) {
    let chromaSum = 0;
    let edgeSum = 0;
    let prevGray = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      chromaSum += mx - mn;
      const gray = (r + g + b) / 3;
      if (x > 0) edgeSum += Math.abs(gray - prevGray);
      prevGray = gray;
    }
    chroma[y] = chromaSum / width;
    edge[y] = width > 1 ? edgeSum / (width - 1) : 0;
  }

  const smooth = (arr, k) => {
    const out = new Float32Array(arr.length);
    const half = Math.max(1, Math.floor(k / 2));
    for (let i = 0; i < arr.length; i++) {
      let sum = 0;
      let n = 0;
      for (let j = i - half; j <= i + half; j++) {
        if (j < 0 || j >= arr.length) continue;
        sum += arr[j];
        n += 1;
      }
      out[i] = n ? sum / n : 0;
    }
    return out;
  };

  const chromaS = smooth(chroma, 12);
  const edgeS = smooth(edge, 12);
  let meanChroma = 0;
  for (let y = 0; y < height; y++) meanChroma += chromaS[y];
  meanChroma /= height;

  // Phone chrome / URL bar: dark low-chroma header before the flyer.
  let chromeEnd = Math.floor(height * 0.07);
  const chromeLimit = Math.min(Math.floor(height * 0.28), height);
  for (let y = chromeEnd; y < chromeLimit; y++) {
    if (chromaS[y] < 15 && edgeS[y] < 8) chromeEnd = y + 1;
    else break;
  }

  let start = -1;
  for (let y = chromeEnd; y < height; y++) {
    if (chromaS[y] >= 40) {
      start = y;
      break;
    }
  }
  if (start < 0) {
    return {
      buffer: input,
      cropped: false,
      score: meanChroma,
      reason: 'no_flyer_graphic',
    };
  }
  start = Math.max(chromeEnd, start - 8);

  let end = start;
  let dip = 0;
  const dipLimit = Math.max(12, Math.floor(height * 0.04));
  for (let y = start; y < height; y++) {
    if (chromaS[y] >= 30) {
      end = y + 1;
      dip = 0;
    } else {
      dip += 1;
      if (dip > dipLimit) break;
      end = y + 1;
    }
  }
  while (end > start && chromaS[end - 1] < 30) end -= 1;

  const cropH = end - start;
  const frac = cropH / height;
  if (cropH < 120 || frac < 0.18) {
    return {
      buffer: input,
      cropped: false,
      score: meanChroma,
      reason: 'flyer_too_small',
      region: { top: start, bottom: end, width, height },
    };
  }

  // Skip crop when almost the whole frame is already the flyer.
  if (start <= Math.floor(height * 0.04) && end >= Math.floor(height * 0.96)) {
    return {
      buffer: input,
      cropped: false,
      score: meanChroma,
      reason: 'already_flyer',
      region: { top: start, bottom: end, width, height },
    };
  }

  const out = await sharp(input, { failOn: 'none' })
    .rotate()
    .extract({ left: 0, top: start, width, height: cropH })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();

  let cropScore = 0;
  for (let y = start; y < end; y++) cropScore += chromaS[y];
  cropScore /= cropH;

  return {
    buffer: out,
    cropped: true,
    score: cropScore,
    region: { top: start, bottom: end, width, height: cropH },
  };
}

/**
 * Higher = more likely a colorful flyer vs text/UI screenshot.
 * @param {Buffer} buf
 * @returns {Promise<number>}
 */
export async function scoreFlyerGraphicness(buf) {
  const input = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (input.length < 800) return 0;
  try {
    const { data, info } = await sharp(input, { failOn: 'none' })
      .rotate()
      .resize({ width: 160, height: 320, fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (!width || !height) return 0;
    let chromaSum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      chromaSum += Math.max(r, g, b) - Math.min(r, g, b);
      n += 1;
    }
    return n ? chromaSum / n : 0;
  } catch {
    return 0;
  }
}

/**
 * Pick the most flyer-like image from an album, preferring a successful crop.
 * @param {Array<{ buffer: Buffer, publicPath?: string, mimeType?: string }>} images
 * @returns {Promise<{
 *   buffer: Buffer,
 *   publicPath?: string,
 *   mimeType: string,
 *   score: number,
 *   cropped: boolean,
 *   index: number,
 * } | null>}
 */
export async function pickBestFlyerImage(images) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return null;

  /** @type {Array<{ index: number, buffer: Buffer, publicPath?: string, mimeType: string, score: number, cropped: boolean }>} */
  const scored = [];
  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    const raw = Buffer.isBuffer(img?.buffer) ? img.buffer : Buffer.from(img?.buffer || []);
    if (raw.length < 800) continue;
    const crop = await cropFlyerRegion(raw);
    const baseScore = await scoreFlyerGraphicness(raw);
    const score = crop.cropped ? Math.max(crop.score, baseScore) + 40 : baseScore;
    scored.push({
      index: i,
      buffer: crop.cropped ? crop.buffer : raw,
      publicPath: img.publicPath,
      mimeType: crop.cropped
        ? 'image/jpeg'
        : (String(img.mimeType || '').trim() || 'image/jpeg'),
      score,
      cropped: crop.cropped,
    });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  // Text-only albums: still return highest score, but callers can treat low score as weak.
  return best;
}
