/**
 * Windy.com embedded radar — smooth live animation, global composite radar.
 * @see https://embed.windy.com/configurator.html
 * @see https://community.windy.com/topic/10/how-to-embed-windy-to-your-website
 */
export const WINDY_EMBED_BASE = 'https://embed.windy.com/embed2.html';
export const WINDY_MAP_PAGE = 'https://www.windy.com/-Radar-radar?radar,';

/**
 * @param {number} lat
 * @param {number} lon
 * @param {{ zoom?: number }} [options]
 */
export function buildWindyRadarEmbedUrl(lat, lon, options = {}) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    return `${WINDY_EMBED_BASE}?overlay=radar&product=radar`;
  }

  const zoom = Math.min(15, Math.max(5, Math.round(Number(options.zoom) || 11)));
  const latStr = la.toFixed(4);
  const lonStr = lo.toFixed(4);

  const u = new URL(WINDY_EMBED_BASE);
  u.searchParams.set('lat', latStr);
  u.searchParams.set('lon', lonStr);
  u.searchParams.set('detailLat', latStr);
  u.searchParams.set('detailLon', lonStr);
  u.searchParams.set('zoom', String(zoom));
  u.searchParams.set('level', 'surface');
  u.searchParams.set('overlay', 'radar');
  u.searchParams.set('product', 'radar');
  u.searchParams.set('type', 'map');
  u.searchParams.set('location', 'coordinates');
  u.searchParams.set('metricWind', 'default');
  u.searchParams.set('metricTemp', 'default');
  u.searchParams.set('radarRange', '-1');
  u.searchParams.set('calendar', 'now');
  /** Empty values trim embed chrome where Windy supports it. */
  u.searchParams.set('menu', '');
  u.searchParams.set('message', '');
  u.searchParams.set('detail', '');
  u.searchParams.set('marker', '');
  u.searchParams.set('pressure', '');
  return u.toString();
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} [zoom]
 */
export function windyMapPageUrl(lat, lon, zoom = 11) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return 'https://www.windy.com/';
  const z = Math.min(15, Math.max(5, Math.round(Number(zoom) || 11)));
  return `${WINDY_MAP_PAGE}${la.toFixed(4)},${lo.toFixed(4)},${z}`;
}
