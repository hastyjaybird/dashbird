/**
 * RainViewer radar frames for a map tile grid centered on dashboard ZIP.
 * @see https://www.rainviewer.com/api.html
 */

const RV_API = 'https://api.rainviewer.com/public/weather-maps.json';
/** Visible radius from WEATHER_ZIP / dashboard coordinates. */
export const RADAR_RADIUS_MI = 5;
export const RADAR_DIAMETER_MI = RADAR_RADIUS_MI * 2;
export const TILE_SIZE = 256;
/** RainViewer tile API max zoom (@see https://www.rainviewer.com/api/weather-maps-api.html) */
export const RAINVIEWER_MAX_ZOOM = 7;
const RAINVIEWER_MIN_ZOOM = 4;

/**
 * Slippy-map basemap under RainViewer radar-only tiles.
 * @param {{ x: number, y: number, z: number }} tile
 */
export function openStreetMapTileUrl(tile) {
  return `https://tile.openstreetmap.org/${tile.z}/${tile.x}/${tile.y}.png`;
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} zoom
 */
export function latLonToTile(lat, lon, zoom) {
  const f = latLonTileFraction(lat, lon, zoom);
  return { x: f.x, y: f.y, z: f.z };
}

/**
 * Tile indices plus fractional position within the tile (for zoom/crop centering).
 * @param {number} lat
 * @param {number} lon
 * @param {number} zoom
 */
export function latLonTileFraction(lat, lon, zoom) {
  const n = 2 ** zoom;
  const xf = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yf =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return {
    x: Math.floor(xf),
    y: Math.floor(yf),
    z: zoom,
    fx: xf - Math.floor(xf),
    fy: yf - Math.floor(yf),
  };
}

/**
 * Meters per pixel at `lat` for slippy-map zoom `z`.
 * @param {number} lat
 * @param {number} zoom
 */
export function metersPerPixel(lat, zoom) {
  return (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * Zoom so `grid` tiles across `viewportPx` span about `diameterMi` at `lat`.
 * @param {number} lat
 * @param {number} diameterMi
 * @param {number} [viewportPx]
 * @param {number} [grid]
 */
export function zoomForDiameterMiles(lat, diameterMi, viewportPx = 280, grid = 1) {
  const diameterM = diameterMi * 1609.34;
  const mpp = diameterM / Math.max(80, viewportPx);
  const z = Math.log2((156543.03 * Math.cos((lat * Math.PI) / 180)) / mpp);
  return Math.min(RAINVIEWER_MAX_ZOOM, Math.max(RAINVIEWER_MIN_ZOOM, Math.round(z)));
}

/**
 * RainViewer.com map.html zoom for a radius (external link).
 * @param {number} lat
 * @param {number} radiusMi
 */
export function mapZoomForRadiusMi(lat, radiusMi) {
  const diameterM = radiusMi * 2 * 1609.34;
  const viewportPx = 640;
  const mpp = diameterM / viewportPx;
  const z = Math.log2((156543.03 * Math.cos((lat * Math.PI) / 180)) / mpp);
  return Math.min(15, Math.max(6, Math.round(z)));
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
 * @param {number} [p.radiusMi]
 */
export function buildRadarTilePayload({
  lat,
  lon,
  host,
  frames,
  radiusMi = RADAR_RADIUS_MI,
}) {
  const diameterMi = radiusMi * 2;
  const grid = 1;
  const zoom = zoomForDiameterMiles(lat, diameterMi, 280, grid);
  const center = latLonTileFraction(lat, lon, zoom);
  const half = Math.floor(grid / 2);
  /** @type {Array<{ x: number, y: number, z: number }>} */
  const tiles = [];
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      tiles.push({ x: center.x + dx, y: center.y + dy, z: zoom });
    }
  }
  const tileSpanMi = (grid * TILE_SIZE * metersPerPixel(lat, zoom)) / 1609.34;
  const cropScale = Math.max(1, tileSpanMi / diameterMi);
  return {
    lat,
    lon,
    zoom,
    radiusMi,
    diameterMi,
    host,
    tileSize: TILE_SIZE,
    grid,
    cropScale,
    center: { x: center.x, y: center.y, z: center.z, fx: center.fx, fy: center.fy },
    tiles,
    frames: frames.slice(-8),
  };
}
