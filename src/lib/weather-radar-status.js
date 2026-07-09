/**
 * Weather radar visibility + IEM map payload (shared by API route and Settings status).
 *
 * Troubleshooting default: always show when enabled (ignore 24h precip gate for display).
 * Gate logic is retained — set WEATHER_RADAR_GATE=1 (or unset ALWAYS troubleshooting)
 * when restoring precip-gated visibility. For now WEATHER_RADAR_ALWAYS defaults on unless
 * explicitly set to 0, and precip gate is skipped unless WEATHER_RADAR_GATE=1.
 */
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';
import {
  precipExpectedWithin24Hours,
  rainImminentWithin2Hours,
} from './rain-imminent.js';
import { buildIemRadarPayload, RADAR_RADIUS_MI } from './weather-radar-iem.js';

export function radarDisabled() {
  return String(process.env.WEATHER_RADAR || '').trim() === '0';
}

/**
 * Troubleshooting: show radar even with no precip.
 * Default ON while troubleshooting; set WEATHER_RADAR_ALWAYS=0 to honor the gate early,
 * or WEATHER_RADAR_GATE=1 to force precip-gated visibility.
 */
export function radarForceShow() {
  if (String(process.env.WEATHER_RADAR_GATE || '').trim() === '1') return false;
  const raw = String(process.env.WEATHER_RADAR_ALWAYS || '').trim();
  if (raw === '0') return false;
  // Default: always show (troubleshooting). Explicit 1 also always show.
  return true;
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

  const [rain2h, precip24h] = await Promise.all([
    rainImminentWithin2Hours(geo.lat, geo.lon, tz),
    precipExpectedWithin24Hours(geo.lat, geo.lon, tz),
  ]);

  const precipExpected = Boolean(precip24h.expected);
  const show = forceShow || precipExpected;

  if (!show) {
    return {
      ok: true,
      show: false,
      precipExpected24h: false,
      imminent: rain2h.imminent,
      zip: geo.zip,
      geo: { lat: geo.lat, lon: geo.lon, displayName: geo.displayName, source: geo.source },
    };
  }

  const radar = buildIemRadarPayload(geo.lat, geo.lon, RADAR_RADIUS_MI, tz);

  return {
    ok: true,
    show: true,
    precipExpected24h: precipExpected,
    imminent: rain2h.imminent,
    testMode: forceShow && !precipExpected,
    troubleshooting: forceShow,
    zip: geo.zip,
    geo: { lat: geo.lat, lon: geo.lon, displayName: geo.displayName, source: geo.source },
    minutesUntil: rain2h.minutesUntil,
    hoursUntilPrecip: precip24h.hoursUntil,
    provider: 'iem',
    embed: {
      mapPageUrl: radar.mapPageUrl,
      lat: geo.lat,
      lon: geo.lon,
      radiusMi: RADAR_RADIUS_MI,
    },
    radar,
  };
}
