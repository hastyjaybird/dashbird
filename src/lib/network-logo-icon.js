/**
 * Crop company logos that include a graphical mark + wordmark down to the icon.
 * Wide "icon | Company Name" locks become a square crop of the densest mark.
 */
import sharp from 'sharp';

/** Max relative gap to treat scores as a tie (prefer left / top for LTR brands). */
const SCORE_TIE = 0.08;
/** Wider than this vs height → treat as icon+wordmark and square-crop. */
const WIDE_RATIO = 1.35;
/** Pixel distance from corner-sampled background to count as "ink". */
const INK_DIST2 = 42 * 42;

/**
 * @param {Buffer} data
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 */
function sampleBackground(data, width, height, channels) {
  const pts = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [Math.floor(width / 2), 0],
    [Math.floor(width / 2), height - 1],
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let n = 0;
  for (const [x, y] of pts) {
    const i = (y * width + x) * channels;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    a += channels > 3 ? data[i + 3] : 255;
    n += 1;
  }
  return { r: r / n, g: g / n, b: b / n, a: a / n };
}

/**
 * @param {Buffer} data
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @param {{ r: number, g: number, b: number, a: number }} bg
 */
function inkMask(data, width, height, channels, bg) {
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const alpha = channels > 3 ? data[i + 3] : 255;
      if (alpha < 24) continue;
      // Mostly-transparent logos: treat opaque pixels as ink regardless of color.
      if (bg.a < 80) {
        if (alpha >= 64) {
          mask[y * width + x] = 1;
          count += 1;
        }
        continue;
      }
      const dr = data[i] - bg.r;
      const dg = data[i + 1] - bg.g;
      const db = data[i + 2] - bg.b;
      if (dr * dr + dg * dg + db * db >= INK_DIST2) {
        mask[y * width + x] = 1;
        count += 1;
      }
    }
  }
  return { mask, count };
}

/**
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 */
function contentBounds(mask, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < left) left = x;
      if (y < top) top = y;
      if (x > right) right = x;
      if (y > bottom) bottom = y;
    }
  }
  if (right < left || bottom < top) return null;
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Ink score for a square region (favor filled marks over sparse lettering).
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} left
 * @param {number} top
 * @param {number} side
 */
function squareInkScore(mask, width, left, top, side) {
  let ink = 0;
  const right = left + side;
  const bottom = top + side;
  for (let y = top; y < bottom; y++) {
    const row = y * width;
    for (let x = left; x < right; x++) {
      if (mask[row + x]) ink += 1;
    }
  }
  const area = side * side || 1;
  const density = ink / area;
  // Prefer denser, more compact marks (icons) over sparse word columns.
  return ink * (0.35 + density);
}

/**
 * @param {Buffer} buf
 * @returns {Promise<{ buffer: Buffer, cropped: boolean, ext: string }>}
 */
export async function cropLogoToIconMark(buf) {
  const input = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (input.length < 500) return { buffer: input, cropped: false, ext: '' };

  let pipeline = sharp(input, { failOn: 'none' }).rotate();
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) return { buffer: input, cropped: false, ext: '' };

  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const bg = sampleBackground(data, width, height, channels);
  const { mask, count } = inkMask(data, width, height, channels, bg);
  if (count < 40) return { buffer: input, cropped: false, ext: '' };

  const bounds = contentBounds(mask, width, height);
  if (!bounds) return { buffer: input, cropped: false, ext: '' };

  let extract = {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
  let didCrop = false;

  const ratio = bounds.width / Math.max(1, bounds.height);
  if (ratio >= WIDE_RATIO) {
    // Horizontal lockup: find the densest square of side ≈ content height.
    const side = Math.min(bounds.height, bounds.width);
    let bestX = bounds.left;
    let bestScore = -1;
    const step = Math.max(1, Math.floor(side / 48));
    const maxX = bounds.left + bounds.width - side;
    for (let x = bounds.left; x <= maxX; x += step) {
      const score = squareInkScore(mask, width, x, bounds.top, side);
      const better =
        score > bestScore * (1 + SCORE_TIE) ||
        (score >= bestScore * (1 - SCORE_TIE) && x < bestX);
      if (better || bestScore < 0) {
        bestScore = score;
        bestX = x;
      }
    }
    // Refine around bestX
    const refineLo = Math.max(bounds.left, bestX - step);
    const refineHi = Math.min(maxX, bestX + step);
    for (let x = refineLo; x <= refineHi; x++) {
      const score = squareInkScore(mask, width, x, bounds.top, side);
      if (score > bestScore || (score >= bestScore * (1 - SCORE_TIE) && x < bestX)) {
        bestScore = score;
        bestX = x;
      }
    }
    extract = { left: bestX, top: bounds.top, width: side, height: side };
    didCrop = true;
  } else if (bounds.height / Math.max(1, bounds.width) >= WIDE_RATIO) {
    // Tall stacked lockup: icon usually above the wordmark.
    const side = Math.min(bounds.width, bounds.height);
    let bestY = bounds.top;
    let bestScore = -1;
    const step = Math.max(1, Math.floor(side / 48));
    const maxY = bounds.top + bounds.height - side;
    for (let y = bounds.top; y <= maxY; y += step) {
      const score = squareInkScore(mask, width, bounds.left, y, side);
      const better =
        score > bestScore * (1 + SCORE_TIE) ||
        (score >= bestScore * (1 - SCORE_TIE) && y < bestY);
      if (better || bestScore < 0) {
        bestScore = score;
        bestY = y;
      }
    }
    extract = { left: bounds.left, top: bestY, width: side, height: side };
    didCrop = true;
  } else if (
    bounds.left > 0 ||
    bounds.top > 0 ||
    bounds.right < width - 1 ||
    bounds.bottom < height - 1
  ) {
    // Square-ish mark: trim empty padding only.
    didCrop = true;
  }

  // Skip tiny no-op extracts.
  if (
    extract.left === 0 &&
    extract.top === 0 &&
    extract.width === width &&
    extract.height === height
  ) {
    return { buffer: input, cropped: false, ext: '' };
  }

  const out = await sharp(input, { failOn: 'none' })
    .rotate()
    .extract(extract)
    .png()
    .toBuffer();

  return { buffer: out, cropped: didCrop, ext: '.png' };
}
