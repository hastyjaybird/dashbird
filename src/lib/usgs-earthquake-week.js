/**
 * Largest recent California earthquake within 150 miles of Oakland, CA (USGS FDSNWS event API).
 * Qualifying rows stay on the Earth strip for 24 hours after the event time
 * (dashboard `WEATHER_TIME_ZONE` for display clock).
 * @see https://earthquake.usgs.gov/fdsnws/event/1/
 */
import {
  EARTHQUAKE_DISPLAY_MS,
  earthquakePinLocationKey,
  loadEarthquakePin,
  saveEarthquakePin,
} from './usgs-earthquake-pin-store.js';

const USGS_QUERY = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const EARTH_RADIUS_MI = 3958.7613; // mean Earth radius, statute miles
const KM_PER_MI = 1.609344;
const WINDOW_MS = EARTHQUAKE_DISPLAY_MS;
const RADIUS_MI = 150;
// Search center: downtown Oakland, CA (fixed — not the dashboard weather point).
const CENTER_LAT = 37.8044;
const CENTER_LON = -122.2712;
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

/**
 * USGS `place` strings for California quakes end in ", CA" (e.g. "5 km SSE of
 * Berkeley, CA") or name the state (e.g. "offshore of Northern California").
 * A 150-mile circle around Oakland reaches Nevada, so this keeps CA-only rows.
 * @param {unknown} place
 */
function isCaliforniaPlace(place) {
  const s = String(place || '').trim().toLowerCase();
  if (!s) return false;
  return /,\s*ca$/.test(s) || s.includes('california');
}

function dashTimeZone(env = process.env) {
  return String(env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
}

/**
 * @param {number} timeMs
 * @param {number} [nowMs]
 */
function isWithinDisplayWindow(timeMs, nowMs = Date.now()) {
  if (!Number.isFinite(timeMs)) return false;
  const age = nowMs - timeMs;
  return age >= 0 && age < EARTHQUAKE_DISPLAY_MS;
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

/**
 * @param {number} timeMs
 * @param {string} timeZone
 * @returns {string} e.g. "8/4 2:15 PM"
 */
function eventDateTimeFromMs(timeMs, timeZone) {
  if (!Number.isFinite(timeMs)) return '';
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timeMs));
  return formatted.replace(',', '');
}

/**
 * @param {object} pin
 * @param {string} timeZone
 * @param {number} [nowMs]
 */
function buildStripItemFromPin(pin, timeZone, nowMs = Date.now()) {
  if (!isWithinDisplayWindow(pin.timeMs, nowMs)) return null;

  const distWhole = Math.max(0, Math.round(pin.distMi));
  const depthStr = formatDepthKmShort(pin.depthKm);
  const magStr = (Math.round(pin.mag * 10) / 10).toFixed(1);
  const parts = [`M${magStr}`];
  if (depthStr) parts.push(depthStr);
  parts.push(`${distWhole} mi`);

  const eventMd = eventMdFromMs(pin.timeMs, timeZone);
  const eventAt = eventDateTimeFromMs(pin.timeMs, timeZone);
  if (eventAt) parts.push(eventAt);

  return {
    earthType: 'usgs_quake_week_max',
    label: 'Earthquake',
    quakeAsOfMd: eventMd || null,
    detailLine: parts.join(' · '),
    forecastUrl: pin.url || 'https://earthquake.usgs.gov/earthquakes/map/',
    quakeEventMd: eventMd || null,
    quakeEventAt: eventAt || null,
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
    if (!isCaliforniaPlace(props.place)) continue;

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
    if (!isWithinDisplayWindow(timeMs)) continue;

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
 * Fixed search: California quakes within 150 mi of downtown Oakland.
 * @returns {Promise<{ ok: true, item: object | null } | { ok: false, error: string }>}
 */
export async function buildUsgsEarthquakeWeekItem() {
  const lat = CENTER_LAT;
  const lon = CENTER_LON;

  const timeZone = dashTimeZone();
  const nowMs = Date.now();
  const locKey = earthquakePinLocationKey(lat, lon);

  let pin = await loadEarthquakePin(locKey);
  if (pin && !isWithinDisplayWindow(pin.timeMs, nowMs)) {
    pin = null;
    await saveEarthquakePin(locKey, null);
  }

  const fetched = await fetchStrongestUsgsQuake(lat, lon);
  if (!fetched.ok) {
    if (pin) {
      const item = buildStripItemFromPin(pin, timeZone, nowMs);
      return { ok: true, item, pinned: true, upstream: fetched.error };
    }
    return { ok: false, error: fetched.error };
  }

  const fresh = fetched.quake;
  if (fresh) {
    const isNewEvent = !pin || pin.eventId !== fresh.eventId;
    if (isNewEvent) {
      pin = { ...fresh };
      await saveEarthquakePin(locKey, pin);
    } else {
      pin = { ...pin, ...fresh };
      await saveEarthquakePin(locKey, pin);
    }
  } else if (!pin) {
    await saveEarthquakePin(locKey, null);
    return { ok: true, item: null };
  }

  const item = buildStripItemFromPin(pin, timeZone, nowMs);
  if (!item) {
    await saveEarthquakePin(locKey, null);
    return { ok: true, item: null };
  }

  return {
    ok: true,
    item,
    pinned: Boolean(fresh) || Boolean(pin),
  };
}
