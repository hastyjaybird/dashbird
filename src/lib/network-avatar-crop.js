/**
 * Detect / refine avatar crops from social profile screenshots
 * (Facebook-style centered circle, LinkedIn-style left avatar).
 *
 * Problem: Telegram intake often saves the whole profile card (photo + white
 * chrome with name/stats). Circular CSS then shows half face + half UI text.
 */

import sharp from 'sharp';

/** @typedef {{ x: number, y: number, w: number, h: number }} NormCrop */

/**
 * @param {Buffer} buf
 * @returns {Promise<{ width: number, height: number, data: Buffer, channels: number, scale: number } | null>}
 */
async function rawDownsample(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return null;
  try {
    const meta = await sharp(buf, { failOn: 'none' }).rotate().metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (!width || !height) return null;
    const maxEdge = 480;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const w = Math.max(32, Math.round(width * scale));
    const h = Math.max(32, Math.round(height * scale));
    const { data, info } = await sharp(buf, { failOn: 'none' })
      .rotate()
      .resize({ width: w, height: h, fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      width: info.width,
      height: info.height,
      data,
      channels: info.channels,
      scale: w / width,
    };
  } catch {
    return null;
  }
}

/**
 * @param {Buffer} data
 * @param {number} width
 * @param {number} channels
 * @param {number} x
 * @param {number} y
 */
function lumaAt(data, width, channels, x, y) {
  const i = (y * width + x) * channels;
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
}

/**
 * Fraction of near-white pixels in a horizontal band.
 * @param {{ data: Buffer, width: number, height: number, channels: number }} img
 * @param {number} y0
 * @param {number} y1
 */
function whiteFraction(img, y0, y1) {
  const { data, width, height, channels } = img;
  const top = Math.max(0, Math.min(height - 1, Math.floor(y0)));
  const bot = Math.max(top + 1, Math.min(height, Math.ceil(y1)));
  const stepX = Math.max(1, Math.floor(width / 48));
  const stepY = Math.max(1, Math.floor((bot - top) / 24));
  let white = 0;
  let n = 0;
  for (let y = top; y < bot; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      n += 1;
      if (lumaAt(data, width, channels, x, y) > 230) white += 1;
    }
  }
  return n ? white / n : 0;
}

/**
 * Cover photo → white profile chrome boundary (row index in downsample).
 * @param {{ data: Buffer, width: number, height: number, channels: number }} img
 */
function findCoverContentSplit(img) {
  const { data, width, height, channels } = img;
  const rowNw = new Float32Array(height);
  const stepX = Math.max(1, Math.floor(width / 48));
  for (let y = 0; y < height; y++) {
    let white = 0;
    let n = 0;
    for (let x = 0; x < width; x += stepX) {
      n += 1;
      if (lumaAt(data, width, channels, x, y) > 230) white += 1;
    }
    rowNw[y] = n ? white / n : 0;
  }
  const y0 = Math.floor(height * 0.12);
  const y1 = Math.floor(height * 0.55);
  for (let y = y0; y < y1; y++) {
    let win = 0;
    let prev = 0;
    const wN = 10;
    const pN = 16;
    for (let i = 0; i < wN; i++) win += rowNw[Math.min(height - 1, y + i)];
    for (let i = 1; i <= pN; i++) prev += rowNw[Math.max(0, y - i)];
    if (win / wN > 0.55 && prev / pN < 0.35) return y;
  }
  return null;
}

/**
 * Score a candidate circle for a white-ringed profile avatar.
 * @param {{ data: Buffer, width: number, height: number, channels: number }} img
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @param {{ strict?: boolean }} [opts]
 */
function scoreRingCircle(img, cx, cy, r, opts = {}) {
  const { data, width, height, channels } = img;
  if (r < 8 || cx - r < 1 || cy - r < 1 || cx + r >= width - 1 || cy + r >= height - 1) {
    return null;
  }
  const ring = [];
  const inner = [];
  const step = opts.strict ? 6 : 10;
  for (let a = 0; a < 360; a += step) {
    const rad = (a * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = Math.round(cx + (r - 1) * cos);
    const ry = Math.round(cy + (r - 1) * sin);
    const ix = Math.round(cx + r * 0.62 * cos);
    const iy = Math.round(cy + r * 0.62 * sin);
    if (rx >= 0 && rx < width && ry >= 0 && ry < height) {
      ring.push(lumaAt(data, width, channels, rx, ry));
    }
    if (ix >= 0 && ix < width && iy >= 0 && iy < height) {
      inner.push(lumaAt(data, width, channels, ix, iy));
    }
  }
  if (ring.length < 24 || inner.length < 20) return null;
  const ringWhite = ring.filter((L) => L > 210).length / ring.length;
  let ringMean = 0;
  for (const L of ring) ringMean += L;
  ringMean /= ring.length;
  let ringVar = 0;
  for (const L of ring) ringVar += (L - ringMean) ** 2;
  const ringStd = Math.sqrt(ringVar / ring.length);
  let innerMean = 0;
  for (const L of inner) innerMean += L;
  innerMean /= inner.length;
  let innerVar = 0;
  for (const L of inner) innerVar += (L - innerMean) ** 2;
  const innerStd = Math.sqrt(innerVar / inner.length);
  const minWhite = opts.strict ? 0.45 : 0.35;
  if (ringWhite < minWhite || innerStd < 18 || innerMean > 225) return null;
  return { ringWhite, innerStd, innerMean, ringStd, ringMean };
}

/**
 * Local fine search so crop center matches the icon circle center.
 * Keeps the circle near the seed (esp. horizontal center for FB).
 * @param {{ data: Buffer, width: number, height: number, channels: number }} img
 * @param {{ cx: number, cy: number, r: number }} seed
 * @param {{ lockCenterX?: boolean }} [opts]
 */
function refineCircleCenter(img, seed, opts = {}) {
  const { width, height } = img;
  let best = { ...seed, score: -1 };
  const r0 = seed.r;
  const cxPad = opts.lockCenterX ? Math.max(1, Math.floor(width * 0.02)) : Math.max(2, Math.floor(r0 * 0.18));
  const cyPad = Math.max(2, Math.floor(r0 * 0.18));
  const rPad = Math.max(2, Math.floor(r0 * 0.1));
  const rCap = opts.lockCenterX ? Math.floor(width * 0.175) : Math.floor(Math.min(width, height) / 2) - 2;
  for (let r = Math.max(8, r0 - rPad); r <= Math.min(rCap, r0 + rPad); r += 1) {
    for (let cy = seed.cy - cyPad; cy <= seed.cy + cyPad; cy += 1) {
      for (let cx = seed.cx - cxPad; cx <= seed.cx + cxPad; cx += 1) {
        if (cx - r < 1 || cy - r < 1 || cx + r >= width - 1 || cy + r >= height - 1) continue;
        const s = scoreRingCircle(img, cx, cy, r, { strict: true });
        if (!s) continue;
        const score =
          s.ringWhite * 130
          + Math.min(70, s.innerStd)
          - s.ringStd * 1.2
          + (opts.lockCenterX ? (1 - Math.abs(cx / width - 0.5) * 10) * 20 : 0);
        if (score > best.score) best = { cx, cy, r, score };
      }
    }
  }
  return best.score >= 0 ? best : seed;
}

/**
 * @param {NormCrop | null | undefined} crop
 * @param {{ data: Buffer, width: number, height: number, channels: number }} img
 */
function cropHasChrome(crop, img) {
  if (!crop) return true;
  const y0 = crop.y * img.height;
  const y1 = (crop.y + crop.h) * img.height;
  const mid = y0 + (y1 - y0) * 0.55;
  const bottomWhite = whiteFraction(img, mid, y1);
  const aspect = crop.h / Math.max(1e-6, crop.w);
  // Tall crops with a white lower half are profile cards, not headshots.
  return bottomWhite > 0.45 && aspect > 1.15;
}

/**
 * @param {'facebook' | 'linkedin' | 'auto'} layout
 * @param {{ data: Buffer, width: number, height: number, channels: number }} img
 * @param {number | null} splitY
 */
function searchProfileCircle(layout, img, splitY) {
  const { data, width, height, channels } = img;
  const split = splitY == null ? Math.floor(height * 0.28) : splitY;

  // Facebook (and most mobile social profiles): the avatar bubble is
  // horizontally centered and overlaps the cover→chrome line.
  if (layout === 'facebook') {
    const mid = Math.round(width / 2);
    const cx0 = mid - Math.max(1, Math.floor(width * 0.02));
    const cx1 = mid + Math.max(1, Math.floor(width * 0.02));
    const rMin = Math.floor(width * 0.12);
    const rMax = Math.floor(width * 0.2);
    /** @type {{ score: number, cx: number, cy: number, r: number } | null} */
    let best = null;
    for (let r = rMin; r <= rMax; r += 1) {
      // Prefer circles whose center sits on/near the split; allow above
      // (avatar hangs into cover) more than below (avoids chin/chrome latch).
      const cy0 = Math.max(r + 2, split - Math.floor(r * 0.55));
      const cy1 = Math.min(height - r - 2, split + Math.floor(r * 0.2));
      for (let cy = cy0; cy <= cy1; cy += 1) {
        for (let cx = cx0; cx <= cx1; cx += 1) {
          const s = scoreRingCircle(img, cx, cy, r, { strict: true });
          if (!s) continue;
          const aboveY = Math.max(0, cy - r - 2);
          const belowY = Math.min(height - 1, cy + r + 2);
          const above = lumaAt(data, width, channels, cx, aboveY);
          const below = lumaAt(data, width, channels, cx, belowY);
          if (below < above - 10) continue; // chrome below should not be darker than cover
          const score =
            s.ringWhite * 150
            + Math.min(55, s.innerStd)
            - s.ringStd * 1.3
            + (1 - Math.abs(cx - mid) / Math.max(1, width * 0.02)) * 45
            + (1 - Math.abs(cy - split) / Math.max(1, r)) * 25
            + Math.min(25, Math.max(0, below - above) * 0.08);
          if (!best || score > best.score) best = { score, cx, cy, r };
        }
      }
    }
    return best;
  }

  // LinkedIn / auto: small avatar often on the left (or anywhere).
  const rMin = Math.floor(width * (layout === 'linkedin' ? 0.09 : 0.11));
  const rMax = Math.floor(width * (layout === 'linkedin' ? 0.2 : 0.17));
  if (rMax < rMin + 2) return null;

  let cx0;
  let cx1;
  if (layout === 'linkedin') {
    cx0 = Math.floor(width * 0.05);
    cx1 = Math.floor(width * 0.42);
  } else {
    cx0 = Math.floor(width * 0.08);
    cx1 = Math.floor(width * 0.92);
  }

  const cy0 = Math.max(rMax + 2, split - Math.floor(rMax * 0.55));
  const cy1 = Math.min(height - rMax - 2, split + Math.floor(rMax * 0.35));
  if (cy1 <= cy0) return null;

  /** @type {{ score: number, cx: number, cy: number, r: number } | null} */
  let best = null;
  const stepR = Math.max(1, Math.floor((rMax - rMin) / 12) || 1);
  const stepC = Math.max(1, Math.floor(width / 80));
  const stepY = Math.max(1, Math.floor(height / 100));

  for (let r = rMin; r <= rMax; r += stepR) {
    for (let cy = cy0; cy <= cy1; cy += stepY) {
      for (let cx = cx0; cx <= cx1; cx += stepC) {
        const s = scoreRingCircle(img, cx, cy, r);
        if (!s) continue;
        const aboveY = Math.max(0, cy - r - Math.max(2, Math.floor(r * 0.08)));
        const belowY = Math.min(height - 1, cy + r + Math.max(2, Math.floor(r * 0.08)));
        let above = 0;
        let below = 0;
        let nProbe = 0;
        for (const dx of [-Math.floor(r * 0.35), 0, Math.floor(r * 0.35)]) {
          const x = Math.max(0, Math.min(width - 1, cx + dx));
          above += lumaAt(data, width, channels, x, aboveY);
          below += lumaAt(data, width, channels, x, belowY);
          nProbe += 1;
        }
        above /= nProbe;
        below /= nProbe;
        if (below - above < 20) continue;

        const centerBonus =
          layout === 'linkedin'
            ? (1 - cx / width) * 25
            : (1 - Math.abs(cx / width - 0.5) * 2.4) * 30;
        const splitBonus = 28 - Math.min(28, (Math.abs(cy - split) / Math.max(1, r)) * 20);
        const score =
          s.ringWhite * 100
          + Math.min(70, s.innerStd)
          - s.ringStd * 0.6
          + centerBonus
          + splitBonus;
        if (!best || score > best.score) best = { score, cx, cy, r };
      }
    }
  }
  return best;
}

/**
 * True when an image looks like a tall phone profile screenshot
 * (cover photo → white chrome), even if the VLM kind is wrong.
 * @param {Buffer} buf
 */
export async function looksLikeSocialProfileScreenshot(buf) {
  const img = await rawDownsample(buf);
  if (!img) return false;
  const { width, height } = img;
  if (height / width < 1.45) return false;
  const split = findCoverContentSplit(img);
  if (split == null || split < height * 0.12 || split > height * 0.55) return false;
  const below = whiteFraction(img, split, height);
  const above = whiteFraction(img, Math.max(0, split - height * 0.12), split);
  return below > 0.35 && above < 0.55;
}

/**
 * True when an image (or saved avatar) looks like a profile card with UI chrome,
 * not a tight headshot — e.g. Natasha's 242×359 FB card crop.
 * @param {Buffer} buf
 */
export async function avatarLooksLikeProfileChrome(buf) {
  const img = await rawDownsample(buf);
  if (!img) return false;
  const { width, height } = img;
  if (height / width < 1.12) return false;
  const bottomWhite = whiteFraction(img, height * 0.55, height);
  const topWhite = whiteFraction(img, 0, height * 0.35);
  return bottomWhite > 0.45 && topWhite < 0.55;
}

/**
 * Detect the circular (or square) profile photo on a social screenshot.
 * @param {Buffer} buf
 * @param {{ kind?: string }} [opts]
 * @returns {Promise<{ ok: true, crop: NormCrop, layout: string, score: number } | { ok: false, reason: string }>}
 */
export async function detectProfileAvatarCrop(buf, opts = {}) {
  const img = await rawDownsample(buf);
  if (!img) return { ok: false, reason: 'decode_failed' };
  const kind = String(opts.kind || '').toLowerCase();
  /** @type {Array<'facebook' | 'linkedin' | 'auto'>} */
  let layouts;
  if (kind === 'linkedin_screenshot') {
    layouts = ['linkedin', 'auto'];
  } else if (kind === 'social_screenshot') {
    // Facebook / IG / similar: only use the centered-bubble finder.
    layouts = ['facebook'];
  } else {
    layouts = ['facebook', 'linkedin', 'auto'];
  }

  const splitY = findCoverContentSplit(img);
  /** @type {{ score: number, cx: number, cy: number, r: number, layout: string } | null} */
  let best = null;
  for (const layout of layouts) {
    const hit = searchProfileCircle(layout, img, splitY);
    if (!hit) continue;
    if (!best || hit.score > best.score) {
      best = { ...hit, layout };
    }
  }
  // Fall back if facebook-only missed (odd aspect / cropped screenshot).
  if (!best && kind === 'social_screenshot') {
    const hit = searchProfileCircle('auto', img, splitY);
    if (hit) best = { ...hit, layout: 'auto' };
  }
  if (!best) return { ok: false, reason: 'no_circle' };

  // Snap to the true white-ring center — crop square must share that center.
  const refined = refineCircleCenter(img, best, {
    lockCenterX: best.layout === 'facebook',
  });
  // Slight inset drops the white border only; do NOT shift the center.
  const pixelSide = refined.r * 2 * 0.94;
  const crop = {
    x: Math.max(0, Math.min(1 - pixelSide / img.width, (refined.cx - pixelSide / 2) / img.width)),
    y: Math.max(0, Math.min(1 - pixelSide / img.height, (refined.cy - pixelSide / 2) / img.height)),
    w: pixelSide / img.width,
    h: pixelSide / img.height,
  };

  return {
    ok: true,
    crop,
    layout: best.layout,
    score: best.score,
    center: {
      x: refined.cx / img.width,
      y: refined.cy / img.height,
      r: refined.r / img.width,
    },
  };
}

/**
 * Pick the best avatar crop for a Telegram/social image.
 * Prefers a detector crop when VLM box is missing or still includes chrome.
 * @param {Buffer} buf
 * @param {{ kind?: string, headshotCrop?: NormCrop | null }} [opts]
 * @returns {Promise<{ crop: NormCrop | null, source: string, chrome: boolean, profileShot: boolean }>}
 */
export async function resolveAvatarCrop(buf, opts = {}) {
  const img = await rawDownsample(buf);
  if (!img) return { crop: null, source: 'none', chrome: false, profileShot: false };

  const kind = String(opts.kind || '').toLowerCase();
  const profileShot =
    kind === 'social_screenshot'
    || kind === 'linkedin_screenshot'
    || (await looksLikeSocialProfileScreenshot(buf))
    || (await avatarLooksLikeProfileChrome(buf));

  /** @type {NormCrop | null} */
  let vlm = null;
  if (opts.headshotCrop && typeof opts.headshotCrop === 'object') {
    const x = Number(opts.headshotCrop.x);
    const y = Number(opts.headshotCrop.y);
    const w = Number(opts.headshotCrop.w);
    const h = Number(opts.headshotCrop.h);
    if ([x, y, w, h].every((n) => Number.isFinite(n)) && w > 0 && h > 0) {
      vlm = { x, y, w, h };
    }
  }

  // Profile screenshots: always prefer geometric icon detection over VLM boxes
  // (VLM often returns the whole card header, not the bubble center).
  if (profileShot) {
    const detectKind =
      kind === 'linkedin_screenshot' || kind === 'social_screenshot'
        ? kind
        : 'social_screenshot';
    const detected = await detectProfileAvatarCrop(buf, { kind: detectKind });
    if (detected.ok) {
      return {
        crop: detected.crop,
        source: `detect:${detected.layout}`,
        chrome: false,
        profileShot: true,
      };
    }
    if (vlm && !cropHasChrome(vlm, img)) {
      return { crop: vlm, source: 'vlm', chrome: false, profileShot: true };
    }
    return { crop: null, source: 'detect-miss', chrome: true, profileShot: true };
  }

  const vlmChrome = vlm ? cropHasChrome(vlm, img) : true;
  if (vlm && !vlmChrome) {
    return { crop: vlm, source: 'vlm', chrome: false, profileShot: false };
  }

  if (vlmChrome) {
    const detected = await detectProfileAvatarCrop(buf, { kind });
    if (detected.ok) {
      return {
        crop: detected.crop,
        source: `detect:${detected.layout}`,
        chrome: false,
        profileShot: false,
      };
    }
  }

  if (vlm) return { crop: vlm, source: 'vlm-fallback', chrome: vlmChrome, profileShot: false };
  return { crop: null, source: 'none', chrome: false, profileShot: false };
}

/**
 * Resolve crop + write contact avatar. Used by Telegram intake so every
 * future social/LinkedIn/card photo goes through the same path.
 *
 * @param {string} contactId
 * @param {Buffer} buf
 * @param {{
 *   kind?: string,
 *   headshotCrop?: NormCrop | null,
 *   mimeType?: string,
 *   allowFullFrame?: boolean,
 * }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{
 *   ok: boolean,
 *   contact?: object,
 *   source?: string,
 *   crop?: NormCrop | null,
 *   error?: string,
 * }>}
 */
export async function applyContactAvatarFromImage(contactId, buf, opts = {}, env = process.env) {
  if (!contactId || !Buffer.isBuffer(buf) || buf.length < 32) {
    return { ok: false, error: 'invalid_image' };
  }
  const { cropImageRegion } = await import('./telegram-message-classify.js');
  const { saveContactAvatar } = await import('./network-contacts-store.js');

  const kind = String(opts.kind || '').toLowerCase();
  const resolved = await resolveAvatarCrop(buf, {
    kind,
    headshotCrop: opts.headshotCrop || null,
  });

  let avatarBuf = null;
  if (resolved.crop) {
    avatarBuf = await cropImageRegion(buf, resolved.crop);
  }
  // Full frame only for true headshots — never for profile chrome cards.
  if (!avatarBuf && opts.allowFullFrame && kind === 'headshot' && !resolved.profileShot) {
    avatarBuf = buf;
  }
  if (!avatarBuf) {
    return {
      ok: false,
      error: 'crop_failed',
      source: resolved.source,
      crop: resolved.crop,
    };
  }

  const mime =
    avatarBuf === buf
      ? String(opts.mimeType || 'image/jpeg')
      : 'image/jpeg';
  const contact = await saveContactAvatar(
    contactId,
    {
      base64: avatarBuf.toString('base64'),
      mimeType: mime.startsWith('image/') ? mime : 'image/jpeg',
    },
    env,
  );
  return {
    ok: true,
    contact,
    source: resolved.source,
    crop: resolved.crop,
  };
}
