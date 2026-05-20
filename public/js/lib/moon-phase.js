import { getMoonIllumination } from './suncalc.js';

/**
 * Lunation age 0 = new, 0.5 = full, → 1 next new (SunCalc `getMoonIllumination().phase`).
 */
export function getMoonPhase01(date = new Date()) {
  const { phase } = getMoonIllumination(date);
  if (typeof phase !== 'number' || !Number.isFinite(phase)) return 0;
  let p = phase % 1;
  if (p < 0) p += 1;
  return p;
}

/**
 * Eight equal lunation bins (octants), 0 = new … 7 = waning crescent.
 * Matches northern-hemisphere icon order for Wikimedia “Moon phase N.svg” (N = 0…7).
 */
export function getMoonPhaseIndex8(date = new Date()) {
  const p = getMoonPhase01(date);
  return Math.min(7, Math.max(0, Math.floor(p * 8)));
}

export const PHASE_LABEL = [
  'New moon',
  'Waxing crescent',
  'First quarter',
  'Waxing gibbous',
  'Full moon',
  'Waning gibbous',
  'Last quarter',
  'Waning crescent',
];

/**
 * Maps each computed octant index → filename id `phase-{id}.png` under `/assets/sky/moon/`.
 * Default is identity: octant `k` uses `phase-k.png` (Wikimedia Moon_phase_k.svg).
 * If your PNG pack uses a different numbering, change only this array — do not reorder
 * {@link PHASE_LABEL} / {@link getMoonPhaseIndex8} without updating this map.
 */
export const LUNATION_OCTANT_TO_MOON_PNG_ID = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]);

/**
 * @param {Date} [date]
 * @returns {number} Which `phase-{n}.png` to load (0–7).
 */
export function moonPngIdForDate(date = new Date()) {
  const oct = getMoonPhaseIndex8(date);
  const id = LUNATION_OCTANT_TO_MOON_PNG_ID[oct];
  return typeof id === 'number' && id >= 0 && id <= 7 ? id : oct;
}

/**
 * Absolute URL path for the moon raster shown beside moonrise (**moon now** glyph).
 */
export function moonPhaseIconUrl(_date = new Date()) {
  return '/assets/sky/moon/moonnow.png';
}

/**
 * Hero moonrise flank glyph: primary **`moonPhaseIconUrl()`** (moonnow.png); on **`error`**,
 * `/assets/sky/moon/phase-{id}.png`. Lunation tooltips via SunCalc; pass **now** for wall-clock “moon now”.
 */
export function createMoonPhaseGlyph(date = new Date()) {
  const ill = getMoonIllumination(date);
  const phase = getMoonPhase01(date);
  const oct = getMoonPhaseIndex8(date);
  const pngId = moonPngIdForDate(date);
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph';
  const lit =
    typeof ill.fraction === 'number' && Number.isFinite(ill.fraction)
      ? Math.round(ill.fraction * 100)
      : null;
  wrap.title =
    lit != null
      ? `${PHASE_LABEL[oct]} · ~${lit}% illuminated`
      : `${PHASE_LABEL[oct]} · lunation ~${Math.round(phase * 100)}%`;

  const primarySrc = moonPhaseIconUrl(date);
  const fallbackSrc = `/assets/sky/moon/phase-${pngId}.png`;

  const img = document.createElement('img');
  img.alt = PHASE_LABEL[oct];
  img.decoding = 'async';
  img.loading = 'eager';
  if ('fetchPriority' in img) {
    img.fetchPriority = 'high';
  }
  img.dataset.moonOctant = String(oct);
  img.dataset.moonPngId = String(pngId);

  img.addEventListener(
    'error',
    () => {
      const cur = img.getAttribute('src') || '';
      if (primarySrc !== fallbackSrc && !cur.endsWith(`/phase-${pngId}.png`)) {
        img.src = fallbackSrc;
      }
    },
    { once: true },
  );

  img.src = primarySrc;
  wrap.appendChild(img);
  return wrap;
}
