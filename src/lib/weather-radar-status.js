/**
 * Weather radar visibility + embed (shared by API route and Settings status).
 * Map centers on dashboard WEATHER_ZIP (or WEATHER_LAT/LON when ZIP unset).
 */
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';
import {
  precipExpectedWithin24Hours,
  rainImminentWithin2Hours,
} from './rain-imminent.js';
import { buildWindyRadarEmbedUrl, windyMapPageUrl } from './weather-radar-windy.js';

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

  const { lat, lon, zip } = await resolveDashboardWeatherLatLon();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: true, show: false, geocodeError: true, zip };
  }

  const tz =
    String(process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
  const forceShow = radarForceShow();
  const [rain2h, precip24h] = await Promise.all([
    rainImminentWithin2Hours(lat, lon, tz),
    precipExpectedWithin24Hours(lat, lon, tz),
  ]);

  const geo = { lat, lon, zip: zip || null };

  if (!forceShow && !precip24h.expected) {
    return {
      ok: true,
      show: false,
      precipExpected24h: false,
      imminent: rain2h.imminent,
      geo,
    };
  }

  const embedUrl = buildWindyRadarEmbedUrl(lat, lon);
  const mapPageUrl = windyMapPageUrl(lat, lon);
  const message =
    forceShow && !precip24h.expected
      ? 'Radar test mode'
      : rain2h.imminent && rain2h.message
        ? rain2h.message
        : precip24h.hoursUntil != null && precip24h.hoursUntil > 0
          ? `Precipitation possible in ~${precip24h.hoursUntil} hours`
          : 'Precipitation possible in the next 24 hours';

  return {
    ok: true,
    show: true,
    precipExpected24h: precip24h.expected,
    imminent: rain2h.imminent,
    testMode: forceShow,
    geo,
    minutesUntil: rain2h.minutesUntil,
    hoursUntilPrecip: precip24h.hoursUntil,
    message,
    provider: 'windy',
    embed: {
      url: embedUrl,
      mapPageUrl,
      lat,
      lon,
      zip: zip || null,
    },
  };
}
