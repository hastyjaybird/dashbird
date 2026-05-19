/**
 * Shared dashboard location math (ZIP / WEATHER_LAT+LON + IANA calendar month).
 */

const EARTH_RADIUS_MI = 3958.8;

/**
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} great-circle distance in statute miles
 */
export function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MI * c;
}

/**
 * @param {Date} date
 * @param {string} timeZone
 * @returns {number} month 1–12 in timeZone
 */
export function calendarMonthInZone(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'numeric',
  });
  const parts = fmt.formatToParts(date);
  const v = Number(parts.find((p) => p.type === 'month')?.value || NaN);
  return Number.isFinite(v) ? v : NaN;
}
