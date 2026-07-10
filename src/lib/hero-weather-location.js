import { geocodeUsZip5 } from './zip-geocode.js';

const DEFAULT_LAT = 37.848;
const DEFAULT_LON = -122.253;

/** @type {Promise<{ lat: number, lon: number, zip: string | null, city: string | null, place: string | null, stateAbbrev: string | null, stateName: string | null }> | null} */
let resolvedPromise = null;
/** @type {string} */
let resolvedEnvKey = '';

function envLocationKey(env) {
  return [
    String(env.WEATHER_ZIP || ''),
    String(env.WEATHER_LAT || ''),
    String(env.WEATHER_LON || ''),
  ].join('|');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ lat: number, lon: number, zip: string | null, city: string | null, place: string | null, stateAbbrev: string | null, stateName: string | null }>}
 */
async function resolveDashboardWeatherLatLonUncached(env = process.env) {
  const zipRaw = String(env.WEATHER_ZIP || '').replace(/\D/g, '');
  if (zipRaw.length === 5) {
    const g = await geocodeUsZip5(zipRaw);
    if (g) {
      return {
        lat: g.lat,
        lon: g.lon,
        zip: zipRaw,
        city: g.city || null,
        place: g.place || null,
        stateAbbrev: g.stateAbbrev,
        stateName: g.stateName,
      };
    }
  }
  const lat = parseFloat(env.WEATHER_LAT ?? String(DEFAULT_LAT));
  const lon = parseFloat(env.WEATHER_LON ?? String(DEFAULT_LON));
  return {
    lat: Number.isFinite(lat) ? lat : DEFAULT_LAT,
    lon: Number.isFinite(lon) ? lon : DEFAULT_LON,
    zip: null,
    city: null,
    place: null,
    stateAbbrev: null,
    stateName: null,
  };
}

/**
 * Primary dashboard map point: optional WEATHER_ZIP overrides WEATHER_LAT/LON.
 * Coalesces concurrent callers so a page-load fan-out shares one resolution.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ lat: number, lon: number, zip: string | null, city: string | null, place: string | null, stateAbbrev: string | null, stateName: string | null }>}
 */
export async function resolveDashboardWeatherLatLon(env = process.env) {
  const key = envLocationKey(env);
  if (resolvedPromise && resolvedEnvKey === key) return resolvedPromise;
  resolvedEnvKey = key;
  resolvedPromise = resolveDashboardWeatherLatLonUncached(env);
  return resolvedPromise;
}
