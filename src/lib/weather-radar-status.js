/**
 * Weather radar visibility + embed (shared by API route and Settings status).
 */
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';
import {
  precipExpectedWithin24Hours,
  rainImminentWithin2Hours,
} from './rain-imminent.js';
import {
  buildRadarTilePayload,
  fetchRainViewerFrames,
  mapZoomForRadiusMi,
  RADAR_RADIUS_MI,
} from './weather-radar-rainviewer.js';

export function radarDisabled() {
  return String(process.env.WEATHER_RADAR || '').trim() === '0';
}

export function radarForceShow() {
  return String(process.env.WEATHER_RADAR_ALWAYS || '').trim() === '1';
}

/**
 * @returns {Promise<object>}
 */
export async function getWeatherRadarStatus() {
  if (radarDisabled()) {
    return { ok: true, disabled: true, show: false };
  }

  const dash = await resolveDashboardWeatherLatLon();
  const geo = {
    lat: dash.lat,
    lon: dash.lon,
    displayName: dash.zip ? `ZIP ${dash.zip}` : 'Dashboard coordinates',
  };

  const tz = String(process.env.TZ || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  const forceShow = radarForceShow();
  const [rain2h, precip24h] = await Promise.all([
    rainImminentWithin2Hours(geo.lat, geo.lon, tz),
    precipExpectedWithin24Hours(geo.lat, geo.lon, tz),
  ]);

  if (!forceShow && !precip24h.expected) {
    return {
      ok: true,
      show: false,
      precipExpected24h: false,
      imminent: rain2h.imminent,
      zip: dash.zip,
      geo: { lat: geo.lat, lon: geo.lon, displayName: geo.displayName },
    };
  }

  const message =
    forceShow && !precip24h.expected
      ? `Radar test mode · ${RADAR_RADIUS_MI} mi radius from dashboard ZIP`
      : rain2h.imminent && rain2h.message
        ? rain2h.message
        : precip24h.hoursUntil != null && precip24h.hoursUntil > 0
          ? `Precipitation possible in ~${precip24h.hoursUntil} hours`
          : 'Precipitation possible in the next 24 hours';

  const mapZoom = mapZoomForRadiusMi(geo.lat, RADAR_RADIUS_MI);
  const mapPageUrl = `https://www.rainviewer.com/map.html?loc=${geo.lat.toFixed(4)},${geo.lon.toFixed(4)},${mapZoom}`;

  const rv = await fetchRainViewerFrames();
  if (!rv) {
    return {
      ok: true,
      show: true,
      precipExpected24h: precip24h.expected,
      imminent: rain2h.imminent,
      testMode: forceShow,
      zip: dash.zip,
      geo: { lat: geo.lat, lon: geo.lon, displayName: geo.displayName },
      minutesUntil: rain2h.minutesUntil,
      hoursUntilPrecip: precip24h.hoursUntil,
      message,
      provider: 'link',
      embed: { mapPageUrl, lat: geo.lat, lon: geo.lon, radiusMi: RADAR_RADIUS_MI },
      radarUnavailable: true,
    };
  }

  const radar = buildRadarTilePayload({
    lat: geo.lat,
    lon: geo.lon,
    host: rv.host,
    frames: rv.frames,
    radiusMi: RADAR_RADIUS_MI,
  });

  return {
    ok: true,
    show: true,
    precipExpected24h: precip24h.expected,
    imminent: rain2h.imminent,
    testMode: forceShow,
    zip: dash.zip,
    geo: { lat: geo.lat, lon: geo.lon, displayName: geo.displayName },
    minutesUntil: rain2h.minutesUntil,
    hoursUntilPrecip: precip24h.hoursUntil,
    message,
    provider: 'rainviewer',
    embed: { mapPageUrl, lat: geo.lat, lon: geo.lon, radiusMi: RADAR_RADIUS_MI },
    radar,
  };
}
