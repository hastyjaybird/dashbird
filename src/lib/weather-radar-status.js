/**
 * Weather radar visibility + IEM map payload (shared by API route and Settings status).
 *
 * Default: show only when precip is active / imminent within ~20 mi (Open-Meteo sample).
 * Set WEATHER_RADAR_ALWAYS=1 to force the card on for troubleshooting.
 */
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';
import {
  precipActiveWithinRadius,
  rainImminentWithin2Hours,
  RADAR_PRECIP_RADIUS_MI,
} from './rain-imminent.js';
import { buildIemRadarPayload, RADAR_RADIUS_MI } from './weather-radar-iem.js';

export function radarDisabled() {
  return String(process.env.WEATHER_RADAR || '').trim() === '0';
}

/**
 * Force radar card visible even with no nearby precip (troubleshooting).
 * Opt-in via WEATHER_RADAR_ALWAYS=1.
 */
export function radarForceShow() {
  return String(process.env.WEATHER_RADAR_ALWAYS || '').trim() === '1';
}

function parseCoord(raw, min, max) {
  const n = Number.parseFloat(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * Prefer device lat/lon from query; else dashboard ZIP / lat-lon.
 * @param {{ lat?: unknown, lon?: unknown, label?: unknown }} [opts]
 */
export async function resolveRadarGeo(opts = {}) {
  const qLat = parseCoord(opts.lat, -90, 90);
  const qLon = parseCoord(opts.lon, -180, 180);
  if (qLat != null && qLon != null) {
    const label =
      typeof opts.label === 'string' && opts.label.trim()
        ? opts.label.trim()
        : 'Device location';
    return {
      lat: qLat,
      lon: qLon,
      displayName: label,
      zip: null,
      source: /** @type {'device'} */ ('device'),
    };
  }

  const dash = await resolveDashboardWeatherLatLon();
  return {
    lat: dash.lat,
    lon: dash.lon,
    displayName:
      dash.place || (dash.zip ? `ZIP ${dash.zip}` : 'Dashboard coordinates'),
    zip: dash.zip ?? null,
    source: /** @type {'dashboard'} */ ('dashboard'),
  };
}

/**
 * @param {{ lat?: unknown, lon?: unknown, label?: unknown }} [opts]
 * @returns {Promise<object>}
 */
export async function getWeatherRadarStatus(opts = {}) {
  if (radarDisabled()) {
    return { ok: true, disabled: true, show: false };
  }

  const geo = await resolveRadarGeo(opts);
  const tz = String(process.env.TZ || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  const forceShow = radarForceShow();
  const radiusMi = RADAR_RADIUS_MI;

  const [rain2h, nearby] = await Promise.all([
    rainImminentWithin2Hours(geo.lat, geo.lon, tz),
    precipActiveWithinRadius(geo.lat, geo.lon, RADAR_PRECIP_RADIUS_MI, tz),
  ]);

  const precipNearby = Boolean(nearby.expected);
  const show = forceShow || precipNearby;

  if (!show) {
    return {
      ok: true,
      show: false,
      precipNearby: false,
      precipRadiusMi: RADAR_PRECIP_RADIUS_MI,
      imminent: rain2h.imminent,
      zip: geo.zip,
      geo: { lat: geo.lat, lon: geo.lon, displayName: geo.displayName, source: geo.source },
    };
  }

  const radar = buildIemRadarPayload(geo.lat, geo.lon, radiusMi, tz);

  return {
    ok: true,
    show: true,
    precipNearby,
    precipRadiusMi: RADAR_PRECIP_RADIUS_MI,
    imminent: rain2h.imminent,
    testMode: forceShow && !precipNearby,
    troubleshooting: forceShow,
    zip: geo.zip,
    geo: { lat: geo.lat, lon: geo.lon, displayName: geo.displayName, source: geo.source },
    minutesUntil: rain2h.minutesUntil,
    hoursUntilPrecip: nearby.hoursUntil,
    provider: 'iem',
    embed: {
      mapPageUrl: radar.mapPageUrl,
      lat: geo.lat,
      lon: geo.lon,
      radiusMi,
    },
    radar,
  };
}
