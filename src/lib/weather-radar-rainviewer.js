/**
 * RainViewer radar frames for a map tile grid (5 mi diameter view).
 * @see https://www.rainviewer.com/api.html
 */

const RV_API = 'https://api.rainviewer.com/public/weather-maps.json';
const DIAMETER_MI = 5;
const TILE_SIZE = 256;
/** RainViewer tile API max zoom (@see https://www.rainviewer.com/api/weather-maps-api.html) */
export const RAINVIEWER_MAX_ZOOM = 7;
const RAINVIEWER_MIN_ZOOM = 4;

/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} zoom
 */
export function latLonToTile(lat, lon, zoom) {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y, z: zoom };
}

/**
 * Zoom so `containerPx` spans about `diameterMi` at `lat`.
 * @param {number} lat
 * @param {number} diameterMi
 * @param {number} [containerPx]
 */
export function zoomForDiameterMiles(lat, diameterMi, containerPx = 220) {
  const diameterM = diameterMi * 1609.34;
  const mpp = diameterM / Math.max(80, containerPx);
  const z = Math.log2((156543.03 * Math.cos((lat * Math.PI) / 180)) / mpp);
  return Math.min(RAINVIEWER_MAX_ZOOM, Math.max(RAINVIEWER_MIN_ZOOM, Math.round(z)));
}

/**
 * @returns {Promise<{ host: string, frames: Array<{ time: number, path: string }> } | null>}
 */
export async function fetchRainViewerFrames() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const r = await fetch(RV_API, {
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const host = typeof j.host === 'string' ? j.host : 'https://tilecache.rainviewer.com';
    const past = Array.isArray(j?.radar?.past) ? j.radar.past : [];
    const frames = past
      .filter((f) => f && typeof f.path === 'string')
      .map((f) => ({ time: Number(f.time) || 0, path: f.path }));
    if (!frames.length) return null;
    return { host, frames };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} p
 * @param {number} p.lat
 * @param {number} p.lon
 * @param {string} p.host
 * @param {Array<{ time: number, path: string }>} p.frames
 * @param {number} [p.diameterMi]
 */
export function buildRadarTilePayload({ lat, lon, host, frames, diameterMi = DIAMETER_MI }) {
  const zoom = zoomForDiameterMiles(lat, diameterMi);
  const center = latLonToTile(lat, lon, zoom);
  const grid = 3;
  const half = Math.floor(grid / 2);
  /** @type {Array<{ x: number, y: number, z: number }>} */
  const tiles = [];
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      tiles.push({ x: center.x + dx, y: center.y + dy, z: zoom });
    }
  }
  return {
    lat,
    lon,
    zoom,
    diameterMi,
    host,
    tileSize: TILE_SIZE,
    grid,
    center,
    tiles,
    frames: frames.slice(-8),
  };
}
