/**
 * Skipped / hidden events — persist enough to block re-ingest and recover accidents.
 * SQLite `skipped_events` is the source of truth; criteria JSON mirrors it.
 */
import {
  deleteSkippedEventsFinderByIds,
  eventLocalDateKey,
  eventNameDateDedupeKey,
  eventSeriesDedupeKey,
  listEventsFinderEvents,
  listSkippedEventsFinderRecords,
  normalizeEventTitleKey,
  openEventsFinderDb,
  upsertSkippedEventsFinderRecords,
} from './events-finder-store.js';
import { normalizeTasteLineArray } from './taste-lines.js';

/** @type {ReturnType<typeof setInterval> | null} */
let skippedPurgeTimer = null;

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
 *   tasteLookFor?: string[],
 *   tasteGrey?: string[],
 *   tasteBlack?: string[],
 * }} SkippedEventRecord
 */

const MAX_SKIPPED = 1000;

/** Min length for source+fuzzy-title skip matching (avoids hiding generic short titles). */
const FUZZY_TITLE_MIN_LEN = 24;

/**
 * Title key with clock times stripped so near-duplicate listings still match
 * (e.g. Luma "Floor block … 5pm" vs "… 7pm").
 * @param {unknown} title
 * @returns {string | null}
 */
export function normalizeSkipTitleFuzzyKey(title) {
  const base = normalizeEventTitleKey(title);
  if (!base) return null;
  const fuzzy = base
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/g, ' ')
    .replace(/\bfrom\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+)?to\b/g, 'from-to')
    .replace(/\s+/g, ' ')
    .trim();
  return fuzzy || null;
}

/**
 * @param {object | null | undefined} eventOrRecord
 * @returns {string | null}
 */
export function skipTitleFuzzyLookupKey(eventOrRecord) {
  if (!eventOrRecord || typeof eventOrRecord !== 'object') return null;
  const fuzzy = normalizeSkipTitleFuzzyKey(
    /** @type {{ title?: unknown }} */ (eventOrRecord).title,
  );
  if (!fuzzy || fuzzy.length < FUZZY_TITLE_MIN_LEN) return null;
  const source = String(
    /** @type {{ source?: unknown }} */ (eventOrRecord).source || '',
  )
    .trim()
    .toLowerCase();
  if (!source) return null;
  return `${source}|${fuzzy}`;
}

/**
 * Series fingerprint for a skip record or live event (recurring Meetup/Luma, etc.).
 * @param {object | null | undefined} eventOrRecord
 * @returns {string | null}
 */
export function resolveSkipSeriesKey(eventOrRecord) {
  if (!eventOrRecord || typeof eventOrRecord !== 'object') return null;
  const explicit = String(eventOrRecord.seriesKey || '').trim();
  if (explicit) return explicit.slice(0, 400);
  const computed = eventSeriesDedupeKey(eventOrRecord);
  return computed ? computed.slice(0, 400) : null;
}

/**
 * Fill url/key/seriesKey on a skip record so ingest + feed matching stay stable.
 * @param {SkippedEventRecord} rec
 * @param {string} [timeZone]
 * @returns {SkippedEventRecord}
 */
export function enrichSkippedRecord(rec, timeZone) {
  const tz =
    typeof timeZone === 'string' && timeZone.trim()
      ? timeZone.trim()
      : String(process.env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
        || 'America/Los_Angeles';
  const title = rec.title != null ? String(rec.title).trim().slice(0, 500) || null : null;
  const start = rec.start != null ? String(rec.start).trim().slice(0, 40) || null : null;
  const keyRaw = rec.key != null ? String(rec.key).trim().slice(0, 400) : '';
  const key =
    keyRaw
    || (title && start ? eventNameDateDedupeKey({ title, start }, tz) : null);
  const url = normalizeEventUrlKey(rec.url);
  const seriesKey = resolveSkipSeriesKey(rec);
  return {
    ...rec,
    key: key || null,
    url,
    seriesKey: seriesKey || null,
  };
}

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
    out.push(
      enrichSkippedRecord(
        {
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
          ...(normalizeTasteLineArray(row.tasteLookFor)
            ? { tasteLookFor: normalizeTasteLineArray(row.tasteLookFor) }
            : {}),
          ...(normalizeTasteLineArray(row.tasteGrey)
            ? { tasteGrey: normalizeTasteLineArray(row.tasteGrey) }
            : {}),
          ...(normalizeTasteLineArray(row.tasteBlack)
            ? { tasteBlack: normalizeTasteLineArray(row.tasteBlack) }
            : {}),
        },
        tz,
      ),
    );
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
        (prev.url ? 2 : 0) + (prev.key ? 2 : 0) + (prev.title ? 1 : 0) + (prev.start ? 1 : 0)
        + ((prev.tasteGrey?.length || prev.tasteBlack?.length || prev.tasteLookFor?.length) ? 1 : 0);
      const nextScore =
        (rec.url ? 2 : 0) + (rec.key ? 2 : 0) + (rec.title ? 1 : 0) + (rec.start ? 1 : 0)
        + ((rec.tasteGrey?.length || rec.tasteBlack?.length || rec.tasteLookFor?.length) ? 1 : 0);
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
 * Local calendar YYYY-MM-DD for now in timeZone.
 * @param {string} [timeZone]
 * @param {Date} [now]
 * @returns {string}
 */
export function localTodayDateKey(timeZone, now = new Date()) {
  const tz =
    typeof timeZone === 'string' && timeZone.trim()
      ? timeZone.trim()
      : String(process.env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
        || 'America/Los_Angeles';
  return eventLocalDateKey(now.toISOString(), tz) || now.toISOString().slice(0, 10);
}

/**
 * True when the skip should be removed (day after the event's local date).
 * Whole-series skips persist until manual Unskip.
 * @param {SkippedEventRecord} rec
 * @param {string} todayKey YYYY-MM-DD local today
 * @param {string} tz
 * @returns {boolean}
 */
export function isSkippedRecordExpired(rec, todayKey, tz) {
  const id = String(rec?.id || '').trim();
  if (id.startsWith('series:')) return false;

  const eventDay = eventLocalDateKey(rec.start, tz);
  if (!eventDay) {
    const skipDay = eventLocalDateKey(rec.skippedAt, tz);
    if (!skipDay) return false;
    return skipDay < todayKey;
  }
  return eventDay < todayKey;
}

/**
 * Delete skip rows whose event local date is before today (purge starts day after event).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function purgeExpiredSkippedEvents(env = process.env) {
  const tz =
    String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles';
  const todayKey = localTodayDateKey(tz);
  let records = [];
  try {
    records = listSkippedEventsFinderRecords(env);
  } catch (e) {
    console.warn('[events-finder] skipped purge list failed:', e?.message || e);
    return 0;
  }
  const expiredIds = records
    .filter((rec) => isSkippedRecordExpired(rec, todayKey, tz))
    .map((rec) => String(rec.id || '').trim())
    .filter(Boolean);
  if (!expiredIds.length) return 0;
  try {
    const deleted = deleteSkippedEventsFinderByIds(expiredIds, env);
    if (deleted > 0) {
      console.log(`[events-finder] purged ${deleted} expired skipped event(s)`);
    }
    return deleted;
  } catch (e) {
    console.warn('[events-finder] skipped purge delete failed:', e?.message || e);
    return 0;
  }
}

/**
 * Hourly purge of day-after expired skips (catches midnight rollovers between requests).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startSkippedEventsPurgeScheduler(env = process.env) {
  if (skippedPurgeTimer) return;
  const run = () => {
    try {
      purgeExpiredSkippedEvents(env);
    } catch (e) {
      console.warn('[events-finder] skipped purge scheduler:', e?.message || e);
    }
  };
  run();
  skippedPurgeTimer = setInterval(run, 60 * 60 * 1000);
  if (typeof skippedPurgeTimer.unref === 'function') skippedPurgeTimer.unref();
}

/**
 * Load skips from SQLite, merging any criteria JSON leftovers (one-time migration path).
 * @param {SkippedEventRecord[]} [criteriaSkipped]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {SkippedEventRecord[]}
 */
export function loadSkippedEventsFromStore(criteriaSkipped = [], env = process.env) {
  purgeExpiredSkippedEvents(env);
  let fromDb = [];
  try {
    fromDb = listSkippedEventsFinderRecords(env);
  } catch (e) {
    console.warn('[events-finder] skipped sqlite list failed:', e?.message || e);
  }
  const fromCriteria = normalizeSkippedEvents(criteriaSkipped);
  const merged = mergeSkippedEventLists(fromDb, fromCriteria);
  const enriched = merged.map((rec) => enrichSkippedRecord(rec));
  const needsBackfill = enriched.some((rec, i) => {
    const prev = merged[i];
    return (
      (rec.seriesKey && rec.seriesKey !== prev.seriesKey)
      || (rec.url && rec.url !== prev.url)
      || (rec.key && rec.key !== prev.key)
    );
  });
  // Persist criteria leftovers + backfilled series/url keys into SQLite.
  if ((fromCriteria.length && merged.length > fromDb.length) || needsBackfill) {
    try {
      upsertSkippedEventsFinderRecords(enriched, env);
    } catch (e) {
      console.warn('[events-finder] skipped sqlite migrate failed:', e?.message || e);
    }
  }
  return enriched;
}

/**
 * Occurrence skips with a venue-anchored seriesKey also get a series skip so
 * monthly re-listings (new id/url) stay hidden after the event date passes.
 * @param {SkippedEventRecord[]} records
 * @param {string} [timeZone]
 * @returns {SkippedEventRecord[]}
 */
export function expandSkipRecordsWithSeries(records, timeZone) {
  const normalized = normalizeSkippedEvents(records, timeZone);
  if (!normalized.length) return normalized;
  /** @type {SkippedEventRecord[]} */
  const out = [...normalized];
  /** @type {Set<string>} */
  const seenSeries = new Set();
  for (const rec of normalized) {
    const id = String(rec?.id || '').trim();
    if (id.startsWith('series:')) {
      const sk = resolveSkipSeriesKey(rec);
      if (sk) seenSeries.add(sk);
    }
  }
  for (const rec of normalized) {
    const id = String(rec?.id || '').trim();
    if (id.startsWith('series:')) continue;
    const seriesKey = resolveSkipSeriesKey(rec);
    if (!seriesKey || seenSeries.has(seriesKey)) continue;
    seenSeries.add(seriesKey);
    const seriesRec = skippedSeriesRecordFromEvent({ ...rec, seriesKey }, timeZone);
    if (seriesRec) out.unshift(seriesRec);
  }
  return out.slice(0, MAX_SKIPPED);
}

/**
 * Merge (upsert) skip records into SQLite without deleting other skips.
 * Stale/partial client lists must never wipe the table.
 * @param {SkippedEventRecord[]} records
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {SkippedEventRecord[]}
 */
export function syncSkippedEventsToStore(records, env = process.env) {
  const tz =
    String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles';
  const normalized = expandSkipRecordsWithSeries(normalizeSkippedEvents(records, tz), tz);
  // #region agent log
  if (normalized.some((r) => String(r?.id || '').startsWith('series:'))) {
    const seriesAdded = normalized.filter((r) => String(r?.id || '').startsWith('series:'));
    fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '25d735' },
      body: JSON.stringify({
        sessionId: '25d735',
        runId: 'pre-fix',
        hypothesisId: 'A-D',
        location: 'events-finder-skipped.js:syncSkippedEventsToStore',
        message: 'skip upsert with series expansion',
        data: {
          inputCount: Array.isArray(records) ? records.length : 0,
          upsertCount: normalized.length,
          seriesIds: seriesAdded.map((r) => r.id).slice(0, 5),
          titles: normalized.map((r) => r.title).filter(Boolean).slice(0, 5),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  }
  // #endregion
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
 * Resolve skip-row ids to delete for Unskip (handles series/url matches, not just row id).
 * @param {unknown} ids
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function resolveUnskipRecordIds(ids, env = process.env) {
  const want = (Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .slice(0, 1000);
  if (!want.length) return [];

  const skipped = loadSkippedEventsFromStore([], env);
  const index = buildSkippedEventsIndex(skipped);
  /** @type {Set<string>} */
  const toDelete = new Set(want);

  for (const id of want) {
    if (index.byId.has(id)) continue;
    if (id.startsWith('series:')) continue;
    let catalogEvent = null;
    try {
      const catalog = listEventsFinderEvents({ env });
      catalogEvent = catalog.find((ev) => String(ev?.id || '').trim() === id) || null;
    } catch {
      catalogEvent = null;
    }
    if (catalogEvent) {
      const match = findSkippedEventMatch(catalogEvent, index);
      if (match?.id) toDelete.add(String(match.id));
      continue;
    }
    const pseudo = skipped.find(
      (rec) =>
        String(rec?.id || '') === id
        || (rec?.url && normalizeEventUrlKey(rec.url) === normalizeEventUrlKey(id)),
    );
    if (pseudo) toDelete.add(String(pseudo.id));
  }

  // Occurrence unskip also clears the auto-created series companion (mobile/default skip).
  for (const id of [...toDelete]) {
    if (id.startsWith('series:')) continue;
    const rec = index.byId.get(id);
    if (!rec) continue;
    const sk = resolveSkipSeriesKey(rec);
    if (!sk) continue;
    const seriesId = `series:${sk}`.slice(0, 400);
    if (index.byId.has(seriesId)) toDelete.add(seriesId);
  }

  return [...toDelete].slice(0, 1000);
}

/**
 * Remove skip designations by id (Unskip).
 * @param {unknown} ids
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {SkippedEventRecord[]}
 */
export function removeSkippedEventsFromStore(ids, env = process.env) {
  const list = resolveUnskipRecordIds(ids, env);
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
  const base = {
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
    seriesKey: resolveSkipSeriesKey(event),
    skippedAt: new Date().toISOString(),
  };
  return enrichSkippedRecord(base, timeZone);
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
 * Precomputed skip lookups for feed/ingest loops (avoids O(events × skips)).
 * @typedef {{
 *   tz: string,
 *   byId: Map<string, SkippedEventRecord>,
 *   urls: Map<string, SkippedEventRecord>,
 *   keys: Map<string, SkippedEventRecord>,
 *   seriesKeys: Map<string, SkippedEventRecord>,
 *   titleDays: Map<string, SkippedEventRecord>,
 *   fuzzyTitles: Map<string, SkippedEventRecord>,
 * }} SkippedEventsIndex
 */

/**
 * @param {SkippedEventRecord[]} skipped
 * @param {string} [timeZone]
 * @returns {SkippedEventsIndex}
 */
export function buildSkippedEventsIndex(skipped, timeZone) {
  const tz =
    typeof timeZone === 'string' && timeZone.trim()
      ? timeZone.trim()
      : String(process.env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
        || 'America/Los_Angeles';
  /** @type {SkippedEventsIndex} */
  const index = {
    tz,
    byId: new Map(),
    urls: new Map(),
    keys: new Map(),
    seriesKeys: new Map(),
    titleDays: new Map(),
    fuzzyTitles: new Map(),
  };
  const list = Array.isArray(skipped) ? skipped : [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    if (s.id) index.byId.set(String(s.id).trim(), s);
    const urlKey = normalizeEventUrlKey(s.url);
    if (urlKey) index.urls.set(urlKey, s);
    if (s.key) index.keys.set(String(s.key), s);
    const seriesKey = resolveSkipSeriesKey(s);
    if (seriesKey) index.seriesKeys.set(seriesKey, s);
    const titleKey = normalizeEventTitleKey(s.title);
    const skipDay =
      eventLocalDateKey(s.start, tz) || (s.start ? String(s.start).slice(0, 10) : null);
    if (titleKey && skipDay) index.titleDays.set(`${titleKey}|${skipDay}`, s);
    const fuzzyKey = skipTitleFuzzyLookupKey(s);
    if (fuzzyKey) index.fuzzyTitles.set(fuzzyKey, s);
  }
  return index;
}

/**
 * @param {object} event
 * @param {SkippedEventsIndex} index
 * @returns {SkippedEventRecord | null}
 */
export function findSkippedEventMatch(event, index) {
  if (!event || !index) return null;
  const id = String(event.id || '').trim();
  if (id && index.byId.has(id)) return index.byId.get(id) || null;

  const seriesKey =
    (event.seriesKey != null ? String(event.seriesKey).trim() : '')
    || eventSeriesDedupeKey(event)
    || '';
  if (seriesKey && index.seriesKeys.has(seriesKey)) {
    return index.seriesKeys.get(seriesKey) || null;
  }

  const url = normalizeEventUrlKey(event.url);
  if (url && index.urls.has(url)) return index.urls.get(url) || null;

  const key = eventNameDateDedupeKey(event, index.tz);
  if (key && index.keys.has(key)) return index.keys.get(key) || null;

  const titleKey = normalizeEventTitleKey(event.title);
  const eventDay = eventLocalDateKey(event.start, index.tz);
  if (titleKey && eventDay) {
    const hit = index.titleDays.get(`${titleKey}|${eventDay}`);
    if (hit) return hit;
  }

  const fuzzyKey = skipTitleFuzzyLookupKey(event);
  if (fuzzyKey && index.fuzzyTitles.has(fuzzyKey)) {
    return index.fuzzyTitles.get(fuzzyKey) || null;
  }
  return null;
}

/**
 * @param {object} event
 * @param {SkippedEventRecord[] | SkippedEventsIndex} skipped
 * @param {string} [timeZone]
 * @returns {boolean}
 */
export function isEventSkipped(event, skipped, timeZone) {
  if (!event || !skipped) return false;
  if (
    typeof skipped === 'object'
    && !Array.isArray(skipped)
    && /** @type {SkippedEventsIndex} */ (skipped).byId instanceof Map
  ) {
    return findSkippedEventMatch(event, /** @type {SkippedEventsIndex} */ (skipped)) != null;
  }
  const list = Array.isArray(skipped) ? skipped : [];
  if (!list.length) return false;
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
  const fuzzyKey = skipTitleFuzzyLookupKey(event);

  for (const s of list) {
    if (id && s.id === id) return true;
    const skipSeries = resolveSkipSeriesKey(s);
    if (seriesKey && skipSeries && seriesKey === skipSeries) return true;
    if (url && s.url && url === s.url) return true;
    if (key && s.key && key === s.key) return true;
    // Same title on same local calendar day even if key formatting drifted
    if (titleKey && s.title && normalizeEventTitleKey(s.title) === titleKey) {
      const skipDay = eventLocalDateKey(s.start, tz) || (s.start ? String(s.start).slice(0, 10) : null);
      if (eventDay && skipDay && eventDay === skipDay) return true;
    }
    if (fuzzyKey && skipTitleFuzzyLookupKey(s) === fuzzyKey) return true;
  }
  return false;
}

/**
 * Delete catalog rows that match skip records (id, url, series, name+date).
 * @param {SkippedEventRecord[]} records
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function deleteEventsFinderMatchingSkipped(records, env = process.env) {
  const list = normalizeSkippedEvents(records);
  if (!list.length) return 0;
  const tz =
    String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles';
  const index = buildSkippedEventsIndex(list, tz);
  let catalog = [];
  try {
    catalog = listEventsFinderEvents({ env });
  } catch {
    return 0;
  }
  const ids = new Set();
  for (const event of catalog) {
    if (findSkippedEventMatch(event, index)?.id) {
      const id = String(event?.id || '').trim();
      if (id) ids.add(id);
    }
  }
  if (!ids.size) return 0;
  const db = openEventsFinderDb(env);
  const stmt = db.prepare('DELETE FROM events WHERE id = ?');
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ids) {
      deleted += Number(stmt.run(id).changes) || 0;
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
  return deleted;
}

/**
 * @param {SkippedEventRecord[]} skipped
 * @returns {string[]}
 */
export function skippedEventIds(skipped) {
  return normalizeSkippedEvents(skipped).map((s) => s.id);
}
