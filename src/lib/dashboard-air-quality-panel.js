/**
 * Sidebar Air Quality panel: US AQI at WEATHER_ZIP / WEATHER_LAT+LON; embeddable air-quality map when above threshold.
 *
 * Map: Windy PM2.5 overlay. PurpleAir's current map (map.purpleair.com) blocks iframe embedding
 * ("Unsupported browser"), so we use Windy's embed which is purpose-built for iframes and needs no key.
 */
import { fetchOpenMeteoCurrentUsAqi, usAqiCategoryStyle } from './dashboard-air-quality.js';
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';

/** Show panel when current US AQI is strictly above this value (>50 = Moderate or worse). */
export const AQI_SHOW_THRESHOLD = 50;

/**
 * Windy embed showing the PM2.5 (fine particulate) air-quality overlay centered on the location.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [zoom]
 */
export function airQualityMapEmbedUrl(lat, lon, zoom = 8) {
  const la = Number(lat);
  const lo = Number(lon);
  const z = Math.min(11, Math.max(4, Math.round(Number(zoom) || 8)));
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    return 'https://embed.windy.com/embed2.html?overlay=pm2p5&type=map';
  }
  const p = new URLSearchParams({
    lat: la.toFixed(4),
    lon: lo.toFixed(4),
    detailLat: la.toFixed(4),
    detailLon: lo.toFixed(4),
    zoom: String(z),
    level: 'surface',
    overlay: 'pm2p5',
    menu: '',
    message: '',
    marker: 'true',
    calendar: '',
    pressure: '',
    type: 'map',
    location: 'coordinates',
    detail: '',
    metricWind: 'mph',
    metricTemp: '°F',
    radarRange: '-1',
  });
  return `https://embed.windy.com/embed2.html?${p.toString()}`;
}

/**
 * Windy full-site air-quality page (opens in a new tab for the "Full map" link).
 * @param {number} lat
 * @param {number} lon
 * @param {number} [zoom]
 */
export function airQualityMapPageUrl(lat, lon, zoom = 8) {
  const la = Number(lat);
  const lo = Number(lon);
  const z = Math.min(11, Math.max(4, Math.round(Number(zoom) || 8)));
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    return 'https://www.windy.com/-Air-quality-pm2p5';
  }
  return `https://www.windy.com/-Air-quality-pm2p5?pm2p5,${la.toFixed(3)},${lo.toFixed(3)},${z}`;
}

function airQualityDisabled(env = process.env) {
  return String(env.AIR_QUALITY || '').trim() === '0';
}

/** Off by default — panel stays hidden until AQI is Moderate or worse. Set AIR_QUALITY_FORCE_SHOW=1 to force it on for testing. */
function airQualityForceShow(env = process.env) {
  const v = String(env.AIR_QUALITY_FORCE_SHOW ?? '0').trim().toLowerCase();
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
  const mapUrl = airQualityMapEmbedUrl(lat, lon);
  const mapPageUrl = airQualityMapPageUrl(lat, lon);

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
    productUrl: 'https://www.windy.com/-Air-quality-pm2p5',
    aqiSource: 'Open-Meteo air-quality API (US EPA AQI)',
    mapSource: 'Windy PM2.5 overlay',
    threshold: AQI_SHOW_THRESHOLD,
  };
}
