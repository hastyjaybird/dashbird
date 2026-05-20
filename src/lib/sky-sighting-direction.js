/** Sighting types that support 3-day heads-up + look direction on the strip. */
export const SIGHTING_HEADS_UP_TYPES = new Set(['iss', 'iridium', 'starlink', 'rocket']);

/** @param {number} deg */
export function normalizeAzimuthDeg(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return null;
  return ((n % 360) + 360) % 360;
}

const COMPASS16 = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

/**
 * @param {number | null | undefined} azimuthDeg 0° = north, clockwise (standard azimuth)
 */
export function azimuthToCompass(azimuthDeg) {
  const n = normalizeAzimuthDeg(azimuthDeg);
  if (n == null) return null;
  const idx = Math.round(n / 22.5) % 16;
  return COMPASS16[idx];
}

/**
 * @param {unknown} ev
 * @returns {{ compass: string | null, deg: number | null, label: string | null }}
 */
export function resolveLookDirection(ev) {
  if (ev && typeof ev.lookDirection === 'string' && ev.lookDirection.trim() !== '') {
    return { compass: null, deg: null, label: ev.lookDirection.trim() };
  }
  const deg = normalizeAzimuthDeg(ev?.lookAzimuthDeg);
  if (deg == null) return { compass: null, deg: null, label: null };
  const compass = azimuthToCompass(deg);
  return { compass, deg, label: compass ? `look ${compass} (${Math.round(deg)}°)` : null };
}

/**
 * @param {{ zip?: string | null, locationLabel?: string | null, lat?: number, lon?: number }} geo
 */
export function formatObserverSiteLabel(geo) {
  const zip = geo?.zip != null ? String(geo.zip).replace(/\D/g, '') : '';
  if (zip.length === 5) return `ZIP ${zip}`;
  const label = typeof geo?.locationLabel === 'string' ? geo.locationLabel.trim() : '';
  if (label) return label;
  const lat = geo?.lat;
  const lon = geo?.lon;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
  }
  return 'your site';
}
