/**
 * Largest recent earthquake near the dashboard point (USGS FDSNWS event API).
 * Qualifying rows persist on the Earth strip for two calendar days; the event date
 * appears on the second day (dashboard `WEATHER_TIME_ZONE`).
 * @see https://earthquake.usgs.gov/fdsnws/event/1/
 */
import {
  EARTHQUAKE_DISPLAY_CALENDAR_DAYS,
  earthquakePinLocationKey,
  loadEarthquakePin,
  saveEarthquakePin,
} from './usgs-earthquake-pin-store.js';

const USGS_QUERY = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const EARTH_RADIUS_MI = 3958.7613; // mean Earth radius, statute miles
const KM_PER_MI = 1.609344;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RADIUS_MI = 30;
const MIN_MAG_EXCLUSIVE = 3;
const FETCH_LIMIT = 300;
const FETCH_TIMEOUT_MS = 18_000;

/**
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Great-circle distance in statute miles
 */
function haversineMiles(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(lat2 - lat1);
  const dLon = r(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MI * c;
}

/**
 * @param {number | null | undefined} depthKm from GeoJSON third coordinate or properties.depth
 */
function formatDepthKmShort(depthKm) {
  if (typeof depthKm !== 'number' || !Number.isFinite(depthKm)) return null;
  const rounded = Math.round(depthKm * 10) / 10;
  const s = rounded === Math.round(rounded) ? String(Math.round(rounded)) : String(rounded);
  return `${s} km`;
}

function dashTimeZone(env = process.env) {
  return String(env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
}

/**
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string} YYYY-MM-DD
 */
function wallYmdAt(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * @param {string} ymd YYYY-MM-DD
 */
function wallYmdToUtcNoon(ymd) {
  const [y, m, d] = ymd.split('-').map((x) => Number.parseInt(x, 10));
  return Date.UTC(y, m - 1, d, 12, 0, 0);
}

/**
 * @param {string} fromYmd
 * @param {string} toYmd
 */
function calendarDaysSince(fromYmd, toYmd) {
  const a = wallYmdToUtcNoon(fromYmd);
  const b = wallYmdToUtcNoon(toYmd);
  return Math.round((b - a) / 86400000);
}

/**
 * @param {number} timeMs
 * @param {string} timeZone
 * @returns {string} M/D
 */
function eventMdFromMs(timeMs, timeZone) {
  if (!Number.isFinite(timeMs)) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(timeMs));
  const mo = parts.find((p) => p.type === 'month')?.value ?? '';
  const da = parts.find((p) => p.type === 'day')?.value ?? '';
  return mo && da ? `${mo}/${da}` : '';
}

/** @param {string} ymd YYYY-MM-DD */
function ymdToMdSlash(ymd) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${Number.parseInt(m[2], 10)}/${Number.parseInt(m[3], 10)}`;
}

/**
 * @param {object} pin
 * @param {string} todayYmd
 * @param {string} timeZone
 */
function buildStripItemFromPin(pin, todayYmd, timeZone) {
  const dayIndex = calendarDaysSince(pin.firstShownYmd, todayYmd);
  if (dayIndex < 0 || dayIndex >= EARTHQUAKE_DISPLAY_CALENDAR_DAYS) return null;

  const distWhole = Math.max(0, Math.round(pin.distMi));
  const depthStr = formatDepthKmShort(pin.depthKm);
  const magStr = (Math.round(pin.mag * 10) / 10).toFixed(1);
  const parts = [`M${magStr}`];
  if (depthStr) parts.push(depthStr);
  parts.push(`${distWhole} mi`);

  const eventMd = eventMdFromMs(pin.timeMs, timeZone);
  const showEventDate = dayIndex >= 1;
  if (showEventDate && eventMd) parts.push(eventMd);

  return {
    earthType: 'usgs_quake_week_max',
    label: 'Earthquake',
    quakeAsOfMd: showEventDate && eventMd ? eventMd : ymdToMdSlash(todayYmd),
    detailLine: parts.join(' · '),
    forecastUrl: pin.url || 'https://earthquake.usgs.gov/earthquakes/map/',
    quakeEventMd: eventMd || null,
    quakeDisplayDay: dayIndex + 1,
  };
}

/**
 * @param {number} lat
 * @param {number} lon
 */
async function fetchStrongestUsgsQuake(lat, lon) {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_MS);
  const maxradiuskm = (RADIUS_MI * KM_PER_MI).toFixed(2);

  const url = new URL(USGS_QUERY);
  url.searchParams.set('format', 'geojson');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('maxradiuskm', maxradiuskm);
  url.searchParams.set('starttime', `${start.toISOString().split('.')[0]}Z`);
  url.searchParams.set('endtime', `${end.toISOString().split('.')[0]}Z`);
  url.searchParams.set('minmagnitude', '3');
  url.searchParams.set('orderby', 'magnitude');
  url.searchParams.set('limit', String(FETCH_LIMIT));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url.toString(), {
      signal: ac.signal,
      headers: {
        Accept: 'application/geo+json, application/json;q=0.9',
        'User-Agent': 'Dashbird/1.0 (dashboard earthquake summary; https://earthquake.usgs.gov/)',
      },
    });
  } catch (e) {
    clearTimeout(timer);
    const msg =
      e && typeof e === 'object' && 'name' in e && e.name === 'AbortError'
        ? 'usgs_timeout'
        : 'usgs_fetch_failed';
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return { ok: false, error: `usgs_http_${res.status}` };
  }

  let doc;
  try {
    doc = await res.json();
  } catch {
    return { ok: false, error: 'usgs_bad_json' };
  }

  const features = Array.isArray(doc?.features) ? doc.features : [];
  let best = null;

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const props = f?.properties;
    const geom = f?.geometry;
    const coords = geom?.coordinates;
    if (!props || !Array.isArray(coords) || coords.length < 2) continue;

    const mag = Number(props.mag);
    if (!Number.isFinite(mag) || mag <= MIN_MAG_EXCLUSIVE) continue;

    const evLon = Number(coords[0]);
    const evLat = Number(coords[1]);
    if (!Number.isFinite(evLon) || !Number.isFinite(evLat)) continue;

    const depthFromZ = coords.length >= 3 ? Number(coords[2]) : NaN;
    const depthKm = Number.isFinite(depthFromZ)
      ? depthFromZ
      : typeof props.depth === 'number' && Number.isFinite(props.depth)
        ? props.depth
        : null;

    const distMi = haversineMiles(lat, lon, evLat, evLon);
    if (!Number.isFinite(distMi) || distMi > RADIUS_MI + 0.25) continue;

    const timeMs = Number(props.time);
    const eventId =
      typeof f.id === 'string' && f.id.trim() !== ''
        ? f.id.trim()
        : `${timeMs}:${mag}:${evLat.toFixed(3)},${evLon.toFixed(3)}`;

    if (!best || mag > best.mag) {
      best = {
        eventId,
        timeMs,
        mag,
        depthKm,
        distMi,
        url:
          typeof props.url === 'string' && /^https?:\/\//i.test(props.url.trim())
            ? props.url.trim()
            : '',
        title: typeof props.title === 'string' ? props.title.trim() : '',
      };
    }
  }

  return { ok: true, quake: best };
}

/**
 * @param {{ lat: number, lon: number }} p
 * @returns {Promise<{ ok: true, item: object | null } | { ok: false, error: string }>}
 */
export async function buildUsgsEarthquakeWeekItem(p) {
  const { lat, lon } = p;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: 'bad_lat_lon' };
  }

  const timeZone = dashTimeZone();
  const todayYmd = wallYmdAt(new Date(), timeZone);
  const locKey = earthquakePinLocationKey(lat, lon);

  let pin = await loadEarthquakePin(locKey);
  if (
    pin &&
    typeof pin.firstShownYmd === 'string' &&
    calendarDaysSince(pin.firstShownYmd, todayYmd) >= EARTHQUAKE_DISPLAY_CALENDAR_DAYS
  ) {
    pin = null;
    await saveEarthquakePin(locKey, null);
  }

  const fetched = await fetchStrongestUsgsQuake(lat, lon);
  if (!fetched.ok) {
    if (pin) {
      const item = buildStripItemFromPin(pin, todayYmd, timeZone);
      return { ok: true, item, pinned: true, upstream: fetched.error };
    }
    return { ok: false, error: fetched.error };
  }

  const fresh = fetched.quake;
  if (fresh) {
    const isNewEvent = !pin || pin.eventId !== fresh.eventId;
    if (isNewEvent) {
      pin = {
        ...fresh,
        firstShownYmd: todayYmd,
      };
      await saveEarthquakePin(locKey, pin);
    } else {
      pin = { ...pin, ...fresh };
      await saveEarthquakePin(locKey, pin);
    }
  } else if (!pin) {
    await saveEarthquakePin(locKey, null);
    return { ok: true, item: null };
  }

  const item = buildStripItemFromPin(pin, todayYmd, timeZone);
  if (!item) {
    await saveEarthquakePin(locKey, null);
    return { ok: true, item: null };
  }

  return { ok: true, item, pinned: Boolean(fresh) || calendarDaysSince(pin.firstShownYmd, todayYmd) > 0 };
}
