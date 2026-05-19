/**
 * U.S. National Weather Service API (api.weather.gov), same program family as
 * https://forecast.weather.gov — requires a descriptive User-Agent.
 * @see https://www.weather.gov/documentation/services-web-api
 */

const CACHE_MS = 10 * 60 * 1000;
/** @type {Map<string, { at: number, doc: object }>} */
const pointsCache = new Map();

function nwsUserAgent() {
  const u = (process.env.NWS_USER_AGENT || '').trim();
  return u || 'Dashbird/1.0 (dashbird dashboard; NWS api.weather.gov)';
}

function clampLatLon(lat, lon) {
  const la = typeof lat === 'number' && Number.isFinite(lat) ? lat : 0;
  const lo = typeof lon === 'number' && Number.isFinite(lon) ? lon : 0;
  return { lat: Math.min(90, Math.max(-90, la)), lon: ((lo + 180) % 360 + 360) % 360 - 180 };
}

/**
 * @param {number} lat
 * @param {number} lon
 */
export function mapClickUrlForLatLon(lat, lon) {
  const { lat: la, lon: lo } = clampLatLon(lat, lon);
  const latS = la.toFixed(4);
  const lonS = lo.toFixed(4);
  return `https://forecast.weather.gov/MapClick.php?lat=${encodeURIComponent(latS)}&lon=${encodeURIComponent(lonS)}`;
}

/**
 * Raw GeoJSON Feature for /points/{lat},{lon} (cached).
 * @param {number} lat
 * @param {number} lon
 */
export async function fetchNwsPointsDocument(lat, lon) {
  const { lat: la, lon: lo } = clampLatLon(lat, lon);
  const key = `${la.toFixed(4)},${lo.toFixed(4)}`;
  const now = Date.now();
  const hit = pointsCache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.doc;

  const url = `https://api.weather.gov/points/${key}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': nwsUserAgent(),
      Accept: 'application/geo+json',
    },
  });
  if (!r.ok) throw new Error(`nws_points_http_${r.status}`);
  const doc = await r.json();
  if (!doc?.properties) throw new Error('nws_points_bad_json');
  pointsCache.set(key, { at: now, doc });
  return doc;
}

/**
 * Sunset instant + IANA zone from NWS points `astronomicalData` (civil sun times in grid timezone).
 * @param {number} lat
 * @param {number} lon
 */
export async function getHeroAstronomyFromNws(lat, lon) {
  const doc = await fetchNwsPointsDocument(lat, lon);
  const p = doc.properties;
  const tz =
    typeof p.timeZone === 'string' && /^[A-Za-z_/+-]+$/.test(p.timeZone) ? p.timeZone : 'America/Los_Angeles';
  const ad = p.astronomicalData;
  if (!ad || typeof ad.sunset !== 'string') throw new Error('nws_no_astronomical_data');
  const sunset = new Date(ad.sunset.trim());
  if (Number.isNaN(sunset.getTime())) throw new Error('nws_sunset_parse');

  const { lat: la, lon: lo } = clampLatLon(lat, lon);
  const nwsMapClickUrl = mapClickUrlForLatLon(la, lo);
  const nwsForecastUrl = typeof p.forecast === 'string' && p.forecast.startsWith('http') ? p.forecast : nwsMapClickUrl;
  const nwsPointsUrl =
    typeof doc.id === 'string' ? doc.id : `https://api.weather.gov/points/${la.toFixed(4)},${lo.toFixed(4)}`;

  return {
    sunsetEpochMs: sunset.getTime(),
    timeZone: tz,
    nwsForecastUrl,
    nwsMapClickUrl,
    nwsPointsUrl,
  };
}
