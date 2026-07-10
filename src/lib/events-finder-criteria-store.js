/**
 * Events finder taste + feed filters (Look for / Skip + city / distance / date-time).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BAY_AREA_HOME_CITIES } from './events-finder-geo.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** @typedef {'any' | 'in_person' | 'online'} EventsAttendanceMode */

/** @typedef {{
 *   cities: string[],
 *   maxMiles: number | null,
 *   originZip: string | null,
 *   dateFrom: string | null,
 *   dateTo: string | null,
 *   dates: string[],
 *   earliestLocalTime: string | null,
 *   attendance: EventsAttendanceMode,
 * }} EventsFinderFilters */

/** @typedef {{
 *   maxQueries: number,
 *   maxEventsPerQuery: number,
 *   cacheHours: number,
 *   pinnedHosts: string,
 * }} EventsFinderScrapeBudget */

const DEFAULT_FILTERS = /** @type {EventsFinderFilters} */ ({
  cities: [...BAY_AREA_HOME_CITIES],
  maxMiles: null,
  originZip: null,
  dateFrom: null,
  dateTo: null,
  dates: [],
  earliestLocalTime: '11:00',
  attendance: 'in_person',
});

/** Defaults lean cheap: few Apify queries, modest page size, longer cache. */
const DEFAULT_SCRAPE = /** @type {EventsFinderScrapeBudget} */ ({
  maxQueries: 3,
  maxEventsPerQuery: 15,
  cacheHours: 6,
  pinnedHosts: '',
});

const DEFAULT_CRITERIA = {
  lookFor:
    'hack-a-thons\nclimate\nsustainability\nai and climate\ncommunity\nstartup\nfounder dating\nfounder meetup\ninteractive\ncircus\nburlesque\nsoiled dove\nvaudevere\ncampout\nexistential\nplaya\nburningman\nqueer\npride\ncomedy\npotluck\nai\nflea\nmarket\nthrift\nguild\nfundraiser\nair pusher\nsolstice\nequinox\nmeltdown\nmutant\noddity\noddities\ncuriosities\nexpo\nbirthday\nanniversary\nobtainium\nstreet fair\nreggae down the river\nfestival\noptimism\nearth day\nartificial\nUN\nfail night\nretreat\nclimate cocktails\ngreen drinks\nbox shop\ntowne cycles\nobtainium works\nfairyland\nomni commons\nnoisebridge\ntiat\nathletic playground\nwasteland weekend\nneotropolis (producers of wasteland)\nbombay beach\nthe institute\nphage\nnerd night\nexploratorium\nmakerfare\nopen sauce\nruckas\njamie de wolf\ncrucible\ngala\ndorkbot\ngood people',
  skip:
    'beach clean up\nbeach cleanups\nconcerts\nmarathon\nsound bath\nmeditation\nhike\nanything before 11am\nif DJs are the only point of interest',
  filters: { ...DEFAULT_FILTERS, cities: [...DEFAULT_FILTERS.cities] },
  scrape: { ...DEFAULT_SCRAPE },
  /** Event ids the user hid from the feed. */
  hiddenEventIds: /** @type {string[]} */ ([]),
};

export function eventsFinderCriteriaPath(env = process.env) {
  const override = String(env.EVENTS_FINDER_CRITERIA_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/events-finder-criteria.json');
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeTime(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function normalizeMaxMiles(raw) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(100, Math.round(n * 10) / 10);
}

/**
 * @param {unknown} raw
 * @returns {EventsAttendanceMode}
 */
function normalizeAttendance(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (s === 'online' || s === 'virtual') return 'online';
  if (s === 'in_person' || s === 'inperson' || s === 'offline') return 'in_person';
  return 'any';
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeCities(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_FILTERS.cities];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const c = String(item || '').trim();
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.length ? out : [...DEFAULT_FILTERS.cities];
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeDates(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const d = normalizeDate(item);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
    if (out.length >= 62) break;
  }
  out.sort();
  return out;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeOriginZip(raw) {
  if (raw == null || raw === '') return null;
  const z = String(raw).replace(/\D/g, '');
  return z.length === 5 ? z : null;
}

/**
 * @param {unknown} raw
 * @returns {EventsFinderFilters}
 */
function normalizeFilters(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const dates = normalizeDates(src.dates);
  return {
    cities: normalizeCities(src.cities),
    maxMiles: normalizeMaxMiles(src.maxMiles),
    originZip: normalizeOriginZip(src.originZip),
    // Individual days take precedence; clear range when dates are set.
    dateFrom: dates.length ? null : normalizeDate(src.dateFrom),
    dateTo: dates.length ? null : normalizeDate(src.dateTo),
    dates,
    earliestLocalTime:
      src.earliestLocalTime === undefined
        ? DEFAULT_FILTERS.earliestLocalTime
        : normalizeTime(src.earliestLocalTime),
    attendance: 'in_person',
  };
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function normalizeInt(raw, fallback, min, max) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * @param {unknown} raw
 * @returns {EventsFinderScrapeBudget}
 */
/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizePinnedHosts(raw) {
  if (raw == null) return '';
  const s = String(raw);
  if (s.length > 8000) return s.slice(0, 8000);
  return s;
}

function normalizeScrape(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    maxQueries: normalizeInt(src.maxQueries, DEFAULT_SCRAPE.maxQueries, 1, 12),
    maxEventsPerQuery: normalizeInt(
      src.maxEventsPerQuery,
      DEFAULT_SCRAPE.maxEventsPerQuery,
      1,
      100,
    ),
    cacheHours: normalizeInt(src.cacheHours, DEFAULT_SCRAPE.cacheHours, 1, 168),
    pinnedHosts: normalizePinnedHosts(
      src.pinnedHosts === undefined ? DEFAULT_SCRAPE.pinnedHosts : src.pinnedHosts,
    ),
  };
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeHiddenEventIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item || '').trim();
    if (!id || id.length > 400) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{
 *   lookFor: string,
 *   skip: string,
 *   filters: EventsFinderFilters,
 *   scrape: EventsFinderScrapeBudget,
 *   hiddenEventIds: string[],
 * }}
 */
function normalize(raw) {
  const lookFor =
    raw && typeof raw === 'object' && typeof /** @type {{ lookFor?: unknown }} */ (raw).lookFor === 'string'
      ? /** @type {{ lookFor: string }} */ (raw).lookFor
      : DEFAULT_CRITERIA.lookFor;
  const skip =
    raw && typeof raw === 'object' && typeof /** @type {{ skip?: unknown }} */ (raw).skip === 'string'
      ? /** @type {{ skip: string }} */ (raw).skip
      : DEFAULT_CRITERIA.skip;
  const filters =
    raw && typeof raw === 'object' && 'filters' in /** @type {object} */ (raw)
      ? normalizeFilters(/** @type {{ filters?: unknown }} */ (raw).filters)
      : { ...DEFAULT_FILTERS, cities: [...DEFAULT_FILTERS.cities] };
  const scrape =
    raw && typeof raw === 'object' && 'scrape' in /** @type {object} */ (raw)
      ? normalizeScrape(/** @type {{ scrape?: unknown }} */ (raw).scrape)
      : { ...DEFAULT_SCRAPE };
  const hiddenEventIds =
    raw && typeof raw === 'object' && 'hiddenEventIds' in /** @type {object} */ (raw)
      ? normalizeHiddenEventIds(/** @type {{ hiddenEventIds?: unknown }} */ (raw).hiddenEventIds)
      : [];
  return { lookFor, skip, filters, scrape, hiddenEventIds };
}

async function ensureFile() {
  const live = eventsFinderCriteriaPath();
  try {
    await fs.access(live);
    return live;
  } catch {
    await fs.mkdir(path.dirname(live), { recursive: true });
    await fs.writeFile(live, `${JSON.stringify(DEFAULT_CRITERIA, null, 2)}\n`, 'utf8');
    return live;
  }
}

/**
 * @returns {Promise<{
 *   lookFor: string,
 *   skip: string,
 *   filters: EventsFinderFilters,
 *   scrape: EventsFinderScrapeBudget,
 *   hiddenEventIds: string[],
 * }>}
 */
export async function loadEventsFinderCriteria() {
  const live = await ensureFile();
  try {
    const j = JSON.parse(await fs.readFile(live, 'utf8'));
    return normalize(j);
  } catch {
    return {
      lookFor: DEFAULT_CRITERIA.lookFor,
      skip: DEFAULT_CRITERIA.skip,
      filters: { ...DEFAULT_FILTERS, cities: [...DEFAULT_FILTERS.cities] },
      scrape: { ...DEFAULT_SCRAPE },
      hiddenEventIds: [],
    };
  }
}

/**
 * @param {{
 *   lookFor?: unknown,
 *   skip?: unknown,
 *   filters?: unknown,
 *   scrape?: unknown,
 *   hiddenEventIds?: unknown,
 * }} body
 * @returns {Promise<
 *   | {
 *       ok: true,
 *       lookFor: string,
 *       skip: string,
 *       filters: EventsFinderFilters,
 *       scrape: EventsFinderScrapeBudget,
 *       hiddenEventIds: string[],
 *     }
 *   | { ok: false, error: string }
 * >}
 */
export async function saveEventsFinderCriteria(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid_body' };
  }
  if (typeof body.lookFor !== 'string' || typeof body.skip !== 'string') {
    return { ok: false, error: 'invalid_fields' };
  }
  if (body.lookFor.length > 20000 || body.skip.length > 20000) {
    return { ok: false, error: 'too_long' };
  }
  const existing = await loadEventsFinderCriteria();
  const next = {
    lookFor: body.lookFor,
    skip: body.skip,
    filters: normalizeFilters(body.filters),
    scrape: normalizeScrape(body.scrape),
    hiddenEventIds:
      body.hiddenEventIds === undefined
        ? existing.hiddenEventIds
        : normalizeHiddenEventIds(body.hiddenEventIds),
  };
  const live = await ensureFile();
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, live);
  return { ok: true, ...next };
}

export { DEFAULT_FILTERS, DEFAULT_SCRAPE, BAY_AREA_HOME_CITIES };
