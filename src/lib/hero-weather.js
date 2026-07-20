/**
 * Hero city current weather: Open-Meteo primary, NWS observations fallback.
 * Cached server-side so browser reloads do not burn the public Open-Meteo quota.
 */
import { fetchOpenMeteoCurrentUsAqi } from './dashboard-air-quality.js';
import { fetchNwsPointsDocument } from './nws-points.js';

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const CACHE_MS = 10 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;
const FETCH_MS = 14_000;

/** @type {Map<string, { at: number, value: object }>} */
const cache = new Map();
/** @type {Map<string, Promise<object>>} */
const inFlight = new Map();

function nwsUserAgent() {
  const u = (process.env.NWS_USER_AGENT || '').trim();
  return u || 'Dashbird/1.0 (dashbird dashboard; NWS api.weather.gov)';
}

function cacheKey(lat, lon) {
  return `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
}

/**
 * Map NWS shortForecast / textDescription / icon path to a WMO-ish code
 * used by the hero icon set.
 * @param {string} text
 * @param {string} [iconUrl]
 */
export function nwsTextToWeatherCode(text, iconUrl = '') {
  const t = String(text || '').toLowerCase();
  const icon = String(iconUrl || '').toLowerCase();
  const path = icon.split('?')[0];

  if (/thunder|tstm|storm/.test(t) || /\/tsra|\/tstorms?/.test(path)) return 95;
  if (/snow|blizzard|sleet|ice/.test(t) || /\/snow|\/ip|\/blizzard/.test(path)) return 71;
  if (/fog|haze|mist/.test(t) || /\/fog|\/haze/.test(path)) return 45;
  if (/drizzle/.test(t)) return 51;
  if (/shower/.test(t) || /\/shra|\/rain_showers/.test(path)) return 80;
  if (/rain|precip/.test(t) || /\/rain|\/ra/.test(path)) return 61;
  if (/\bovc\b|overcast|mostly cloudy|cloudy|bkn/.test(t) || /\/ovc|\/bkn/.test(path)) return 3;
  if (/partly|scattered|\bsct\b/.test(t) || /\/sct|\/few/.test(path)) return 2;
  if (/mainly clear|mostly clear|mostly sunny|fair/.test(t)) return 1;
  if (/clear|sunny|\bskc\b/.test(t) || /\/skc/.test(path)) return 0;
  return 2;
}

/**
 * @param {unknown} qty
 * @returns {number | null}
 */
function nwsQuantityValue(qty) {
  if (!qty || typeof qty !== 'object') return null;
  const n = Number(/** @type {{ value?: unknown }} */ (qty).value);
  return Number.isFinite(n) ? n : null;
}

function cToF(c) {
  return (c * 9) / 5 + 32;
}

function kmhToMph(kmh) {
  return kmh * 0.621371;
}

/**
 * Prefer ICAO/METAR-style station ids (e.g. KOAK) over personal weather stations.
 * @param {Array<{ id?: string, properties?: { stationIdentifier?: string } }>} features
 */
function rankStationFeatures(features) {
  return [...features].sort((a, b) => {
    const idA = String(a?.properties?.stationIdentifier || '').toUpperCase();
    const idB = String(b?.properties?.stationIdentifier || '').toUpperCase();
    const score = (id) => {
      if (/^K[A-Z0-9]{3}$/.test(id)) return 0;
      if (/^[A-Z]{4}$/.test(id)) return 1;
      return 2;
    };
    return score(idA) - score(idB);
  });
}

/**
 * @param {number} lat
 * @param {number} lon
 */
async function fetchFromOpenMeteo(lat, lon) {
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,uv_index',
  );
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min');
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_MS);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: { 'User-Agent': 'dashbird/1.0 (hero weather; open-meteo.com)' },
    });
    if (!r.ok) {
      const err = new Error(`open_meteo_http_${r.status}`);
      /** @type {any} */ (err).status = r.status;
      throw err;
    }
    const data = await r.json();
    const cur = data?.current;
    if (!cur || typeof cur.temperature_2m !== 'number') {
      throw new Error('open_meteo_no_current');
    }
    const uvRaw = cur.uv_index;
    const daily = data?.daily;
    const highRaw = Array.isArray(daily?.temperature_2m_max) ? daily.temperature_2m_max[0] : null;
    const lowRaw = Array.isArray(daily?.temperature_2m_min) ? daily.temperature_2m_min[0] : null;
    return {
      ok: true,
      provider: 'open-meteo',
      tempF: cur.temperature_2m,
      apparentF: typeof cur.apparent_temperature === 'number' ? cur.apparent_temperature : null,
      code: Number(cur.weather_code) || 0,
      windMph: typeof cur.wind_speed_10m === 'number' ? cur.wind_speed_10m : null,
      windDirectionFromDeg:
        typeof cur.wind_direction_10m === 'number' ? cur.wind_direction_10m : null,
      highF: typeof highRaw === 'number' && Number.isFinite(highRaw) ? highRaw : null,
      lowF: typeof lowRaw === 'number' && Number.isFinite(lowRaw) ? lowRaw : null,
      uvIndex: typeof uvRaw === 'number' && Number.isFinite(uvRaw) ? uvRaw : null,
      usAqi: null,
      description: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} stationUrl
 */
async function fetchNwsStationObservation(stationUrl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_MS);
  try {
    const r = await fetch(`${stationUrl.replace(/\/+$/, '')}/observations/latest`, {
      signal: ac.signal,
      headers: {
        'User-Agent': nwsUserAgent(),
        Accept: 'application/geo+json',
      },
    });
    if (!r.ok) return null;
    const doc = await r.json();
    const p = doc?.properties;
    if (!p) return null;
    const tempC = nwsQuantityValue(p.temperature);
    if (tempC == null) return null;
    const windKmh = nwsQuantityValue(p.windSpeed);
    const windDir = nwsQuantityValue(p.windDirection);
    const desc = typeof p.textDescription === 'string' ? p.textDescription.trim() : '';
    const icon = typeof p.icon === 'string' ? p.icon : '';
    const tempF = cToF(tempC);
    return {
      ok: true,
      provider: 'nws',
      tempF,
      apparentF: tempF,
      code: nwsTextToWeatherCode(desc, icon),
      windMph: windKmh != null ? kmhToMph(windKmh) : null,
      windDirectionFromDeg: windDir,
      highF: null,
      lowF: null,
      uvIndex: null,
      usAqi: null,
      description: desc,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {number} lat
 * @param {number} lon
 */
async function fetchFromNws(lat, lon) {
  const points = await fetchNwsPointsDocument(lat, lon);
  const stationsUrl = points?.properties?.observationStations;
  if (typeof stationsUrl !== 'string' || !stationsUrl.startsWith('http')) {
    throw new Error('nws_no_stations_url');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_MS);
  let stationsDoc;
  try {
    const r = await fetch(stationsUrl, {
      signal: ac.signal,
      headers: {
        'User-Agent': nwsUserAgent(),
        Accept: 'application/geo+json',
      },
    });
    if (!r.ok) throw new Error(`nws_stations_http_${r.status}`);
    stationsDoc = await r.json();
  } finally {
    clearTimeout(timer);
  }

  const features = Array.isArray(stationsDoc?.features) ? stationsDoc.features : [];
  const ranked = rankStationFeatures(features).slice(0, 8);
  for (const f of ranked) {
    const id = typeof f?.id === 'string' ? f.id : '';
    if (!id.startsWith('http')) continue;
    const obs = await fetchNwsStationObservation(id);
    if (obs) return obs;
  }
  throw new Error('nws_no_usable_observation');
}

/**
 * @param {number} lat
 * @param {number} lon
 */
async function fetchHeroCurrentWeatherUncached(lat, lon) {
  let weather;
  let upstreamError = '';
  try {
    weather = await fetchFromOpenMeteo(lat, lon);
  } catch (e) {
    const name = e?.name ? String(e.name) : '';
    if (name === 'AbortError') upstreamError = 'open_meteo_timeout';
    else upstreamError = String(e?.message || e);
    weather = await fetchFromNws(lat, lon);
  }

  const aqi = await fetchOpenMeteoCurrentUsAqi({ lat, lon }).catch(() => ({ ok: false }));
  if (aqi?.ok && typeof aqi.usAqi === 'number') {
    weather.usAqi = aqi.usAqi;
  }

  return {
    ...weather,
    ok: true,
    lat,
    lon,
    upstreamError: upstreamError || undefined,
  };
}

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<object>}
 */
export async function fetchHeroCurrentWeather(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    throw new Error('invalid_lat_lon');
  }
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) {
    throw new Error('lat_lon_out_of_range');
  }

  const key = cacheKey(la, lo);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) {
    return { ...hit.value, cached: true };
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = (async () => {
    try {
      const value = await fetchHeroCurrentWeatherUncached(la, lo);
      cache.set(key, { at: Date.now(), value });
      return { ...value, cached: false };
    } catch (e) {
      if (hit && now - hit.at < STALE_MS) {
        return { ...hit.value, cached: true, stale: true, error: String(e?.message || e) };
      }
      throw e;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, work);
  return work;
}
