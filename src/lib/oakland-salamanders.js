import { haversineMiles } from './dashboard-geo.js';

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

/** ~Oakland City Hall / Lake Merritt — “greater Oakland” gate for this strip. */
export const OAKLAND_SALAMANDER_ANCHOR_LAT = 37.804363;
export const OAKLAND_SALAMANDER_ANCHOR_LON = -122.271111;

/**
 * Coarse wet-season calendar gate: **Nov 1 through Apr 1 inclusive** (wall `YYYY-MM-DD`).
 * Not a strict species-wide rule — references emphasize **rain + cool, moist soils** (e.g. Ensatina
 * most active in the rainy season; California tiger salamander migrations often **late fall–early
 * spring**, breeding commonly **Dec–Mar**).
 *
 * @param {string} wallYmd
 */
export function isOaklandSalamanderCalendarWindow(wallYmd) {
  const m = String(wallYmd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const month = Number.parseInt(m[2], 10);
  const day = Number.parseInt(m[3], 10);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return false;
  if (month === 11 || month === 12) return true;
  if (month >= 1 && month <= 3) return true;
  if (month === 4) return day <= 1;
  return false;
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} radiusMiles
 */
export function isNearOaklandSalamanderAnchor(lat, lon, radiusMiles) {
  const d = haversineMiles(lat, lon, OAKLAND_SALAMANDER_ANCHOR_LAT, OAKLAND_SALAMANDER_ANCHOR_LON);
  return Number.isFinite(d) && d <= radiusMiles;
}

/**
 * Open-Meteo hourly times without offset: treat as UTC by appending Z.
 * @param {string} iso
 */
export function parseOpenMeteoUtcInstant(iso) {
  const s = String(iso || '').trim();
  if (!s) return null;
  const t = s.endsWith('Z') ? s : `${s}Z`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {object} data Open-Meteo JSON
 * @param {number} windowHours
 * @returns {{ sumInches: number, hoursCounted: number } | null}
 */
export function sumRecentHourlyPrecipInches(data, windowHours = 72) {
  const hourly = data?.hourly;
  const times = hourly?.time;
  const prec = hourly?.precipitation;
  if (!Array.isArray(times) || !Array.isArray(prec) || times.length !== prec.length) return null;
  const now = Date.now();
  const from = now - windowHours * 60 * 60 * 1000;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < times.length; i++) {
    const t = parseOpenMeteoUtcInstant(times[i]);
    if (!t) continue;
    const ms = t.getTime();
    if (ms < from || ms > now + 60 * 60 * 1000) continue;
    const v = Number(prec[i]);
    if (Number.isFinite(v) && v >= 0) {
      sum += v;
      n += 1;
    }
  }
  return { sumInches: sum, hoursCounted: n };
}

/**
 * Latest hourly air temperature (°F) at or before “now” in the series.
 * @param {object} data
 */
export function latestHourlyTempF(data) {
  const hourly = data?.hourly;
  const times = hourly?.time;
  const temps = hourly?.temperature_2m;
  if (!Array.isArray(times) || !Array.isArray(temps) || times.length !== temps.length) return null;
  const now = Date.now();
  let best = null;
  let bestMs = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = parseOpenMeteoUtcInstant(times[i]);
    if (!t) continue;
    const ms = t.getTime();
    if (ms > now) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = temps[i];
    }
  }
  const v = Number(best);
  return Number.isFinite(v) ? v : null;
}

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: string }>}
 */
export async function fetchOpenMeteoSalamanderContext(lat, lon) {
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('past_days', '4');
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('hourly', 'precipitation,temperature_2m');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('wind_speed_unit', 'mph');

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 18_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: { 'User-Agent': 'dashbird/1.0 (Oakland salamander heuristic; open-meteo.com)' },
    });
    if (!r.ok) return { ok: false, error: `open_meteo_http_${r.status}` };
    const data = await r.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(to);
  }
}
