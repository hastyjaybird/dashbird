/**
 * Skipped / hidden events — persist enough to block re-ingest and recover accidents.
 * SQLite `skipped_events` is the source of truth; criteria JSON mirrors it.
 */
import {
  deleteSkippedEventsFinderByIds,
  eventLocalDateKey,
  eventNameDateDedupeKey,
  eventSeriesDedupeKey,
  listSkippedEventsFinderRecords,
  normalizeEventTitleKey,
  upsertSkippedEventsFinderRecords,
} from './events-finder-store.js';

/**
 * @typedef {{
 *   id: string,
 *   key: string | null,
 *   url: string | null,
 *   title: string | null,
 *   start: string | null,
 *   source: string | null,
 *   venue: string | null,
 *   city: string | null,
 *   imageUrl: string | null,
 *   seriesKey?: string | null,
 *   skippedAt: string,
 * }} SkippedEventRecord
 */

const MAX_SKIPPED = 1000;

/**
 * Stable URL key for skip matching.
 * @param {unknown} url
 * @returns {string | null}
 */
export function normalizeEventUrlKey(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./i, '').toLowerCase();
    // Drop common tracking params so re-scrapes still match.
    for (const key of [...u.searchParams.keys()]) {
      if (
        /^(utm_|fbclid|gclid|mc_|ref$|ref_)/i.test(key)
        || key.toLowerCase() === 'fb_action_ids'
      ) {
        u.searchParams.delete(key);
      }
    }
    let path = u.pathname.replace(/\/+$/, '') || '';
    const q = u.searchParams.toString();
    return `${u.protocol}//${u.hostname}${path}${q ? `?${q}` : ''}`.toLowerCase().slice(0, 500);
  } catch {
    return raw.toLowerCase().slice(0, 500);
  }
}

/**
 * @param {unknown} raw
 * @param {string} [timeZone]
 * @returns {SkippedEventRecord[]}
 */
export function normalizeSkippedEvents(raw, timeZone) {
  if (!Array.isArray(raw)) return [];
  const tz =
    typeof timeZone === 'string' && timeZone.trim()
      ? timeZone.trim()
      : String(process.env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
        || 'America/Los_Angeles';
  /** @type {SkippedEventRecord[]} */
  const out = [];
  const seenIds = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const id = String(row.id || '').trim().slice(0, 400);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const title = row.title != null ? String(row.title).trim().slice(0, 500) || null : null;
    const start = row.start != null ? String(row.start).trim().slice(0, 40) || null : null;
    const keyRaw = row.key != null ? String(row.key).trim().slice(0, 400) : '';
    const key =
      keyRaw
      || (title && start ? eventNameDateDedupeKey({ title, start }, tz) : null);
    out.push({
      id,
      key: key || null,
      url: normalizeEventUrlKey(row.url),
      title,
      start,
      source: row.source != null ? String(row.source).trim().slice(0, 64) || null : null,
      venue: row.venue != null ? String(row.venue).trim().slice(0, 300) || null : null,
      city: row.city != null ? String(row.city).trim().slice(0, 120) || null : null,
      imageUrl: row.imageUrl != null ? String(row.imageUrl).trim().slice(0, 2000) || null : null,
      seriesKey:
        row.seriesKey != null ? String(row.seriesKey).trim().slice(0, 400) || null : null,
      skippedAt:
        row.skippedAt != null && String(row.skippedAt).trim()
          ? String(row.skippedAt).trim().slice(0, 40)
          : new Date().toISOString(),
    });
    if (out.length >= MAX_SKIPPED) break;
  }
  return out;
}

/**
 * Merge legacy hiddenEventIds into skipped event records.
 * @param {SkippedEventRecord[]} skipped
 * @param {unknown} hiddenIds
 * @returns {SkippedEventRecord[]}
 */
export function mergeHiddenIdsIntoSkipped(skipped, hiddenIds) {
  const list = normalizeSkippedEvents(skipped);
  const byId = new Set(list.map((s) => s.id));
  if (!Array.isArray(hiddenIds)) return list;
  const now = new Date().toISOString();
  for (const item of hiddenIds) {
    const id = String(item || '').trim().slice(0, 400);
    if (!id || byId.has(id)) continue;
    byId.add(id);
    list.push({
      id,
      key: null,
      url: null,
      title: null,
      start: null,
      source: null,
      venue: null,
      city: null,
      imageUrl: null,
      seriesKey: null,
      skippedAt: now,
    });
    if (list.length >= MAX_SKIPPED) break;
  }
  return list;
}

/**
 * Merge two skip lists by id (prefer richer / newer).
 * @param {SkippedEventRecord[]} a
 * @param {SkippedEventRecord[]} b
 * @returns {SkippedEventRecord[]}
 */
export function mergeSkippedEventLists(a, b) {
  /** @type {Map<string, SkippedEventRecord>} */
  const byId = new Map();
  for (const list of [a, b]) {
    for (const rec of normalizeSkippedEvents(list)) {
      const prev = byId.get(rec.id);
      if (!prev) {
        byId.set(rec.id, rec);
        continue;
      }
      const prevScore =
        (prev.url ? 2 : 0) + (prev.key ? 2 : 0) + (prev.title ? 1 : 0) + (prev.start ? 1 : 0);
      const nextScore =
        (rec.url ? 2 : 0) + (rec.key ? 2 : 0) + (rec.title ? 1 : 0) + (rec.start ? 1 : 0);
      const prevAt = Date.parse(String(prev.skippedAt || ''));
      const nextAt = Date.parse(String(rec.skippedAt || ''));
      if (
        nextScore > prevScore
        || (nextScore === prevScore
          && Number.isFinite(nextAt)
          && (!Number.isFinite(prevAt) || nextAt >= prevAt))
      ) {
        byId.set(rec.id, { ...prev, ...rec, skippedAt: rec.skippedAt || prev.skippedAt });
      }
    }
  }
  return [...byId.values()]
    .sort((x, y) => {
      const tx = Date.parse(String(x.skippedAt || ''));
      const ty = Date.parse(String(y.skippedAt || ''));
      if (Number.isFinite(tx) && Number.isFinite(ty) && tx !== ty) return ty - tx;
      return 0;
    })
    .slice(0, MAX_SKIPPED);
}

/**
 * Load skips from SQLite, merging any criteria JSON leftovers (one-time migration path).
 * @param {SkippedEventRecord[]} [criteriaSkipped]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {SkippedEventRecord[]}
 */
export function loadSkippedEventsFromStore(criteriaSkipped = [], env = process.env) {
  let fromDb = [];
  try {
    fromDb = listSkippedEventsFinderRecords(env);
  } catch (e) {
    console.warn('[events-finder] skipped sqlite list failed:', e?.message || e);
  }
  const fromCriteria = normalizeSkippedEvents(criteriaSkipped);
  const merged = mergeSkippedEventLists(fromDb, fromCriteria);
  // Persist criteria leftovers into SQLite so filter saves cannot drop them later.
  if (fromCriteria.length && merged.length > fromDb.length) {
    try {
      upsertSkippedEventsFinderRecords(merged, env);
    } catch (e) {
      console.warn('[events-finder] skipped sqlite migrate failed:', e?.message || e);
    }
  }
  return merged;
}

/**
 * Merge (upsert) skip records into SQLite without deleting other skips.
 * Stale/partial client lists must never wipe the table.
 * @param {SkippedEventRecord[]} records
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {SkippedEventRecord[]}
 */
export function syncSkippedEventsToStore(records, env = process.env) {
  const normalized = normalizeSkippedEvents(records);
  if (normalized.length) {
    try {
      upsertSkippedEventsFinderRecords(normalized, env);
    } catch (e) {
      console.warn('[events-finder] skipped sqlite upsert failed:', e?.message || e);
    }
  }
  try {
    return listSkippedEventsFinderRecords(env);
  } catch {
    return loadSkippedEventsFromStore(normalized, env);
  }
}

/**
 * Remove skip designations by id (Unskip).
 * @param {unknown} ids
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {SkippedEventRecord[]}
 */
export function removeSkippedEventsFromStore(ids, env = process.env) {
  const list = (Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .slice(0, 1000);
  if (list.length) {
    try {
      deleteSkippedEventsFinderByIds(list, env);
    } catch (e) {
      console.warn('[events-finder] skipped sqlite delete failed:', e?.message || e);
    }
  }
  try {
    return listSkippedEventsFinderRecords(env);
  } catch {
    return [];
  }
}

/**
 * Snapshot an event into a skip record.
 * @param {object} event
 * @param {string} [timeZone]
 * @returns {SkippedEventRecord | null}
 */
export function skippedRecordFromEvent(event, timeZone) {
  const id = String(event?.id || '').trim().slice(0, 400);
  if (!id) return null;
  const title = String(event?.title || '').trim().slice(0, 500) || null;
  const start = event?.start != null ? String(event.start).trim().slice(0, 40) || null : null;
  return {
    id,
    key: eventNameDateDedupeKey(event, timeZone) || null,
    url: normalizeEventUrlKey(event?.url),
    title,
    start,
    source: event?.source != null ? String(event.source).trim().slice(0, 64) || null : null,
    venue:
      event?.venue != null || event?.location != null
        ? String(event.venue || event.location || '').trim().slice(0, 300) || null
        : null,
    city: event?.city != null ? String(event.city).trim().slice(0, 120) || null : null,
    imageUrl:
      event?.imageUrl != null ? String(event.imageUrl).trim().slice(0, 2000) || null : null,
    seriesKey: null,
    skippedAt: new Date().toISOString(),
  };
}

/**
 * Skip an entire recurring series (Meetup group + weekday-stripped title, etc.).
 * @param {object} event
 * @param {string} [timeZone]
 * @returns {SkippedEventRecord | null}
 */
export function skippedSeriesRecordFromEvent(event, timeZone) {
  const seriesKey =
    (event?.seriesKey != null ? String(event.seriesKey).trim() : '')
    || eventSeriesDedupeKey(event)
    || '';
  if (!seriesKey) return null;
  const id = `series:${seriesKey}`.slice(0, 400);
  const title = String(event?.title || '').trim().slice(0, 500) || null;
  const start = event?.start != null ? String(event.start).trim().slice(0, 40) || null : null;
  return {
    id,
    key: null,
    url: null,
    title,
    start,
    source: event?.source != null ? String(event.source).trim().slice(0, 64) || null : null,
    venue:
      event?.venue != null || event?.location != null
        ? String(event.venue || event.location || '').trim().slice(0, 300) || null
        : null,
    city: event?.city != null ? String(event.city).trim().slice(0, 120) || null : null,
    imageUrl:
      event?.imageUrl != null ? String(event.imageUrl).trim().slice(0, 2000) || null : null,
    seriesKey: seriesKey.slice(0, 400),
    skippedAt: new Date().toISOString(),
  };
}

/**
 * @param {SkippedEventRecord[]} skipped
 * @param {SkippedEventRecord} record
 * @returns {SkippedEventRecord[]}
 */
export function upsertSkippedRecord(skipped, record) {
  if (!record?.id) return normalizeSkippedEvents(skipped);
  const list = normalizeSkippedEvents(skipped).filter((s) => s.id !== record.id);
  list.unshift(record);
  return list.slice(0, MAX_SKIPPED);
}

/**
 * @param {SkippedEventRecord[]} skipped
 * @param {string} id
 * @returns {SkippedEventRecord[]}
 */
export function removeSkippedById(skipped, id) {
  const want = String(id || '').trim();
  if (!want) return normalizeSkippedEvents(skipped);
  return normalizeSkippedEvents(skipped).filter((s) => s.id !== want);
}

/**
 * @param {object} event
 * @param {SkippedEventRecord[]} skipped
 * @param {string} [timeZone]
 * @returns {boolean}
 */
export function isEventSkipped(event, skipped, timeZone) {
  const list = Array.isArray(skipped) ? skipped : [];
  if (!list.length || !event) return false;
  const tz =
    typeof timeZone === 'string' && timeZone.trim()
      ? timeZone.trim()
      : String(process.env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
        || 'America/Los_Angeles';
  const id = String(event.id || '').trim();
  const url = normalizeEventUrlKey(event.url);
  const key = eventNameDateDedupeKey(event, tz);
  const titleKey = normalizeEventTitleKey(event.title);
  const eventDay = eventLocalDateKey(event.start, tz);
  const seriesKey =
    (event.seriesKey != null ? String(event.seriesKey).trim() : '')
    || eventSeriesDedupeKey(event)
    || '';

  for (const s of list) {
    if (id && s.id === id) return true;
    if (seriesKey && s.seriesKey && seriesKey === s.seriesKey) return true;
    if (url && s.url && url === s.url) return true;
    if (key && s.key && key === s.key) return true;
    // Same title on same local calendar day even if key formatting drifted
    if (titleKey && s.title && normalizeEventTitleKey(s.title) === titleKey) {
      const skipDay = eventLocalDateKey(s.start, tz) || (s.start ? String(s.start).slice(0, 10) : null);
      if (eventDay && skipDay && eventDay === skipDay) return true;
    }
  }
  return false;
}

/**
 * @param {SkippedEventRecord[]} skipped
 * @returns {string[]}
 */
export function skippedEventIds(skipped) {
  return normalizeSkippedEvents(skipped).map((s) => s.id);
}
