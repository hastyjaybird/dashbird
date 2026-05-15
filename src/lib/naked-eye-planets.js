/**
 * Naked-eye planet strip rows (Mercury–Saturn) for the hero sky-events API.
 * Uses Astronomy Engine (MIT) for topocentric positions, civil-night sky, and
 * per-planet magnitude limits tuned for “usually visible without optical aid”
 * under suburban skies. Uranus and Neptune are excluded (marginal even when up).
 */
import { Body, Equator, Horizon, Illumination, Observer } from 'astronomy-engine';

const NIGHT_SUN_ALT_DEG = -6;
const STEP_MS = 30 * 60 * 1000;

const NAKED_EYE = [
  { body: Body.Mercury, key: 'mercury', label: 'Mercury', maxMag: 1.2, minAltDeg: 12 },
  { body: Body.Venus, key: 'venus', label: 'Venus', maxMag: 4.0, minAltDeg: 8 },
  { body: Body.Mars, key: 'mars', label: 'Mars', maxMag: 2.5, minAltDeg: 8 },
  { body: Body.Jupiter, key: 'jupiter', label: 'Jupiter', maxMag: 3.0, minAltDeg: 8 },
  { body: Body.Saturn, key: 'saturn', label: 'Saturn', maxMag: 2.0, minAltDeg: 8 },
];

function clampLatLon(lat, lon) {
  const la = typeof lat === 'number' && Number.isFinite(lat) ? lat : 0;
  const lo = typeof lon === 'number' && Number.isFinite(lon) ? lon : 0;
  return { lat: Math.min(90, Math.max(-90, la)), lon: ((lo + 180) % 360 + 360) % 360 - 180 };
}

/** @param {Observer} observer */
function sunAltitudeDeg(body, observer, date) {
  const eq = Equator(body, date, observer, true, true);
  const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal');
  return hor.altitude;
}

/** @param {Observer} observer */
function planetAltMag(body, observer, date) {
  const eq = Equator(body, date, observer, true, true);
  const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal');
  const illum = Illumination(body, date);
  return { alt: hor.altitude, mag: illum.mag };
}

/**
 * @param {unknown[]} events
 * @param {number} lat
 * @param {number} lon
 * @param {Date} now
 * @param {number} windowMs
 * @param {string} timeZone
 * @returns {unknown[]}
 */
export function mergeNakedEyePlanetsWithComputed(
  events,
  lat,
  lon,
  now = new Date(),
  windowMs = 24 * 60 * 60 * 1000,
  timeZone = 'America/Los_Angeles',
) {
  const list = Array.isArray(events) ? events : [];
  const base = list.filter((e) => e && e.type !== 'planet');

  const { lat: la, lon: lo } = clampLatLon(lat, lon);
  const observer = new Observer(la, lo, 80);
  const t0 = now.getTime();
  const t1 = t0 + windowMs;
  const dayKey = now.toLocaleDateString('en-CA', { timeZone });

  /** @type {unknown[]} */
  const added = [];

  try {
    for (const row of NAKED_EYE) {
      let firstMs = null;
      let lastMs = null;
      let peakAlt = -90;
      let bestMag = Infinity;

      for (let t = t0; t <= t1; t += STEP_MS) {
        const date = new Date(t);
        if (sunAltitudeDeg(Body.Sun, observer, date) > NIGHT_SUN_ALT_DEG) continue;
        const { alt, mag } = planetAltMag(row.body, observer, date);
        if (alt < row.minAltDeg) continue;
        if (!Number.isFinite(mag) || mag > row.maxMag) continue;
        if (firstMs == null) firstMs = t;
        lastMs = t;
        peakAlt = Math.max(peakAlt, alt);
        bestMag = Math.min(bestMag, mag);
      }

      if (firstMs == null || lastMs == null) continue;

      const startsAt = new Date(firstMs).toISOString();
      const endsAt = new Date(lastMs + STEP_MS).toISOString();
      const magStr = Number.isFinite(bestMag) ? bestMag.toFixed(1) : '—';
      const detailLine = `Peak ${Math.round(peakAlt)}°, mag ${magStr}`;

      added.push({
        id: `planet-${row.key}-${dayKey}`,
        type: 'planet',
        planetKey: row.key,
        planetLabel: row.label,
        title: `${row.label} · night sky`,
        startsAt,
        endsAt,
        peakAt: null,
        detailLine,
        source:
          'Positions & magnitudes: Astronomy Engine (Don Cross, MIT). Rules: Sun more than ~6° below the horizon, planet above a minimum altitude, brightness within naked-eye limits for Mercury–Saturn.',
      });
    }
  } catch (err) {
    console.warn('[sky-events] Planet visibility computation failed:', err?.message || err);
    return base;
  }

  const merged = [...added, ...base];
  merged.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return merged;
}
