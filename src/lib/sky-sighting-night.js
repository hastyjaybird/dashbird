/**
 * ISS, Starlink train, and rocket launch rows only when the event starts after
 * sunset and before sunrise at the dashboard observer (Sun ≤ −0.833° altitude).
 */
import { Body, Equator, Horizon, Observer } from 'astronomy-engine';

/** Official sunrise/sunset: center of Sun at −0.833° (same as SunCalc). */
const SUNSET_SUNRISE_ALT_DEG = -0.833;

/** @type {Set<string>} */
export const NIGHTLY_SIGHTING_TYPES = new Set(['iss', 'starlink', 'rocket']);

/**
 * @param {number} lat
 * @param {number} lon
 */
function clampLatLon(lat, lon) {
  const la = typeof lat === 'number' && Number.isFinite(lat) ? lat : 0;
  const lo = typeof lon === 'number' && Number.isFinite(lon) ? lon : 0;
  return { lat: Math.min(90, Math.max(-90, la)), lon: ((lo + 180) % 360 + 360) % 360 - 180 };
}

/**
 * @param {Observer} observer
 * @param {Date} date
 */
function sunAltitudeDeg(observer, date) {
  const eq = Equator(Body.Sun, date, observer, true, true);
  const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal');
  return hor.altitude;
}

/**
 * True when `instant` is after sunset and before the following sunrise.
 * @param {Date} instant
 * @param {number} lat
 * @param {number} lon
 */
export function isAfterSunsetBeforeSunrise(instant, lat, lon) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return false;
  const { lat: la, lon: lo } = clampLatLon(lat, lon);
  const observer = new Observer(la, lo, 80);
  return sunAltitudeDeg(observer, instant) <= SUNSET_SUNRISE_ALT_DEG;
}

/**
 * @param {unknown} ev
 * @param {number} lat
 * @param {number} lon
 */
export function isNightlySightingVisible(ev, lat, lon) {
  if (!ev || !NIGHTLY_SIGHTING_TYPES.has(ev.type)) return true;
  const start = new Date(ev.startsAt);
  return isAfterSunsetBeforeSunrise(start, lat, lon);
}

/**
 * @param {unknown[]} events
 * @param {number} lat
 * @param {number} lon
 */
export function filterNightlySightings(events, lat, lon) {
  return (events || []).filter((ev) => isNightlySightingVisible(ev, lat, lon));
}
