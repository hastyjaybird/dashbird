/**
 * Sidebar Air Quality panel: US AQI at WEATHER_ZIP / WEATHER_LAT+LON; PurpleAir map when above threshold.
 */
import { fetchOpenMeteoCurrentUsAqi, usAqiCategoryStyle } from './dashboard-air-quality.js';
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';

/** Show panel when current US AQI is strictly above this value. */
export const AQI_SHOW_THRESHOLD = 80;

/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} [zoom]
 */
export function purpleAirMapEmbedUrl(lat, lon, zoom = 12) {
  const la = Number(lat);
  const lo = Number(lon);
  const z = Math.min(14, Math.max(5, Math.round(Number(zoom) || 11)));
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    return 'https://map.purpleair.com/map';
  }
  return `https://map.purpleair.com/map?opt=1/loc/${la.toFixed(4)}/${lo.toFixed(4)}/${z}`;
}

function airQualityDisabled(env = process.env) {
  return String(env.AIR_QUALITY || '').trim() === '0';
}

/** Default on until unset — local testing visibility. */
function airQualityForceShow(env = process.env) {
  const v = String(env.AIR_QUALITY_FORCE_SHOW ?? '1').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @returns {Promise<object>}
 */
export async function getAirQualityPanelPayload() {
  if (airQualityDisabled()) {
    return { ok: true, disabled: true, show: false };
  }

  const forceShow = airQualityForceShow();
  const { lat, lon, zip } = await resolveDashboardWeatherLatLon();
  const timeZone = (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
  const mapUrl = purpleAirMapEmbedUrl(lat, lon);
  const mapPageUrl = mapUrl;

  const aqi = await fetchOpenMeteoCurrentUsAqi({ lat, lon, timeZone });
  if (!aqi.ok) {
    return {
      ok: false,
      show: forceShow,
      forceShow,
      error: aqi.error,
      zip,
      lat,
      lon,
      mapUrl,
      mapPageUrl,
      threshold: AQI_SHOW_THRESHOLD,
    };
  }

  const style = usAqiCategoryStyle(aqi.usAqi);
  const aboveThreshold = aqi.usAqi > AQI_SHOW_THRESHOLD;
  const show = forceShow || aboveThreshold;

  return {
    ok: true,
    show,
    forceShow,
    aboveThreshold,
    usAqi: aqi.usAqi,
    category: style.label,
    categoryHex: style.hex,
    zip,
    lat,
    lon,
    timeIso: aqi.timeIso,
    mapUrl,
    mapPageUrl,
    productUrl: 'https://www.purpleair.com/map',
    aqiSource: 'Open-Meteo air-quality API (US EPA AQI)',
    threshold: AQI_SHOW_THRESHOLD,
  };
}
