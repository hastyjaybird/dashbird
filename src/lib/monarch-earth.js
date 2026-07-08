/**
 * Static monarch phenology: fall (southbound) + spring (northbound) latitude × calendar lookup.
 * No network — see `src/data/monarch-*-migration-peaks.json`.
 */
import tableFall from '../data/monarch-fall-migration-peaks.json' with { type: 'json' };
import tableSpring from '../data/monarch-spring-migration-peaks.json' with { type: 'json' };

/** @typedef {'clustering' | 'peak_presence'} MonarchEarthStatus */

const WESTERN_FLYWAY_LON = -114;

const MIN_SHOW_PEAK = 35;
const MIN_SHOW_CLUSTER = 32;

const REF_YEAR_TEMPLATE = 2023;

/**
 * @param {number} year
 * @param {number} month 1–12
 * @param {number} day
 * @returns {number} 1-based day of year
 */
function dayOfYear(year, month, day) {
  const t = Date.UTC(year, month - 1, day);
  const jan1 = Date.UTC(year, 0, 1);
  return Math.round((t - jan1) / 86400000) + 1;
}

/**
 * @param {string} mmdd "MM-DD"
 * @param {number} [yearForDoy]
 * @returns {number}
 */
function mmddToDoy(mmdd, yearForDoy = REF_YEAR_TEMPLATE) {
  const [m, d] = String(mmdd)
    .split('-')
    .map((x) => Number.parseInt(String(x).trim(), 10));
  if (!Number.isFinite(m) || !Number.isFinite(d)) return NaN;
  return dayOfYear(yearForDoy, m, d);
}

/**
 * @param {number} doy
 * @param {number} [yearForLabel]
 * @returns {string} "Mmm D"
 */
function doyToLabel(doy, yearForLabel = REF_YEAR_TEMPLATE) {
  const t = Date.UTC(yearForLabel, 0, 1 + (doy - 1));
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * @param {Date} date
 * @param {string} timeZone IANA
 * @returns {{ y: number, m: number, d: number }}
 */
function calendarInZone(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return { y: NaN, m: NaN, d: NaN };
  }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => Number.parseInt(parts.find((p) => p.type === t)?.value || 'NaN', 10);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/**
 * Interpret `YYYY-MM-DD` as that **civil calendar day** in `timeZone`, not UTC midnight.
 * @param {string} str
 * @param {string} timeZone
 * @returns {Date | null}
 */
export function parseDateOnlyInTimeZone(str, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (![y, mo, d].every((n) => Number.isFinite(n))) return null;

  let ms = Date.UTC(y, mo - 1, d, 12, 0, 0);
  for (let i = 0; i < 56; i++) {
    const c = calendarInZone(new Date(ms), timeZone);
    if (c.y === y && c.m === mo && c.d === d) return new Date(ms);
    const ck = c.y * 10_000 + c.m * 100 + c.d;
    const wk = y * 10_000 + mo * 100 + d;
    ms += ck > wk ? -3_600_000 : 3_600_000;
  }
  return null;
}

/**
 * @typedef {{ latitude: number, midpoint: string, peakStart: string, peakEnd: string }} PeakRow
 */

/**
 * @param {unknown[]} raw
 * @returns {PeakRow[]}
 */
function normalizeRows(raw) {
  return (raw || [])
    .map((r) => ({
      latitude: Number(r.latitude),
      midpoint: String(r.midpoint),
      peakStart: String(r.peakStart),
      peakEnd: String(r.peakEnd),
    }))
    .filter((r) => Number.isFinite(r.latitude))
    .sort((a, b) => a.latitude - b.latitude);
}

const ROWS_FALL = normalizeRows(tableFall.rows);
const ROWS_SPRING = normalizeRows(tableSpring.rows);

const REFERENCE_URLS = [
  ...new Set([...(Array.isArray(tableFall.references) ? tableFall.references : []), ...(Array.isArray(tableSpring.references) ? tableSpring.references : [])]),
];

function rowDoys(row, evaluationYear) {
  return {
    mid: mmddToDoy(row.midpoint, evaluationYear),
    start: mmddToDoy(row.peakStart, evaluationYear),
    end: mmddToDoy(row.peakEnd, evaluationYear),
  };
}

/**
 * @param {number} lat
 * @param {number} evaluationYear
 * @param {PeakRow[]} rows
 * @returns {{ mid: number, start: number, end: number } | null}
 */
function interpolatedPeakDoys(lat, evaluationYear, rows) {
  if (!rows.length) return null;
  const loRow = rows[0];
  const hiRow = rows[rows.length - 1];
  let latUse = lat;
  if (latUse <= loRow.latitude) latUse = loRow.latitude;
  if (latUse >= hiRow.latitude) latUse = hiRow.latitude;

  let i = 0;
  while (i < rows.length - 1 && rows[i + 1].latitude < latUse) i += 1;
  const a = rows[i];
  const b = rows[Math.min(i + 1, rows.length - 1)];
  const da = rowDoys(a, evaluationYear);
  const db = rowDoys(b, evaluationYear);
  if ([da.mid, da.start, da.end, db.mid, db.start, db.end].some((x) => Number.isNaN(x))) return null;

  if (Math.abs(a.latitude - b.latitude) < 1e-6) {
    return {
      mid: Math.round(da.mid),
      start: Math.floor(Math.min(da.start, da.end)),
      end: Math.ceil(Math.max(da.start, da.end)),
    };
  }

  const t = (latUse - a.latitude) / (b.latitude - a.latitude);
  function lerp(x0, x1) {
    return x0 + (x1 - x0) * t;
  }
  let mid = lerp(da.mid, db.mid);
  let start = lerp(da.start, db.start);
  let end = lerp(da.end, db.end);
  if (start > end) [start, end] = [end, start];
  if (mid < start) mid = start;
  if (mid > end) mid = end;
  return {
    mid: Math.round(mid),
    start: Math.floor(start),
    end: Math.ceil(end),
  };
}

function peakLikelihood(doy, peak) {
  const { mid, start, end } = peak;
  if (doy < start || doy > end) return 0;
  const span = Math.max(1, end - start + 1);
  const dist = Math.abs(doy - mid);
  return Math.round(100 * Math.max(0, 1 - dist / span));
}

function clusteringLikelihood(doy, peak) {
  const { mid, start, end } = peak;
  const windowDays = Math.max(1, end - start + 1);
  const band = Math.max(4, Math.min(10, Math.round(windowDays / 5)));
  if (Math.abs(doy - mid) > band) return 0;
  return Math.round(100 * Math.max(0, 1 - Math.abs(doy - mid) / band));
}

/**
 * @param {PeakRow[]} rows
 * @param {number} lat
 * @param {number} y
 * @param {number} doy
 * @param {boolean} western
 * @param {string} source
 * @param {'fall_southbound' | 'spring_northbound'} season
 * @returns {{
 *   status: MonarchEarthStatus | null,
 *   peakLikelihood: number,
 *   clusteringLikelihood: number,
 *   peakWindowLabel: string,
 *   peakEndLabel: string,
 *   midLabel: string,
 *   westernFlywayNote: boolean,
 *   source: string,
 *   season: string,
 *   references: string[],
 * }}
 */
function evaluateRowsForDoy(rows, lat, y, doy, western, source, season) {
  const peak = interpolatedPeakDoys(lat, y, rows);
  if (!peak) {
    return {
      status: null,
      peakLikelihood: 0,
      clusteringLikelihood: 0,
      peakWindowLabel: '',
      peakEndLabel: '',
      midLabel: '',
      westernFlywayNote: western,
      source: `${source} (invalid)`,
      season,
      references: REFERENCE_URLS,
    };
  }

  const pl = peakLikelihood(doy, peak);
  const cl = clusteringLikelihood(doy, peak);

  const peakEndLabel = doyToLabel(peak.end, y);
  const peakWindowLabel = `${doyToLabel(peak.start, y)} – ${peakEndLabel}`;
  const midLabel = doyToLabel(peak.mid, y);

  let status = null;
  if (cl >= MIN_SHOW_CLUSTER) status = 'clustering';
  else if (pl >= MIN_SHOW_PEAK) status = 'peak_presence';

  return {
    status,
    peakLikelihood: pl,
    clusteringLikelihood: cl,
    peakWindowLabel,
    peakEndLabel,
    midLabel,
    westernFlywayNote: western,
    source,
    season,
    references: REFERENCE_URLS,
  };
}

function emptySeasonResult(western, source, season) {
  return {
    status: null,
    peakLikelihood: 0,
    clusteringLikelihood: 0,
    peakWindowLabel: '',
    peakEndLabel: '',
    midLabel: '',
    westernFlywayNote: western,
    source,
    season,
    references: REFERENCE_URLS,
  };
}

/**
 * @param {{ lat: number, lon: number, date?: Date, timeZone?: string }} opts
 * @returns {{ fall: object, spring: object }}
 */
export function lookupMonarchAllPhenology(opts) {
  const lat = opts.lat;
  const lon = opts.lon;
  const date = opts.date instanceof Date ? opts.date : new Date();
  const timeZone =
    typeof opts.timeZone === 'string' && opts.timeZone.trim() !== '' ? opts.timeZone.trim() : 'America/Los_Angeles';

  const western = Number.isFinite(lon) && lon < WESTERN_FLYWAY_LON;

  if (!Number.isFinite(lat) || lat < 14 || lat > 54) {
    const empty = emptySeasonResult(western, 'static phenology (latitude out of range)', 'none');
    return { fall: { ...empty, season: 'fall_southbound' }, spring: { ...empty, season: 'spring_northbound' } };
  }

  const { y, m, d } = calendarInZone(date, timeZone);
  if (![y, m, d].every((n) => Number.isFinite(n))) {
    const empty = emptySeasonResult(western, 'static phenology (invalid calendar date)', 'none');
    return { fall: { ...empty, season: 'fall_southbound' }, spring: { ...empty, season: 'spring_northbound' } };
  }

  const doy = dayOfYear(y, m, d);

  const fall = evaluateRowsForDoy(
    ROWS_FALL,
    lat,
    y,
    doy,
    western,
    'Fall migration table (dashbird JSON)',
    'fall_southbound',
  );

  const spring = evaluateRowsForDoy(
    ROWS_SPRING,
    lat,
    y,
    doy,
    western,
    'Spring migration table (dashbird JSON)',
    'spring_northbound',
  );

  return { fall, spring };
}

/**
 * Likelihood percentages for strip / Settings subtext when the model has nonzero values.
 * @param {{ status?: string | null, peakLikelihood?: number, clusteringLikelihood?: number }} summary
 * @returns {string} e.g. `cluster 72% · peak 45%` or ``
 */
export function formatMonarchLikelihoodSubtext(summary) {
  const pl = Number(summary?.peakLikelihood) || 0;
  const cl = Number(summary?.clusteringLikelihood) || 0;
  const parts = [];
  if (summary?.status === 'clustering') {
    if (cl > 0) parts.push(`cluster ${cl}%`);
    if (pl > 0) parts.push(`peak ${pl}%`);
  } else if (summary?.status === 'peak_presence' && pl > 0) {
    parts.push(`peak ${pl}%`);
  }
  return parts.join(' · ');
}

export { REFERENCE_URLS as MONARCH_REFERENCE_URLS };
