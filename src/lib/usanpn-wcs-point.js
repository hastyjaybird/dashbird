/**
 * USA-NPN GeoServer WCS 2.0.1 point samples (same pattern as rnpn `npn_get_point_data()`).
 * @see https://github.com/usa-npn/rnpn/blob/master/R/npn_geoserver.R
 */

const DEFAULT_BASE = 'http://geoserver.usanpn.org/geoserver/';

/**
 * @param {string} base
 * @param {string} path e.g. "wcs"
 */
function joinUrl(base, path) {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path.slice(1) : path;
  return `${b}/${p}`;
}

/**
 * @param {string} xml
 * @returns {number | null} null if missing / unparsable
 */
export function parseWcsGmlTupleList(xml) {
  const m = String(xml).match(/<tupleList[^>]*>\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*</i);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * @param {string} xml
 * @returns {{ start?: string, end?: string } | null}
 */
export function parseWcsTimeRangeFromException(xml) {
  const s = String(xml);
  const m = s.match(/declared range\s+([^\s/]+)\/([^\s"]+)/i);
  if (!m) return null;
  return { start: m[1].trim(), end: m[2].trim() };
}

/**
 * @param {string} isoLike "2026-05-14T07:00:00.000Z"
 * @returns {string | null} "2026-05-14"
 */
export function ymdFromNpnTimeIso(isoLike) {
  const m = String(isoLike).match(/^(\d{4}-\d{2}-\d{2})T/i);
  return m ? m[1] : null;
}

/**
 * @param {object} p
 * @param {string} [p.baseUrl]
 * @param {number} p.lon
 * @param {number} p.lat
 * @param {string} p.coverageId
 * @param {string} [p.timeIso] full instant e.g. 2026-05-14T07:00:00.000Z
 * @param {number} [p.elevation] DOY for layers that use elevation axis (30yr climatology slices)
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{ ok: true, value: number } | { ok: false, status: number, body: string }>}
 */
export async function npnWcsGetPointValue(p) {
  const baseUrl = (p.baseUrl || process.env.USANPN_GEOSERVER_BASE || DEFAULT_BASE).trim() || DEFAULT_BASE;
  const params = new URLSearchParams();
  params.set('service', 'WCS');
  params.set('version', '2.0.1');
  params.set('request', 'GetCoverage');
  params.set('coverageId', p.coverageId);
  params.set('format', 'application/gml+xml');
  params.append('subset', `http://www.opengis.net/def/axis/OGC/0/Long(${p.lon})`);
  params.append('subset', `http://www.opengis.net/def/axis/OGC/0/Lat(${p.lat})`);
  if (p.timeIso) {
    params.append('subset', `http://www.opengis.net/def/axis/OGC/0/time("${p.timeIso}")`);
  }
  if (p.elevation != null && Number.isFinite(p.elevation)) {
    params.append('subset', `http://www.opengis.net/def/axis/OGC/0/elevation(${p.elevation})`);
  }

  const url = `${joinUrl(baseUrl, 'wcs')}?${params.toString()}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), p.timeoutMs ?? 20_000);
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': 'dashbird/1.0 (USA-NPN WCS; https://www.usanpn.org/)',
        Accept: 'application/gml+xml, application/xml;q=0.9, */*;q=0.1',
      },
    });
    const body = await r.text();
    if (!r.ok) {
      return { ok: false, status: r.status, body };
    }
    const raw = parseWcsGmlTupleList(body);
    if (raw == null) {
      return { ok: false, status: r.status, body };
    }
    return { ok: true, value: raw };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} ymd
 * @returns {string}
 */
export function npnTimeIsoFromWallYmd(ymd) {
  return `${ymd}T07:00:00.000Z`;
}

/**
 * @param {string} ymd
 * @param {string} endYmdInclusive
 * @returns {boolean}
 */
export function ymdInRangeInclusive(ymd, startYmd, endYmdInclusive) {
  return ymd >= startYmd && ymd <= endYmdInclusive;
}

/**
 * Gregorian calendar date for ordinal day-of-year (1 = Jan 1).
 * @param {number} year
 * @param {number} doy1
 * @returns {string} YYYY-MM-DD (UTC ordinal mapping; fine for CONUS dashboard dates)
 */
export function ymdForYearDoy(year, doy1) {
  const d = new Date(Date.UTC(year, 0, 1));
  d.setUTCDate(doy1);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/**
 * @param {Date} now
 * @param {string} timeZone IANA
 * @returns {string} YYYY-MM-DD
 */
export function wallYmdInTimeZone(now, timeZone) {
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'America/Los_Angeles';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * @param {string} ymd
 * @param {number} addDays
 * @returns {string}
 */
export function addDaysToYmd(ymd, addDays) {
  const [y, m, d] = ymd.split('-').map((x) => Number.parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return ymd;
  const u = new Date(Date.UTC(y, m - 1, d + addDays));
  const yy = u.getUTCFullYear();
  const mo = String(u.getUTCMonth() + 1).padStart(2, '0');
  const da = String(u.getUTCDate()).padStart(2, '0');
  return `${yy}-${mo}-${da}`;
}

/**
 * Rough CONUS (+ nearby) extent for SI-x NCEP products.
 * @param {number} lat
 * @param {number} lon
 */
export function isLikelyUsanpnSixExtent(lat, lon) {
  return lat >= 24.2 && lat <= 49.8 && lon >= -124.9 && lon <= -66.0;
}
