/**
 * Resolve home vs Away (preview / auto) dashboard location.
 */
import { geocodeUsZip5 } from './zip-geocode.js';
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';
import { loadAwayBase, getActiveAwayProfile } from './away-base-store.js';
import { haversineMiles } from './dashboard-geo.js';

/**
 * @typedef {{
 *   mode: 'home' | 'preview' | 'away',
 *   lat: number,
 *   lon: number,
 *   zip: string | null,
 *   city: string | null,
 *   place: string | null,
 *   stateAbbrev: string | null,
 *   stateName: string | null,
 *   timeZone: string,
 *   label: string,
 *   home: Awaited<ReturnType<typeof resolveDashboardWeatherLatLon>>,
 *   awayProfile: import('./away-base-store.js').AwayProfile | null,
 *   hideEarth: string[],
 *   events: {
 *     partifulRegion: string | null,
 *     facebookLocation: string | null,
 *     filterCities: string[] | null,
 *     maxMiles: number | null,
 *   },
 * }} ActiveLocation
 */

/**
 * @param {import('./away-base-store.js').AwayProfile} profile
 */
async function resolveAwayCoords(profile) {
  const g = await geocodeUsZip5(profile.zip);
  if (g) {
    return {
      lat: g.lat,
      lon: g.lon,
      zip: profile.zip,
      city: g.city || null,
      place: g.place || profile.label || null,
      stateAbbrev: g.stateAbbrev,
      stateName: g.stateName,
    };
  }
  return {
    lat: NaN,
    lon: NaN,
    zip: profile.zip,
    city: null,
    place: profile.label || null,
    stateAbbrev: null,
    stateName: null,
  };
}

/**
 * @param {{
 *   forceMode?: 'home' | 'preview' | 'away',
 *   deviceLat?: number,
 *   deviceLon?: number,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {Promise<ActiveLocation>}
 */
export async function resolveActiveLocation(opts = {}) {
  const env = opts.env || process.env;
  const home = await resolveDashboardWeatherLatLon(env);
  const state = await loadAwayBase();
  const profile = getActiveAwayProfile(state);

  let mode = /** @type {'home' | 'preview' | 'away'} */ ('home');
  if (opts.forceMode === 'home' || opts.forceMode === 'preview' || opts.forceMode === 'away') {
    mode = opts.forceMode;
  } else if (state.autoAway && profile) {
    mode = 'away';
  } else if (state.preview && profile) {
    mode = 'preview';
  } else if (
    profile &&
    Number.isFinite(opts.deviceLat) &&
    Number.isFinite(opts.deviceLon)
  ) {
    const awayCoords = await resolveAwayCoords(profile);
    if (Number.isFinite(awayCoords.lat) && Number.isFinite(awayCoords.lon)) {
      const d = haversineMiles(
        /** @type {number} */ (opts.deviceLat),
        /** @type {number} */ (opts.deviceLon),
        awayCoords.lat,
        awayCoords.lon,
      );
      if (Number.isFinite(d) && d <= (profile.radiusMi || 40)) {
        mode = 'away';
      }
    }
  }

  const homeTz =
    String(env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
  const homeLabel =
    String(env.DASHBOARD_LOCATION_LABEL || '').trim() ||
    home.place ||
    (home.zip ? String(home.zip) : 'Home');

  /** @type {ActiveLocation} */
  const base = {
    mode: 'home',
    lat: home.lat,
    lon: home.lon,
    zip: home.zip,
    city: home.city,
    place: home.place,
    stateAbbrev: home.stateAbbrev,
    stateName: home.stateName,
    timeZone: homeTz,
    label: homeLabel,
    home,
    awayProfile: profile,
    hideEarth: [],
    events: {
      partifulRegion: null,
      facebookLocation: null,
      filterCities: null,
      maxMiles: null,
    },
  };

  if ((mode === 'preview' || mode === 'away') && profile) {
    const away = await resolveAwayCoords(profile);
    if (!Number.isFinite(away.lat) || !Number.isFinite(away.lon)) {
      return base;
    }
    return {
      mode,
      lat: away.lat,
      lon: away.lon,
      zip: away.zip,
      city: away.city,
      place: away.place || profile.label,
      stateAbbrev: away.stateAbbrev,
      stateName: away.stateName,
      timeZone: profile.timeZone || 'America/New_York',
      label: profile.label || away.place || profile.zip,
      home,
      awayProfile: profile,
      hideEarth: Array.isArray(profile.hideEarth) ? [...profile.hideEarth] : [],
      events: {
        partifulRegion: profile.events?.partifulRegion || null,
        facebookLocation: profile.events?.facebookLocation || null,
        filterCities: profile.events?.filterCities || null,
        maxMiles:
          profile.events?.maxMiles != null && Number.isFinite(profile.events.maxMiles)
            ? profile.events.maxMiles
            : null,
      },
    };
  }

  return base;
}

/**
 * Parse location mode hint from request query/header.
 * @param {import('express').Request} req
 * @returns {'home' | 'preview' | 'away' | null}
 */
export function locationModeFromRequest(req) {
  const q = String(req.query?.locationMode || req.query?.base || '').trim().toLowerCase();
  if (q === 'home' || q === 'preview' || q === 'away') return q;
  const h = String(req.get?.('x-dashbird-location-mode') || '').trim().toLowerCase();
  if (h === 'home' || h === 'preview' || h === 'away') return h;
  return null;
}
