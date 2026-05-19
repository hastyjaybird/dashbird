/**
 * Weather radar visibility + embed (shared by API route and Settings status).
 */
import { geocodeAddress } from './geocode-address.js';
import { loadRainAlertAddress } from './rain-alert-address-store.js';
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

  const address = await loadRainAlertAddress();
  const geo = await geocodeAddress(address);
  if (!geo) {
    return { ok: true, show: false, geocodeError: true, address };
  }

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
      address,
      geo: { lat: geo.lat, lon: geo.lon, displayName: geo.displayName },
    };
  }

  const embedUrl = buildWindyRadarEmbedUrl(geo.lat, geo.lon);
  const mapPageUrl = windyMapPageUrl(geo.lat, geo.lon);
  const message =
    forceShow && !precip24h.expected
      ? 'Radar test mode · centered on rain alert address'
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
    address,
    geo: { lat: geo.lat, lon: geo.lon, displayName: geo.displayName },
    minutesUntil: rain2h.minutesUntil,
    hoursUntilPrecip: precip24h.hoursUntil,
    message,
    provider: 'windy',
    embed: {
      url: embedUrl,
      mapPageUrl,
      lat: geo.lat,
      lon: geo.lon,
    },
  };
}
