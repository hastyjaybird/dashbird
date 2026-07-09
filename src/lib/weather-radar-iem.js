/**
 * Iowa Environmental Mesonet (IEM) radar tiles for Leaflet.
 * @see https://mesonet.agron.iastate.edu/ogc/
 */

export const RADAR_RADIUS_MI = 40;
export const IEM_TILE_BASE = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0';
/** Carto Dark Matter — policy-friendly dark basemap. */
export const CARTO_DARK_URL =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
export const CARTO_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
export const IEM_ATTR =
  'Radar &copy; <a href="https://mesonet.agron.iastate.edu/ogc/">Iowa Environmental Mesonet</a>';

const MIN_ZOOM = 5;
const MAX_ZOOM = 10;
const VIEWPORT_PX = 300;

/**
 * Zoom so the map width ≈ diameterMi at lat.
 * @param {number} lat
 * @param {number} diameterMi
 * @param {number} [viewportPx]
 */
export function zoomForDiameterMiles(lat, diameterMi, viewportPx = VIEWPORT_PX) {
  const diameterM = Math.max(5, diameterMi) * 1609.34;
  const mpp = diameterM / Math.max(80, viewportPx);
  const cos = Math.cos((lat * Math.PI) / 180);
  const z = Math.log2((156543.03 * Math.max(0.2, cos)) / mpp);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z)));
}

/**
 * External NWS radar page.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [zoom]
 */
export function externalRadarMapUrl(lat, lon, zoom = 8) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return 'https://radar.weather.gov/';
  const z = Math.min(10, Math.max(5, Math.round(Number(zoom) || 8)));
  return `https://radar.weather.gov/?center=${la.toFixed(4)},${lo.toFixed(4)}&zoom=${z}`;
}

/**
 * Round UTC time down to even minute (MRMS archive cadence).
 * @param {Date} d
 */
function floorEvenUtcMinute(d) {
  const t = new Date(d.getTime());
  t.setUTCSeconds(0, 0);
  if (t.getUTCMinutes() % 2 === 1) {
    t.setUTCMinutes(t.getUTCMinutes() - 1);
  }
  return t;
}

/**
 * Local wall-clock label (dashboard TZ). The old `Z` suffix was Zulu/UTC.
 * @param {Date} d
 * @param {string} timeZone
 */
export function formatRadarLocalTime(d, timeZone) {
  try {
    return d.toLocaleTimeString('en-US', {
      timeZone: timeZone || 'America/Los_Angeles',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }
}

/**
 * Past-hour MRMS SeamlessHSR frames (archived) + current q2-hsr.
 * Archive id: mrms::lcref-YYYYMMDDHHMI (even minutes).
 * @param {Date} [now]
 * @param {string} [timeZone]
 * @returns {Array<{ id: string, time: number, label: string, isCurrent?: boolean }>}
 */
export function buildMrmsFrameList(now = new Date(), timeZone = 'America/Los_Angeles') {
  const latestArchive = floorEvenUtcMinute(now);
  /** Prefer a few minutes lag so archive has landed. */
  latestArchive.setUTCMinutes(latestArchive.getUTCMinutes() - 4);
  if (latestArchive.getUTCMinutes() % 2 === 1) {
    latestArchive.setUTCMinutes(latestArchive.getUTCMinutes() - 1);
  }

  /** @type {Array<{ id: string, time: number, label: string, isCurrent?: boolean }>} */
  const frames = [];
  for (let minsAgo = 55; minsAgo >= 5; minsAgo -= 5) {
    const t = new Date(latestArchive.getTime() - minsAgo * 60_000);
    const aligned = floorEvenUtcMinute(t);
    const stamp =
      String(aligned.getUTCFullYear()) +
      String(aligned.getUTCMonth() + 1).padStart(2, '0') +
      String(aligned.getUTCDate()).padStart(2, '0') +
      String(aligned.getUTCHours()).padStart(2, '0') +
      String(aligned.getUTCMinutes()).padStart(2, '0');
    frames.push({
      id: `mrms::lcref-${stamp}`,
      time: Math.floor(aligned.getTime() / 1000),
      label: formatRadarLocalTime(aligned, timeZone),
    });
  }

  frames.push({
    id: 'q2-hsr',
    time: Math.floor(now.getTime() / 1000),
    label: 'now',
    isCurrent: true,
  });

  return frames;
}

/**
 * Leaflet-ready tile URL template for an IEM layer id.
 * @param {string} layerId
 */
export function iemTileUrlTemplate(layerId) {
  const safe = String(layerId).replace(/[^a-zA-Z0-9:_-]/g, '');
  return `${IEM_TILE_BASE}/${safe}/{z}/{x}/{y}.png`;
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} [radiusMi]
 */
/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} [radiusMi]
 * @param {string} [timeZone]
 */
export function buildIemRadarPayload(lat, lon, radiusMi = RADAR_RADIUS_MI, timeZone) {
  const radius = Number.isFinite(radiusMi) && radiusMi > 0 ? radiusMi : RADAR_RADIUS_MI;
  const diameterMi = radius * 2;
  /** Default to max zoom so the card opens tight on the location pin. */
  const zoom = MAX_ZOOM;
  const tz =
    (typeof timeZone === 'string' && timeZone.trim()) ||
    String(process.env.TZ || 'America/Los_Angeles').trim() ||
    'America/Los_Angeles';
  const frames = buildMrmsFrameList(new Date(), tz);
  const mapPageUrl = externalRadarMapUrl(lat, lon, zoom);

  const padLat = (radius * 1.35) / 69;
  const padLon = padLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const maxBounds = [
    [lat - padLat, lon - padLon],
    [lat + padLat, lon + padLon],
  ];

  return {
    provider: 'iem',
    layer: 'mrms',
    layerLabel: 'MRMS SeamlessHSR',
    lat,
    lon,
    zoom,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    radiusMi: radius,
    diameterMi,
    maxBounds,
    basemap: {
      url: CARTO_DARK_URL,
      attribution: CARTO_ATTR,
      subdomains: 'abcd',
    },
    radarAttribution: IEM_ATTR,
    opacity: 0.68,
    frames: frames.map((f) => ({
      id: f.id,
      time: f.time,
      label: f.label,
      isCurrent: Boolean(f.isCurrent),
      urlTemplate: iemTileUrlTemplate(f.id),
    })),
    mapPageUrl,
  };
}
