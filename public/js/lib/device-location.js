/** @typedef {{ lat: number, lon: number, accuracy?: number, shortLabel?: string, label?: string, timeZone?: string, source: 'device' | 'config' }} DevicePlace */

/** @type {DevicePlace | null} */
let current = null;

/** @type {Set<(place: DevicePlace) => void>} */
const listeners = new Set();

/** @type {(() => void) | null} */
let stopWatch = null;

/** @type {Promise<DevicePlace | null> | null} */
let bootPromise = null;

const MIN_MOVE_M = 400;
const REVERSE_DEBOUNCE_MS = 800;

/** @type {ReturnType<typeof setTimeout> | null} */
let reverseTimer = null;

/** @type {{ lat: number, lon: number } | null} */
let lastReverseAt = null;

/**
 * True when label looks like raw lat/lon rather than City, ST.
 * @param {string} [label]
 */
function looksLikeCoordinates(label) {
  const s = String(label || '').trim();
  return /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(s);
}

/**
 * Prefer City, ST; never surface raw coordinates in the header.
 * @param {string | undefined} candidate
 * @param {string | undefined} fallback
 */
function cityStateLabel(candidate, fallback) {
  const c = typeof candidate === 'string' ? candidate.trim() : '';
  if (c && !looksLikeCoordinates(c)) return c;
  const f = typeof fallback === 'string' ? fallback.trim() : '';
  if (f && !looksLikeCoordinates(f)) return f;
  return 'Locating…';
}

/**
 * @param {DevicePlace | null} place
 */
function setCurrent(place) {
  if (!place) return;
  current = place;
  for (const fn of listeners) fn(place);
}

/**
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 */
function distanceMeters(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} [accuracy]
 */
function scheduleReverseGeocode(lat, lon, accuracy) {
  if (
    lastReverseAt &&
    distanceMeters(lastReverseAt.lat, lastReverseAt.lon, lat, lon) < MIN_MOVE_M
  ) {
    setCurrent({
      lat,
      lon,
      accuracy,
      shortLabel: cityStateLabel(current?.shortLabel, 'Locating…'),
      label: current?.label,
      timeZone: current?.timeZone,
      source: 'device',
    });
    return;
  }

  if (reverseTimer) clearTimeout(reverseTimer);
  reverseTimer = setTimeout(async () => {
    reverseTimer = null;
    lastReverseAt = { lat, lon };
    const keepLabel = cityStateLabel(current?.shortLabel, 'Locating…');
    try {
      const r = await fetch(
        `/api/geolocation/reverse?lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lon))}`,
        { cache: 'no-store' },
      );
      if (!r.ok) {
        setCurrent({
          lat,
          lon,
          accuracy,
          shortLabel: keepLabel === 'Locating…' ? 'Location unavailable' : keepLabel,
          label: current?.label,
          timeZone: current?.timeZone,
          source: 'device',
        });
        return;
      }
      const j = await r.json();
      setCurrent({
        lat,
        lon,
        accuracy,
        shortLabel: cityStateLabel(j.shortLabel, keepLabel),
        label: typeof j.label === 'string' ? j.label : undefined,
        timeZone: typeof j.timeZone === 'string' ? j.timeZone : current?.timeZone,
        source: 'device',
      });
    } catch {
      setCurrent({
        lat,
        lon,
        accuracy,
        shortLabel: keepLabel === 'Locating…' ? 'Location unavailable' : keepLabel,
        label: current?.label,
        timeZone: current?.timeZone,
        source: 'device',
      });
    }
  }, REVERSE_DEBOUNCE_MS);
}

/**
 * @param {Record<string, unknown>} config
 * @returns {DevicePlace}
 */
function placeFromConfig(config) {
  const lat = Number(config?.weatherLat);
  const lon = Number(config?.weatherLon);
  const tz = (config?.weatherTimeZone || '').trim() || '';
  const place =
    (typeof config?.weatherPlace === 'string' && config.weatherPlace.trim()) ||
    (typeof config?.locationLabel === 'string'
      ? String(config.locationLabel).split('·')[0].trim()
      : '') ||
    'Dashboard location';
  return {
    lat: Number.isFinite(lat) ? lat : 0,
    lon: Number.isFinite(lon) ? lon : 0,
    shortLabel: cityStateLabel(place, 'Dashboard location'),
    timeZone: tz,
    source: 'config',
  };
}

/**
 * @param {Record<string, unknown>} config
 * @returns {Promise<DevicePlace | null>}
 */
export function startDeviceLocation(config) {
  if (bootPromise) return bootPromise;

  bootPromise = new Promise((resolve) => {
    const fallback = placeFromConfig(config);
    current = fallback;
    let settled = false;
    const finish = (place) => {
      if (settled) return;
      settled = true;
      current = place;
      resolve(place);
    };

    if (!navigator.geolocation) {
      finish(fallback);
      return;
    }

    const onPosition = (pos) => {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const keep = cityStateLabel(current?.shortLabel, 'Locating…');
      const place = {
        lat,
        lon,
        accuracy,
        shortLabel: keep === fallback.shortLabel ? 'Locating…' : keep,
        label: current?.label,
        timeZone: current?.timeZone || fallback.timeZone,
        source: 'device',
      };
      setCurrent(place);
      finish(place);
      scheduleReverseGeocode(lat, lon, accuracy);
    };

    const onError = () => {
      finish(fallback);
    };

    navigator.geolocation.getCurrentPosition(onPosition, onError, {
      enableHighAccuracy: false,
      maximumAge: 120_000,
      timeout: 12_000,
    });

    const watchId = navigator.geolocation.watchPosition(onPosition, () => {}, {
      enableHighAccuracy: false,
      maximumAge: 120_000,
      timeout: 20_000,
    });

    stopWatch = () => {
      navigator.geolocation.clearWatch(watchId);
      if (reverseTimer) clearTimeout(reverseTimer);
    };
  });

  return bootPromise;
}

/** @returns {DevicePlace | null} */
export function getDevicePlace() {
  return current;
}

/**
 * @param {(place: DevicePlace) => void} fn
 * @returns {() => void}
 */
export function subscribeDevicePlace(fn) {
  if (current) fn(current);
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Query string for rain alert using current place (live GPS or dashboard fallback). */
export function rainAlertQueryString() {
  return devicePlaceQueryString();
}

/**
 * Query string with lat/lon (+ optional shortLabel) for APIs that prefer device location.
 * @param {{ includeLabel?: boolean }} [opts]
 */
export function devicePlaceQueryString(opts = {}) {
  const p = current;
  if (!p) return '';
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return '';
  const params = new URLSearchParams();
  params.set('lat', String(p.lat));
  params.set('lon', String(p.lon));
  if (opts.includeLabel !== false) {
    const label = typeof p.shortLabel === 'string' ? p.shortLabel.trim() : '';
    if (label && label !== 'Locating…') params.set('label', label);
  }
  return `?${params.toString()}`;
}

export function stopDeviceLocationWatch() {
  if (stopWatch) stopWatch();
  stopWatch = null;
}
