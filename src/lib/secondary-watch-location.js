import { geocodeUsZip5 } from './zip-geocode.js';
import { loadSecondaryWatchZip } from './secondary-watch-zip-store.js';

/**
 * @param {string} zip
 * @returns {Promise<{ zip: string, lat: number, lon: number, place: string, timeZone: string } | null>}
 */
export async function resolveWatchLocationForZip(zip) {
  const geo = await geocodeUsZip5(zip);
  if (!geo) return null;

  const st = String(geo.stateAbbrev || '').toUpperCase();
  const timeZone =
    st === 'CA'
      ? 'America/Los_Angeles'
      : st === 'AK'
        ? 'America/Anchorage'
        : st === 'HI'
          ? 'Pacific/Honolulu'
          : 'America/New_York';

  return {
    zip,
    lat: geo.lat,
    lon: geo.lon,
    place: geo.place,
    timeZone,
  };
}

/**
 * @returns {Promise<{ zip: string, lat: number, lon: number, place: string, timeZone: string } | null>}
 */
export async function resolveSecondaryWatchLocation() {
  const zip = await loadSecondaryWatchZip();
  return resolveWatchLocationForZip(zip);
}
