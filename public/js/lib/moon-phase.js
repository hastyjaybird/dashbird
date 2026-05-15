/** Lunar phase 0 = new, 0.5 = full, → 1 next new. Synodic month from epoch. */
export function getMoonPhase01(date = new Date()) {
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14, 0);
  const days = (date.getTime() - ref) / 86400000;
  let p = (days % synodic) / synodic;
  if (p < 0) p += 1;
  return p;
}

/** Eight canonical buckets (same order as common “moon phase” icon packs). */
export function getMoonPhaseIndex8(date = new Date()) {
  return Math.min(7, Math.floor(getMoonPhase01(date) * 8));
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
 * Raster pack URLs: `phase-0` … `phase-7` under `/assets/sky/moon/` (`.png`).
 * Index matches {@link getMoonPhaseIndex8} (northern‑hemisphere wax right / wane left).
 * Prior art was Wikimedia Commons “Moon phase N.svg” (Daniel Kmiec, CC BY 3.0); see
 * `public/assets/sky/moon/ATTRIBUTION.txt` if your PNGs trace to that set.
 */
export const MOON_PHASE_ICON_URLS = Object.freeze(
  [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `/assets/sky/moon/phase-${i}.png`),
);

/**
 * Hero moon glyph: picks one icon from {@link MOON_PHASE_ICON_URLS} from the date.
 */
export function createMoonPhaseGlyph(date = new Date()) {
  const phase = getMoonPhase01(date);
  const idx = getMoonPhaseIndex8(date);
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph';
  wrap.title = `${PHASE_LABEL[idx]} (~${Math.round(phase * 100)}% through lunation)`;

  const img = document.createElement('img');
  img.src = MOON_PHASE_ICON_URLS[idx];
  img.alt = '';
  img.decoding = 'async';
  img.setAttribute('aria-hidden', 'true');
  wrap.appendChild(img);
  return wrap;
}
