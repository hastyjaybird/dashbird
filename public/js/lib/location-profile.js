/**
 * Away base mode: preview (manual) + auto geofence from device GPS.
 */
import { getDevicePlace, subscribeDevicePlace } from './device-location.js';

/** @typedef {'home' | 'preview' | 'away'} LocationMode */

/** @type {LocationMode} */
let mode = 'home';

/** @type {object | null} */
let lastConfig = null;

/** @type {Set<(mode: LocationMode, meta: object) => void>} */
const listeners = new Set();

let started = false;
/** @type {number} */
let lastAutoPatchAt = 0;
const AUTO_PATCH_MIN_MS = 30_000;

/**
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 */
function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 3958.8 * c;
}

/**
 * @param {LocationMode} next
 * @param {object} [meta]
 */
function setMode(next, meta = {}) {
  if (mode === next && !meta.forceNotify) return;
  mode = next;
  for (const fn of listeners) {
    try {
      fn(mode, meta);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @returns {LocationMode}
 */
export function getLocationMode() {
  return mode;
}

/**
 * @param {(mode: LocationMode, meta: object) => void} fn
 */
export function subscribeLocationMode(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * @param {object} config
 * @param {{ silent?: boolean }} [opts]
 */
export function applyConfigLocationMode(config, opts = {}) {
  lastConfig = config;
  const m = String(config?.locationMode || 'home');
  if (m === 'preview' || m === 'away' || m === 'home') {
    // Silent on boot so we do not reload-loop when already Away/preview.
    if (opts.silent) {
      mode = m;
      return;
    }
    setMode(m, { source: 'config', config });
  }
}

/**
 * @param {{ preview?: boolean, autoAway?: boolean, zip?: string, label?: string, radiusMi?: number }} body
 */
export async function patchAwayBase(body) {
  const r = await fetch('/api/away-base', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) {
    throw new Error(j?.error || `away_base_${r.status}`);
  }
  if (j.locationMode === 'preview' || j.locationMode === 'away' || j.locationMode === 'home') {
    setMode(j.locationMode, { source: 'patch', state: j });
  }
  return j;
}

/**
 * Decide auto-away from a device place vs config home/away.
 * @param {import('./device-location.js').DevicePlace | null | undefined} place
 * @param {object} [config]
 */
export async function evaluateGeofence(place, config = lastConfig) {
  if (!place || place.source !== 'device') return;
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return;
  const away = config?.awayBase;
  const home = config?.homeBase;
  if (!away || !Number.isFinite(Number(away.zip))) {
    /* need resolved coords — fetch away-base */
  }
  let awayLat = Number(away?.lat);
  let awayLon = Number(away?.lon);
  const radiusMi = Number(away?.radiusMi) > 0 ? Number(away.radiusMi) : 40;

  if (!Number.isFinite(awayLat) || !Number.isFinite(awayLon)) {
    try {
      const r = await fetch('/api/away-base', { cache: 'no-store' });
      const j = await r.json();
      awayLat = Number(j?.resolved?.lat);
      awayLon = Number(j?.resolved?.lon);
      if (j?.activeProfile?.radiusMi > 0) {
        /* use profile radius */
      }
    } catch {
      return;
    }
  }
  if (!Number.isFinite(awayLat) || !Number.isFinite(awayLon)) return;

  const dAway = haversineMiles(place.lat, place.lon, awayLat, awayLon);
  let dHome = Infinity;
  if (home && Number.isFinite(home.lat) && Number.isFinite(home.lon)) {
    dHome = haversineMiles(place.lat, place.lon, home.lat, home.lon);
  }

  const insideAway = Number.isFinite(dAway) && dAway <= radiusMi;
  const insideHome = Number.isFinite(dHome) && dHome <= radiusMi;
  const now = Date.now();
  if (now - lastAutoPatchAt < AUTO_PATCH_MIN_MS) return;

  if (insideAway && !insideHome) {
    if (mode !== 'away' || config?.awayBase?.autoAway !== true) {
      lastAutoPatchAt = now;
      try {
        await patchAwayBase({ autoAway: true, preview: false });
        setMode('away', { source: 'geofence', miles: dAway });
        window.dispatchEvent(new CustomEvent('dashbird:location-mode', { detail: { mode: 'away' } }));
      } catch {
        /* ignore */
      }
    }
  } else if (insideHome && mode === 'away') {
    lastAutoPatchAt = now;
    try {
      await patchAwayBase({ autoAway: false, preview: false });
      setMode('home', { source: 'geofence', miles: dHome });
      window.dispatchEvent(new CustomEvent('dashbird:location-mode', { detail: { mode: 'home' } }));
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {object} config
 */
export function startLocationProfile(config) {
  applyConfigLocationMode(config, { silent: true });
  if (started) return;
  started = true;
  subscribeDevicePlace((place) => {
    void evaluateGeofence(place, lastConfig);
  });
  const place = getDevicePlace();
  if (place) void evaluateGeofence(place, config);
}

/**
 * Soft reload when mode changes so panels pick up /api/config overrides.
 */
export function reloadForLocationMode() {
  try {
    sessionStorage.setItem('dashbird-location-reload', String(Date.now()));
  } catch {
    /* ignore */
  }
  window.location.reload();
}
