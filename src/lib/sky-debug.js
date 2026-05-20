/**
 * When true, `/api/sky-events` inserts a geomagnetic strip row unconditionally (live NOAA merges skipped for that branch).
 * Set SKY_DEBUG_GEOMAGNETIC_ACTIVE=1 in .env for local UI testing only.
 */
export function isSkyDebugGeomagneticActive(env = process.env) {
  const v = String(env.SKY_DEBUG_GEOMAGNETIC_ACTIVE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
