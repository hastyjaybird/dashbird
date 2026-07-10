/**
 * Events finder — local SQLite catalog (normalized events across sources).
 * Uses Node's built-in node:sqlite (DatabaseSync). Criteria stay in JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** @type {DatabaseSync | null} */
let dbSingleton = null;
/** @type {string | null} */
let dbPathSingleton = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function eventsFinderDbPath(env = process.env) {
  const override = String(env.EVENTS_FINDER_DB_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  }
  return path.join(PKG_ROOT, 'data', 'events-finder.db');
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function toIsoOrNull(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Collapse title for name+date dedupe (case/punct/spacing insensitive).
 * @param {unknown} title
 * @returns {string}
 */
export function normalizeEventTitleKey(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[''`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Calendar day in dashboard timezone (default America/Los_Angeles).
 * @param {unknown} start
 * @param {string} [timeZone]
 * @returns {string | null} YYYY-MM-DD
 */
export function eventLocalDateKey(start, timeZone = 'America/Los_Angeles') {
  const iso = toIsoOrNull(start);
  if (!iso) return null;
  const tz =
    typeof timeZone === 'string' && timeZone.trim()
      ? timeZone.trim()
      : 'America/Los_Angeles';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(iso));
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    /* fall through */
  }
  return iso.slice(0, 10);
}

/**
 * @param {object} event
 * @param {string} [timeZone]
 * @returns {string | null} null when title or date missing (not dedupe-eligible)
 */
export function eventNameDateDedupeKey(event, timeZone = 'America/Los_Angeles') {
  const name = normalizeEventTitleKey(/** @type {{ title?: unknown }} */ (event)?.title);
  const date = eventLocalDateKey(/** @type {{ start?: unknown }} */ (event)?.start, timeZone);
  if (!name || !date) return null;
  return `${name}|${date}`;
}

/** Prefer richer / more “canonical” listings when collapsing duplicates. */
const SOURCE_PREF = {
  facebook: 4,
  partiful: 4,
  luma: 4,
  eventbrite: 4,
  meetup: 4,
  secretparty: 3,
  gmail: 1,
};

/**
 * @param {object} event
 * @returns {number}
 */
function eventRichnessScore(event) {
  let score = 0;
  if (event?.city) score += 2;
  if (Number.isFinite(Number(event?.lat)) && Number.isFinite(Number(event?.lon))) score += 3;
  if (event?.venue || event?.location) score += 2;
  if (event?.url) score += 1;
  if (event?.description) score += 1;
  if (event?.imageUrl) score += 1;
  if (event?.end) score += 1;
  const src = String(event?.source || '')
    .trim()
    .toLowerCase();
  score += SOURCE_PREF[src] || 2;
  return score;
}

/**
 * Keep one event per matching name + local calendar date.
 * Events missing a title or start date are left alone (cannot pair on both).
 * @param {object[]} events
 * @param {{ timeZone?: string }} [opts]
 * @returns {{ events: object[], removed: number }}
 */
export function dedupeEventsByNameAndDate(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const timeZone =
    String(opts.timeZone || process.env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles';

  /** @type {Map<string, object>} */
  const winners = new Map();
  /** @type {object[]} */
  const passthrough = [];

  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    const key = eventNameDateDedupeKey(event, timeZone);
    if (!key) {
      passthrough.push(event);
      continue;
    }
    const prev = winners.get(key);
    if (!prev) {
      winners.set(key, event);
      continue;
    }
    const prevScore = eventRichnessScore(prev);
    const nextScore = eventRichnessScore(event);
    if (nextScore > prevScore) {
      const dupes = Array.isArray(prev.duplicateIds) ? prev.duplicateIds : [];
      const kept = {
        ...event,
        duplicateIds: [...dupes, String(prev.id || '')].filter(Boolean),
      };
      winners.set(key, kept);
    } else {
      const dupes = Array.isArray(prev.duplicateIds) ? prev.duplicateIds : [];
      const id = String(event.id || '').trim();
      winners.set(key, {
        ...prev,
        duplicateIds: id && !dupes.includes(id) ? [...dupes, id] : dupes,
      });
    }
  }

  const deduped = [...winners.values(), ...passthrough];
  const removed = Math.max(0, list.length - deduped.length);
  return { events: deduped, removed };
}

/**
 * @param {object} event
 * @returns {{
 *   id: string,
 *   source: string,
 *   externalId: string | null,
 *   url: string | null,
 *   title: string,
 *   startAt: string | null,
 *   endAt: string | null,
 *   venue: string | null,
 *   city: string | null,
 *   lat: number | null,
 *   lon: number | null,
 *   online: number,
 *   description: string | null,
 *   imageUrl: string | null,
 *   payloadJson: string,
 * } | null}
 */
function normalizeRow(event) {
  if (!event || typeof event !== 'object') return null;
  const id = String(/** @type {{ id?: unknown }} */ (event).id || '').trim();
  if (!id) return null;
  const title = String(/** @type {{ title?: unknown }} */ (event).title || '').trim();
  if (!title) return null;

  const source = String(/** @type {{ source?: unknown }} */ (event).source || 'unknown')
    .trim()
    .toLowerCase()
    .slice(0, 64) || 'unknown';

  const url = String(/** @type {{ url?: unknown }} */ (event).url || '').trim() || null;
  let externalId = null;
  const colon = id.indexOf(':');
  if (colon > 0 && colon < id.length - 1) {
    externalId = id.slice(colon + 1).slice(0, 512);
  }

  const online =
    /** @type {{ online?: unknown, isOnline?: unknown }} */ (event).online === true
    || /** @type {{ online?: unknown, isOnline?: unknown }} */ (event).isOnline === true
      ? 1
      : 0;

  const venueRaw =
    /** @type {{ venue?: unknown, location?: unknown }} */ (event).venue
    ?? /** @type {{ venue?: unknown, location?: unknown }} */ (event).location;
  const venue = venueRaw != null ? String(venueRaw).trim().slice(0, 300) || null : null;
  const cityRaw = /** @type {{ city?: unknown }} */ (event).city;
  const city = cityRaw != null ? String(cityRaw).trim().slice(0, 120) || null : null;
  const descriptionRaw = /** @type {{ description?: unknown }} */ (event).description;
  const description =
    descriptionRaw != null ? String(descriptionRaw).replace(/\s+/g, ' ').trim().slice(0, 2000) || null : null;
  const imageRaw = /** @type {{ imageUrl?: unknown }} */ (event).imageUrl;
  const imageUrl = imageRaw != null ? String(imageRaw).trim().slice(0, 2000) || null : null;

  /** @type {Record<string, unknown>} */
  const payload = { .../** @type {Record<string, unknown>} */ (event) };
  // Keep raw but avoid huge nested blobs blowing the row — still store what sources send.
  try {
    JSON.stringify(payload);
  } catch {
    delete payload.raw;
  }

  return {
    id: id.slice(0, 512),
    source,
    externalId,
    url: url ? url.slice(0, 2000) : null,
    title: title.slice(0, 500),
    startAt: toIsoOrNull(/** @type {{ start?: unknown }} */ (event).start),
    endAt: toIsoOrNull(/** @type {{ end?: unknown }} */ (event).end),
    venue,
    city,
    lat: toFiniteNumber(/** @type {{ lat?: unknown }} */ (event).lat),
    lon: toFiniteNumber(/** @type {{ lon?: unknown }} */ (event).lon),
    online,
    description,
    imageUrl,
    payloadJson: JSON.stringify(payload),
  };
}

/**
 * @param {DatabaseSync} db
 */
function migrate(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT,
      url TEXT,
      title TEXT NOT NULL,
      start_at TEXT,
      end_at TEXT,
      venue TEXT,
      city TEXT,
      lat REAL,
      lon REAL,
      online INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      image_url TEXT,
      payload_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_start_at ON events(start_at);
    CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
    CREATE INDEX IF NOT EXISTS idx_events_city ON events(city);
    CREATE INDEX IF NOT EXISTS idx_events_last_seen ON events(last_seen_at);
  `);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {DatabaseSync}
 */
export function openEventsFinderDb(env = process.env) {
  const dbPath = eventsFinderDbPath(env);
  if (dbSingleton && dbPathSingleton === dbPath) return dbSingleton;

  if (dbSingleton) {
    try {
      dbSingleton.close();
    } catch {
      /* ignore */
    }
    dbSingleton = null;
    dbPathSingleton = null;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  migrate(db);
  dbSingleton = db;
  dbPathSingleton = dbPath;
  return db;
}

/**
 * Close the singleton (tests / shutdown).
 */
export function closeEventsFinderDb() {
  if (!dbSingleton) return;
  try {
    dbSingleton.close();
  } catch {
    /* ignore */
  }
  dbSingleton = null;
  dbPathSingleton = null;
}

/**
 * Upsert normalized events into the catalog.
 * @param {object[]} events
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ upserted: number, skipped: number }}
 */
export function upsertEventsFinderEvents(events, env = process.env) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return { upserted: 0, skipped: 0 };

  const db = openEventsFinderDb(env);
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO events (
      id, source, external_id, url, title, start_at, end_at,
      venue, city, lat, lon, online, description, image_url,
      payload_json, first_seen_at, last_seen_at
    ) VALUES (
      @id, @source, @externalId, @url, @title, @startAt, @endAt,
      @venue, @city, @lat, @lon, @online, @description, @imageUrl,
      @payloadJson, @firstSeenAt, @lastSeenAt
    )
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      external_id = excluded.external_id,
      url = excluded.url,
      title = excluded.title,
      start_at = excluded.start_at,
      end_at = excluded.end_at,
      venue = excluded.venue,
      city = excluded.city,
      lat = excluded.lat,
      lon = excluded.lon,
      online = excluded.online,
      description = excluded.description,
      image_url = excluded.image_url,
      payload_json = excluded.payload_json,
      last_seen_at = excluded.last_seen_at
  `);

  let upserted = 0;
  let skipped = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const event of list) {
      const row = normalizeRow(event);
      if (!row) {
        skipped += 1;
        continue;
      }
      stmt.run({
        id: row.id,
        source: row.source,
        externalId: row.externalId,
        url: row.url,
        title: row.title,
        startAt: row.startAt,
        endAt: row.endAt,
        venue: row.venue,
        city: row.city,
        lat: row.lat,
        lon: row.lon,
        online: row.online,
        description: row.description,
        imageUrl: row.imageUrl,
        payloadJson: row.payloadJson,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      upserted += 1;
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

  return { upserted, skipped };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {object}
 */
function rowToEvent(row) {
  /** @type {Record<string, unknown>} */
  let payload = {};
  try {
    const parsed = JSON.parse(String(row.payload_json || '{}'));
    if (parsed && typeof parsed === 'object') payload = /** @type {Record<string, unknown>} */ (parsed);
  } catch {
    payload = {};
  }

  const online = Number(row.online) === 1;
  return {
    ...payload,
    id: String(row.id),
    source: String(row.source || payload.source || 'unknown'),
    title: String(row.title || payload.title || ''),
    start: row.start_at != null ? String(row.start_at) : payload.start ?? null,
    end: row.end_at != null ? String(row.end_at) : payload.end ?? null,
    venue: row.venue != null ? String(row.venue) : payload.venue ?? null,
    location: row.venue != null ? String(row.venue) : payload.location ?? payload.venue ?? null,
    city: row.city != null ? String(row.city) : payload.city ?? null,
    lat: row.lat != null ? Number(row.lat) : payload.lat ?? null,
    lon: row.lon != null ? Number(row.lon) : payload.lon ?? null,
    url: row.url != null ? String(row.url) : payload.url ?? '',
    online,
    isOnline: online,
    description: row.description != null ? String(row.description) : payload.description ?? null,
    imageUrl: row.image_url != null ? String(row.image_url) : payload.imageUrl ?? null,
    firstSeenAt: row.first_seen_at != null ? String(row.first_seen_at) : null,
    lastSeenAt: row.last_seen_at != null ? String(row.last_seen_at) : null,
  };
}

/**
 * List catalog events (upcoming + undated), newest-seen first within undated.
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   cutoffIso?: string | null,
 *   limit?: number,
 * }} [opts]
 * @returns {object[]}
 */
export function listEventsFinderEvents(opts = {}) {
  const env = opts.env || process.env;
  const db = openEventsFinderDb(env);
  const cutoff =
    opts.cutoffIso != null
      ? String(opts.cutoffIso)
      : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const limitRaw = Number(opts.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 5000) : 2000;

  const rows = db
    .prepare(
      `
      SELECT *
      FROM events
      WHERE start_at IS NULL OR start_at >= ?
      ORDER BY
        CASE WHEN start_at IS NULL THEN 1 ELSE 0 END,
        start_at ASC,
        last_seen_at DESC
      LIMIT ?
    `,
    )
    .all(cutoff, limit);

  return rows.map((row) => rowToEvent(/** @type {Record<string, unknown>} */ (row)));
}

/**
 * List + collapse same name on the same local calendar day.
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   cutoffIso?: string | null,
 *   limit?: number,
 *   timeZone?: string,
 * }} [opts]
 * @returns {{ events: object[], removed: number }}
 */
export function listEventsFinderEventsDeduped(opts = {}) {
  const events = listEventsFinderEvents(opts);
  return dedupeEventsByNameAndDate(events, { timeZone: opts.timeZone });
}

/**
 * Drop events that ended (or started) before cutoff.
 * @param {{ env?: NodeJS.ProcessEnv, cutoffIso?: string }} [opts]
 * @returns {number} deleted count
 */
export function pruneEventsFinderEvents(opts = {}) {
  const env = opts.env || process.env;
  const db = openEventsFinderDb(env);
  const cutoff =
    opts.cutoffIso != null
      ? String(opts.cutoffIso)
      : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const result = db
    .prepare(
      `
      DELETE FROM events
      WHERE (end_at IS NOT NULL AND end_at < ?)
         OR (end_at IS NULL AND start_at IS NOT NULL AND start_at < ?)
    `,
    )
    .run(cutoff, cutoff);
  return Number(result.changes) || 0;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   path: string,
 *   count: number,
 *   bySource: Record<string, number>,
 *   oldestStart: string | null,
 *   newestStart: string | null,
 * }}
 */
export function getEventsFinderStoreStats(env = process.env) {
  const dbPath = eventsFinderDbPath(env);
  const db = openEventsFinderDb(env);
  const countRow = db.prepare('SELECT COUNT(*) AS n FROM events').get();
  const count = Number(/** @type {{ n?: unknown }} */ (countRow)?.n) || 0;
  const bySourceRows = db
    .prepare('SELECT source, COUNT(*) AS n FROM events GROUP BY source ORDER BY source')
    .all();
  /** @type {Record<string, number>} */
  const bySource = {};
  for (const row of bySourceRows) {
    const r = /** @type {{ source?: unknown, n?: unknown }} */ (row);
    bySource[String(r.source || 'unknown')] = Number(r.n) || 0;
  }
  const range = db
    .prepare(
      `
      SELECT MIN(start_at) AS oldest, MAX(start_at) AS newest
      FROM events
      WHERE start_at IS NOT NULL
    `,
    )
    .get();
  const rangeRow = /** @type {{ oldest?: unknown, newest?: unknown }} */ (range || {});
  return {
    path: dbPath,
    count,
    bySource,
    oldestStart: rangeRow.oldest != null ? String(rangeRow.oldest) : null,
    newestStart: rangeRow.newest != null ? String(rangeRow.newest) : null,
  };
}
