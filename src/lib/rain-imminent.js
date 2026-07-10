/**
 * Rain / precip checks via Open-Meteo (minutely_15 for 2h, hourly for 24h,
 * multi-point sample for nearby radar blobs).
 */
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const HORIZON_2H_MS = 2 * 60 * 60 * 1000;
const HORIZON_24H_MS = 24 * 60 * 60 * 1000;
/** Near-term window for “blob moving through” radar visibility. */
const HORIZON_NEARBY_MS = 3 * 60 * 60 * 1000;
const PRECIP_MM_MIN = 0.05;
const PRECIP_PROB_MIN = 35;
/** Default radius for nearby precip / radar card gate. */
export const RADAR_PRECIP_RADIUS_MI = 20;

/**
 * @param {number | undefined} p mm
 * @param {number | undefined} pr %
 */
function intervalLooksWet(p, pr) {
  return (
    (Number.isFinite(p) && p >= PRECIP_MM_MIN) ||
    (Number.isFinite(pr) && pr >= PRECIP_PROB_MIN)
  );
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {string} [timeZone]
 * @returns {Promise<{ imminent: boolean, minutesUntil: number | null, message: string, precipMm?: number }>}
 */
export async function rainImminentWithin2Hours(lat, lon, timeZone = 'America/Los_Angeles') {
  const tz =
    typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'America/Los_Angeles';
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('minutely_15', 'precipitation,precipitation_probability');
  url.searchParams.set('forecast_minutely_15', '8');
  url.searchParams.set('timezone', tz);
  url.searchParams.set('precipitation_unit', 'mm');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 18_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: { 'User-Agent': 'Dashbird/1.0 (rain imminent; open-meteo.com)' },
    });
    if (!r.ok) return { imminent: false, minutesUntil: null, message: '' };
    const data = await r.json();
    const times = data?.minutely_15?.time;
    const prec = data?.minutely_15?.precipitation;
    const prob = data?.minutely_15?.precipitation_probability;
    if (!Array.isArray(times) || !Array.isArray(prec)) {
      return { imminent: false, minutesUntil: null, message: '' };
    }

    const nowMs = Date.now();
    const endMs = nowMs + HORIZON_2H_MS;

    for (let i = 0; i < times.length; i++) {
      const startMs = new Date(times[i]).getTime();
      if (!Number.isFinite(startMs) || startMs >= endMs) break;
      if (startMs < nowMs - 60_000) continue;

      const p = Number(prec[i]);
      const pr = Number(prob?.[i]);
      if (!intervalLooksWet(p, pr)) continue;

      const minutesUntil = Math.max(0, Math.round((startMs - nowMs) / 60_000));
      const message =
        minutesUntil <= 1
          ? 'rain expected now'
          : `rain expected in ${minutesUntil} minutes`;
      return { imminent: true, minutesUntil, message, precipMm: Number.isFinite(p) ? p : undefined };
    }

    return { imminent: false, minutesUntil: null, message: '' };
  } catch {
    return { imminent: false, minutesUntil: null, message: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Any meaningful precipitation in the next 24 hours (Open-Meteo hourly).
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} [timeZone]
 * @returns {Promise<{ expected: boolean, hoursUntil: number | null }>}
 */
export async function precipExpectedWithin24Hours(lat, lon, timeZone = 'America/Los_Angeles') {
  const tz =
    typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'America/Los_Angeles';
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('hourly', 'precipitation,precipitation_probability');
  url.searchParams.set('forecast_hours', '24');
  url.searchParams.set('timezone', tz);
  url.searchParams.set('precipitation_unit', 'mm');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 18_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: { 'User-Agent': 'Dashbird/1.0 (precip 24h; open-meteo.com)' },
    });
    if (!r.ok) return { expected: false, hoursUntil: null };
    const data = await r.json();
    return firstWetHour(data, HORIZON_24H_MS);
  } catch {
    return { expected: false, hoursUntil: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sample center + ring points within radiusMi (approx. great-circle miles).
 * @param {number} lat
 * @param {number} lon
 * @param {number} radiusMi
 * @returns {Array<{ lat: number, lon: number }>}
 */
export function samplePointsWithinRadiusMi(lat, lon, radiusMi) {
  const r = Number.isFinite(radiusMi) && radiusMi > 0 ? radiusMi : RADAR_PRECIP_RADIUS_MI;
  const dLat = r / 69;
  const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const dLon = r / (69 * cos);
  /** @type {Array<{ lat: number, lon: number }>} */
  const pts = [{ lat, lon }];
  const rings = [
    { frac: 0.55, n: 6 },
    { frac: 0.95, n: 8 },
  ];
  for (const { frac, n } of rings) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      pts.push({
        lat: lat + dLat * frac * Math.sin(a),
        lon: lon + dLon * frac * Math.cos(a),
      });
    }
  }
  return pts;
}

/**
 * @param {object} data Open-Meteo forecast JSON (single location)
 * @param {number} horizonMs
 * @returns {{ expected: boolean, hoursUntil: number | null }}
 */
function firstWetHour(data, horizonMs) {
  const times = data?.hourly?.time;
  const prec = data?.hourly?.precipitation;
  const prob = data?.hourly?.precipitation_probability;
  if (!Array.isArray(times) || !Array.isArray(prec)) {
    return { expected: false, hoursUntil: null };
  }

  const nowMs = Date.now();
  const endMs = nowMs + horizonMs;

  for (let i = 0; i < times.length; i++) {
    const startMs = new Date(times[i]).getTime();
    if (!Number.isFinite(startMs) || startMs >= endMs) break;
    if (startMs < nowMs - 60_000) continue;

    const p = Number(prec[i]);
    const pr = Number(prob?.[i]);
    if (!intervalLooksWet(p, pr)) continue;

    const hoursUntil = Math.max(0, Math.round((startMs - nowMs) / 3_600_000));
    return { expected: true, hoursUntil };
  }

  return { expected: false, hoursUntil: null };
}

/**
 * Meaningful precip now / soon anywhere in a radius (Open-Meteo multi-point).
 * Used to show / hide the Weather Radar sidebar card when a blob is in range.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} [radiusMi]
 * @param {string} [timeZone]
 * @returns {Promise<{ expected: boolean, hoursUntil: number | null, radiusMi: number, sampleCount: number }>}
 */
export async function precipActiveWithinRadius(
  lat,
  lon,
  radiusMi = RADAR_PRECIP_RADIUS_MI,
  timeZone = 'America/Los_Angeles',
) {
  const tz =
    typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'America/Los_Angeles';
  const radius =
    Number.isFinite(radiusMi) && radiusMi > 0 ? radiusMi : RADAR_PRECIP_RADIUS_MI;
  const points = samplePointsWithinRadiusMi(lat, lon, radius);
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', points.map((p) => p.lat.toFixed(4)).join(','));
  url.searchParams.set('longitude', points.map((p) => p.lon.toFixed(4)).join(','));
  url.searchParams.set('hourly', 'precipitation,precipitation_probability');
  url.searchParams.set('forecast_hours', '3');
  url.searchParams.set('timezone', tz);
  url.searchParams.set('precipitation_unit', 'mm');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 18_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: { 'User-Agent': 'Dashbird/1.0 (precip nearby; open-meteo.com)' },
    });
    if (!r.ok) {
      return { expected: false, hoursUntil: null, radiusMi: radius, sampleCount: points.length };
    }
    const data = await r.json();
    const locations = Array.isArray(data) ? data : [data];

    let bestHours = null;
    for (const loc of locations) {
      if (loc?.error) continue;
      const hit = firstWetHour(loc, HORIZON_NEARBY_MS);
      if (!hit.expected) continue;
      if (bestHours == null || (hit.hoursUntil != null && hit.hoursUntil < bestHours)) {
        bestHours = hit.hoursUntil;
      }
    }

    return {
      expected: bestHours != null,
      hoursUntil: bestHours,
      radiusMi: radius,
      sampleCount: points.length,
    };
  } catch {
    return { expected: false, hoursUntil: null, radiusMi: radius, sampleCount: points.length };
  } finally {
    clearTimeout(timer);
  }
}
