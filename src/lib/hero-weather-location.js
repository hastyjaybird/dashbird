import { geocodeUsZip5 } from './zip-geocode.js';

const DEFAULT_LAT = 37.848;
const DEFAULT_LON = -122.253;

/**
 * Primary dashboard map point: optional WEATHER_ZIP overrides WEATHER_LAT/LON.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ lat: number, lon: number, zip: string | null, stateAbbrev: string | null, stateName: string | null }>}
 */
export async function resolveDashboardWeatherLatLon(env = process.env) {
  const zipRaw = String(env.WEATHER_ZIP || '').replace(/\D/g, '');
  if (zipRaw.length === 5) {
    const g = await geocodeUsZip5(zipRaw);
    if (g) return { lat: g.lat, lon: g.lon, zip: zipRaw, stateAbbrev: g.stateAbbrev, stateName: g.stateName };
  }
  const lat = parseFloat(env.WEATHER_LAT ?? String(DEFAULT_LAT));
  const lon = parseFloat(env.WEATHER_LON ?? String(DEFAULT_LON));
  return {
    lat: Number.isFinite(lat) ? lat : DEFAULT_LAT,
    lon: Number.isFinite(lon) ? lon : DEFAULT_LON,
    zip: null,
    stateAbbrev: null,
    stateName: null,
  };
}
