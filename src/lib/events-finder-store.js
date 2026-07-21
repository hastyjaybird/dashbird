/**
 * Events finder — local SQLite catalog (normalized events across sources).
 * Uses Node's built-in node:sqlite (DatabaseSync). Criteria stay in JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { eventTicketPriceRank } from './events-finder-price.js';
import { inferEventCity } from './events-finder-geo.js';

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
 * Persist lat/lon only when both are finite and not Null Island (0,0).
 * APIs often send missing geo as zeros; storing that pins the map in the Atlantic.
 * @param {unknown} latRaw
 * @param {unknown} lonRaw
 * @returns {{ lat: number | null, lon: number | null }}
 */
function toLatLonPair(latRaw, lonRaw) {
  const lat = toFiniteNumber(latRaw);
  const lon = toFiniteNumber(lonRaw);
  if (lat == null || lon == null) return { lat: null, lon: null };
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { lat: null, lon: null };
  if (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01) return { lat: null, lon: null };
  return { lat, lon };
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
 * Rewrite source image URLs that are blocked when hotlinked (e.g. Partiful Firebase).
 * @param {unknown} url
 * @returns {string | null}
 */
export function normalizeEventImageUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  // Banned: Telegram brand tile must never appear as event card art.
  if (raw === '/assets/tile-telegram.svg' || /\/tile-telegram\.svg(?:\?|$)/i.test(raw)) {
    return null;
  }
  if (/^external\/user\//i.test(raw) || /^external\//i.test(raw)) {
    return `https://partiful.imgix.net/${raw.replace(/^\/+/, '')}?fit=clip&w=640&auto=format`;
  }
  try {
    const u = new URL(raw);
    if (
      u.hostname === 'firebasestorage.googleapis.com'
      && /getpartiful\.appspot\.com/i.test(u.pathname)
    ) {
      const m = u.pathname.match(/\/o\/(.+)$/);
      if (m) {
        const objectPath = decodeURIComponent(m[1]).replace(/^\/+/, '');
        if (objectPath) {
          return `https://partiful.imgix.net/${objectPath}?fit=clip&w=640&auto=format`;
        }
      }
    }
  } catch {
    /* keep raw */
  }
  return raw.slice(0, 2000);
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
 * Drop weekday words so "Saturday Night Networking" ≈ "Sunday Night Networking".
 * @param {string} titleKey
 * @returns {string}
 */
export function stripWeekdayFromTitleKey(titleKey) {
  return String(titleKey || '')
    .replace(
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable series identity: same Meetup group (or source+venue) + weekday-stripped title.
 * @param {object} event
 * @returns {string | null}
 */
export function eventSeriesDedupeKey(event) {
  const titleKey = stripWeekdayFromTitleKey(
    normalizeEventTitleKey(/** @type {{ title?: unknown }} */ (event)?.title),
  );
  if (!titleKey) return null;

  const source = String(/** @type {{ source?: unknown }} */ (event)?.source || '')
    .trim()
    .toLowerCase() || 'unknown';

  let group = String(/** @type {{ groupSlug?: unknown }} */ (event)?.groupSlug || '')
    .trim()
    .toLowerCase();

  if (!group) {
    const url = String(
      /** @type {{ groupUrl?: unknown, url?: unknown }} */ (event)?.groupUrl
        || /** @type {{ url?: unknown }} */ (event)?.url
        || '',
    ).trim();
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '').toLowerCase();
      if (host === 'meetup.com') {
        const slug = u.pathname.split('/').filter(Boolean)[0] || '';
        if (slug && slug !== 'find' && slug !== 'events') group = slug;
      }
    } catch {
      /* ignore */
    }
  }

  if (!group) {
    const venue = normalizeEventTitleKey(
      /** @type {{ venue?: unknown, location?: unknown }} */ (event)?.venue
        || /** @type {{ location?: unknown }} */ (event)?.location
        || '',
    );
    const city = normalizeEventTitleKey(/** @type {{ city?: unknown }} */ (event)?.city || '');
    group = venue || city || '';
  }

  // Without a group/venue anchor, don't series-collapse (too aggressive for generic titles).
  if (!group) return null;
  return `${source}|${group}|${titleKey}`;
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
  multiverse: 4,
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
 * Prefer the listing with the higher ticket price; otherwise richer / more canonical.
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

  /**
   * @param {object} a
   * @param {object} b
   * @returns {boolean} true when `b` should replace `a`
   */
  function shouldPrefer(a, b) {
    const pa = eventTicketPriceRank(a);
    const pb = eventTicketPriceRank(b);
    if (pa != null && pb != null && pa !== pb) return pb > pa;
    if (pb != null && pb > 0 && (pa == null || pa <= 0)) return true;
    if (pa != null && pa > 0 && (pb == null || pb <= 0)) return false;
    return eventRichnessScore(b) > eventRichnessScore(a);
  }

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
    if (shouldPrefer(prev, event)) {
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
  const removedSameDay = Math.max(0, list.length - deduped.length);

  // Second pass: same group + weekday-stripped title → keep soonest occurrence only.
  // Fixes recurring Meetup series like "Saturday Night Networking" vs "Sunday Night Networking".
  const series = collapseRecurringSeriesEvents(deduped);
  return {
    events: series.events,
    removed: removedSameDay + series.removed,
    removedSameDay,
    removedSeries: series.removed,
  };
}

/**
 * Keep the soonest upcoming event per series key (group + title without weekday).
 * @param {object[]} events
 * @returns {{ events: object[], removed: number }}
 */
export function collapseRecurringSeriesEvents(events) {
  const list = Array.isArray(events) ? events : [];
  /** @type {Map<string, object>} */
  const winners = new Map();
  /** @type {object[]} */
  const passthrough = [];

  /**
   * @param {object} ev
   * @returns {number}
   */
  function startMs(ev) {
    const t = Date.parse(String(ev?.start || ''));
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  }

  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    const key = eventSeriesDedupeKey(event);
    if (!key) {
      passthrough.push(event);
      continue;
    }
    const prev = winners.get(key);
    if (!prev) {
      winners.set(key, event);
      continue;
    }
    const preferNew = startMs(event) < startMs(prev);
    const keep = preferNew ? event : prev;
    const drop = preferNew ? prev : event;
    const dupes = Array.isArray(keep.duplicateIds) ? keep.duplicateIds : [];
    const dropId = String(drop.id || '').trim();
    winners.set(key, {
      ...keep,
      duplicateIds: dropId && !dupes.includes(dropId) ? [...dupes, dropId] : dupes,
    });
  }

  const out = [...winners.values(), ...passthrough];
  return { events: out, removed: Math.max(0, list.length - out.length) };
}

/**
 * Count how many catalog events share each series key (before collapse).
 * @param {object[]} events
 * @returns {Map<string, number>}
 */
export function countEventSeriesKeys(events) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const key = eventSeriesDedupeKey(event);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Attach seriesKey / isSeries using pre-collapse counts (and collapse duplicateIds).
 * @param {object[]} events
 * @param {Map<string, number>} [seriesCounts]
 * @returns {object[]}
 */
export function annotateEventsWithSeriesInfo(events, seriesCounts) {
  const list = Array.isArray(events) ? events : [];
  const counts = seriesCounts instanceof Map ? seriesCounts : countEventSeriesKeys(list);
  return list.map((event) => {
    if (!event || typeof event !== 'object') return event;
    const seriesKey = eventSeriesDedupeKey(event);
    const seriesCount = seriesKey ? counts.get(seriesKey) || 0 : 0;
    const dupes = Array.isArray(/** @type {{ duplicateIds?: unknown }} */ (event).duplicateIds)
      ? /** @type {{ duplicateIds: unknown[] }} */ (event).duplicateIds.length
      : 0;
    const isSeries = Boolean(seriesKey && (seriesCount >= 2 || dupes > 0));
    return {
      ...event,
      seriesKey: seriesKey || null,
      seriesCount: seriesKey ? seriesCount : 0,
      isSeries,
    };
  });
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
  let city = cityRaw != null ? String(cityRaw).trim().slice(0, 120) || null : null;
  const descriptionRaw = /** @type {{ description?: unknown }} */ (event).description;
  const description =
    descriptionRaw != null ? String(descriptionRaw).replace(/\s+/g, ' ').trim().slice(0, 2000) || null : null;
  const imageRaw = /** @type {{ imageUrl?: unknown }} */ (event).imageUrl;
  const imageUrl = normalizeEventImageUrl(imageRaw);

  if (!city) {
    city =
      inferEventCity({
        city: null,
        venue,
        location: venue,
        title,
        description,
        url,
      })?.slice(0, 120) || null;
  }

  /** @type {Record<string, unknown>} */
  const payload = { .../** @type {Record<string, unknown>} */ (event) };
  if (city && !payload.city) payload.city = city;
  // Keep raw but avoid huge nested blobs blowing the row — still store what sources send.
  try {
    JSON.stringify(payload);
  } catch {
    delete payload.raw;
  }

  const { lat, lon } = toLatLonPair(
    /** @type {{ lat?: unknown }} */ (event).lat,
    /** @type {{ lon?: unknown }} */ (event).lon,
  );

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
    lat,
    lon,
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
    CREATE TABLE IF NOT EXISTS skipped_events (
      id TEXT PRIMARY KEY NOT NULL,
      url_key TEXT,
      name_date_key TEXT,
      title TEXT,
      start_at TEXT,
      source TEXT,
      venue TEXT,
      city TEXT,
      image_url TEXT,
      skipped_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skipped_events_url ON skipped_events(url_key);
    CREATE INDEX IF NOT EXISTS idx_skipped_events_name_date ON skipped_events(name_date_key);
  `);
  ensureSkippedSeriesKeyColumn(db);
  ensureSkippedTasteJsonColumn(db);
}

/**
 * @param {DatabaseSync} db
 */
function ensureSkippedTasteJsonColumn(db) {
  const cols = db.prepare('PRAGMA table_info(skipped_events)').all();
  const hasTaste = (Array.isArray(cols) ? cols : []).some(
    (c) => String(/** @type {{ name?: unknown }} */ (c)?.name || '') === 'taste_json',
  );
  if (!hasTaste) {
    db.exec('ALTER TABLE skipped_events ADD COLUMN taste_json TEXT');
  }
}

/**
 * @param {DatabaseSync} db
 */
function ensureSkippedSeriesKeyColumn(db) {
  const cols = db.prepare('PRAGMA table_info(skipped_events)').all();
  const hasSeries = (Array.isArray(cols) ? cols : []).some(
    (c) => String(/** @type {{ name?: unknown }} */ (c)?.name || '') === 'series_key',
  );
  if (!hasSeries) {
    db.exec('ALTER TABLE skipped_events ADD COLUMN series_key TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_skipped_events_series ON skipped_events(series_key)');
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
      image_url = COALESCE(excluded.image_url, events.image_url),
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
 * Fresh SQLite read by id — used to confirm Telegram ingest actually persisted.
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object | null}
 */
export function getEventsFinderEventById(id, env = process.env) {
  const key = String(id || '').trim();
  if (!key) return null;
  const db = openEventsFinderDb(env);
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(key);
  return row ? rowToEvent(row) : null;
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
  const venue = row.venue != null ? String(row.venue) : payload.venue ?? null;
  const title = String(row.title || payload.title || '');
  const url = row.url != null ? String(row.url) : payload.url ?? '';
  const description =
    row.description != null ? String(row.description) : payload.description ?? null;
  let city = row.city != null ? String(row.city) : payload.city ?? null;
  if (!city) {
    city = inferEventCity({
      city: null,
      venue,
      location: venue ?? payload.location ?? null,
      title,
      description,
      url,
    });
  }
  return {
    ...payload,
    id: String(row.id),
    source: String(row.source || payload.source || 'unknown'),
    title,
    start: row.start_at != null ? String(row.start_at) : payload.start ?? null,
    end: row.end_at != null ? String(row.end_at) : payload.end ?? null,
    venue,
    location: venue != null ? venue : payload.location ?? payload.venue ?? null,
    city,
    lat: row.lat != null ? Number(row.lat) : payload.lat ?? null,
    lon: row.lon != null ? Number(row.lon) : payload.lon ?? null,
    url,
    online,
    isOnline: online,
    description,
    imageUrl: normalizeEventImageUrl(
      row.image_url != null ? String(row.image_url) : payload.imageUrl ?? null,
    ),
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
 * Drop events that have ended (end_at in the past).
 * If end_at is missing, drop when start_at is more than 12 hours ago.
 * @param {{ env?: NodeJS.ProcessEnv, nowIso?: string }} [opts]
 * @returns {number} deleted count
 */
export function pruneEventsFinderEvents(opts = {}) {
  const env = opts.env || process.env;
  const db = openEventsFinderDb(env);
  const now = opts.nowIso != null ? String(opts.nowIso) : new Date().toISOString();
  const startFallback = new Date(Date.parse(now) - 12 * 60 * 60 * 1000).toISOString();
  // Dateless invites (kept from Gmail so we don't miss undated event mail) can't be
  // pruned by start/end. Drop them once they stop being re-seen (rolled out of the
  // intake mail window) so they don't accumulate forever.
  const datelessStaleDays = Number(env.EVENTS_FINDER_DATELESS_TTL_DAYS);
  const staleDays = Number.isFinite(datelessStaleDays) && datelessStaleDays > 0
    ? datelessStaleDays
    : 30;
  const datelessCutoff = new Date(Date.parse(now) - staleDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db
    .prepare(
      `
      DELETE FROM events
      WHERE (end_at IS NOT NULL AND end_at < ?)
         OR (end_at IS NULL AND start_at IS NOT NULL AND start_at < ?)
         OR (start_at IS NULL AND last_seen_at IS NOT NULL AND last_seen_at < ?)
    `,
    )
    .run(now, startFallback, datelessCutoff);
  return Number(result.changes) || 0;
}

/**
 * Delete catalog rows by id (used when the user skips an event).
 * @param {string[]} ids
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function deleteEventsFinderByIds(ids, env = process.env) {
  const list = (Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .slice(0, 1000);
  if (!list.length) return 0;
  const db = openEventsFinderDb(env);
  const stmt = db.prepare('DELETE FROM events WHERE id = ?');
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of list) {
      const r = stmt.run(id);
      deleted += Number(r.changes) || 0;
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
 * Delete catalog rows by exact event URL (e.g. Multiverse class pages that filled up).
 * @param {string[]} urls
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function deleteEventsFinderByUrls(urls, env = process.env) {
  const list = [
    ...new Set(
      (Array.isArray(urls) ? urls : [])
        .map((u) => String(u || '').trim())
        .filter(Boolean),
    ),
  ].slice(0, 500);
  if (!list.length) return 0;
  const db = openEventsFinderDb(env);
  const stmt = db.prepare('DELETE FROM events WHERE url = ?');
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const url of list) {
      const r = stmt.run(url);
      deleted += Number(r.changes) || 0;
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
 *   tasteLookFor?: string[] | null,
 *   tasteGrey?: string[] | null,
 *   tasteBlack?: string[] | null,
 * }} EventsFinderSkippedRow
 */

/**
 * @param {unknown} raw
 * @returns {{ tasteLookFor?: string[], tasteGrey?: string[], tasteBlack?: string[] }}
 */
function parseSkippedTasteJson(raw) {
  if (raw == null || raw === '') return {};
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object') return {};
    const row = /** @type {Record<string, unknown>} */ (o);
    const tasteLookFor = Array.isArray(row.tasteLookFor)
      ? row.tasteLookFor.map((l) => String(l || '').trim()).filter(Boolean).slice(0, 24)
      : undefined;
    const tasteGrey = Array.isArray(row.tasteGrey)
      ? row.tasteGrey.map((l) => String(l || '').trim()).filter(Boolean).slice(0, 24)
      : undefined;
    const tasteBlack = Array.isArray(row.tasteBlack)
      ? row.tasteBlack.map((l) => String(l || '').trim()).filter(Boolean).slice(0, 24)
      : undefined;
    return {
      ...(tasteLookFor?.length ? { tasteLookFor } : {}),
      ...(tasteGrey?.length ? { tasteGrey } : {}),
      ...(tasteBlack?.length ? { tasteBlack } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, unknown>} rec
 * @returns {string | null}
 */
function serializeSkippedTasteJson(rec) {
  const tasteLookFor = Array.isArray(rec.tasteLookFor)
    ? rec.tasteLookFor.map((l) => String(l || '').trim()).filter(Boolean).slice(0, 24)
    : [];
  const tasteGrey = Array.isArray(rec.tasteGrey)
    ? rec.tasteGrey.map((l) => String(l || '').trim()).filter(Boolean).slice(0, 24)
    : [];
  const tasteBlack = Array.isArray(rec.tasteBlack)
    ? rec.tasteBlack.map((l) => String(l || '').trim()).filter(Boolean).slice(0, 24)
    : [];
  if (!tasteLookFor.length && !tasteGrey.length && !tasteBlack.length) return null;
  return JSON.stringify({
    ...(tasteLookFor.length ? { tasteLookFor } : {}),
    ...(tasteGrey.length ? { tasteGrey } : {}),
    ...(tasteBlack.length ? { tasteBlack } : {}),
  });
}

/**
 * @param {Record<string, unknown>} row
 * @returns {EventsFinderSkippedRow}
 */
function skippedDbRowToRecord(row) {
  const taste = parseSkippedTasteJson(row.taste_json);
  return {
    id: String(row.id || ''),
    key: row.name_date_key != null ? String(row.name_date_key) : null,
    url: row.url_key != null ? String(row.url_key) : null,
    title: row.title != null ? String(row.title) : null,
    start: row.start_at != null ? String(row.start_at) : null,
    source: row.source != null ? String(row.source) : null,
    venue: row.venue != null ? String(row.venue) : null,
    city: row.city != null ? String(row.city) : null,
    imageUrl: row.image_url != null ? String(row.image_url) : null,
    seriesKey: row.series_key != null ? String(row.series_key) : null,
    skippedAt: String(row.skipped_at || new Date().toISOString()),
    ...taste,
  };
}

/**
 * List skipped events from SQLite (source of truth for hide-from-feed).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {EventsFinderSkippedRow[]}
 */
export function listSkippedEventsFinderRecords(env = process.env) {
  const db = openEventsFinderDb(env);
  const rows = db
    .prepare(
      `
      SELECT id, url_key, name_date_key, title, start_at, source, venue, city, image_url, series_key, skipped_at, taste_json
      FROM skipped_events
      ORDER BY skipped_at DESC
      LIMIT 1000
    `,
    )
    .all();
  return rows.map((row) => skippedDbRowToRecord(/** @type {Record<string, unknown>} */ (row)));
}

/**
 * Upsert skip records into SQLite (does not remove other skips).
 * @param {Array<{
 *   id?: unknown,
 *   key?: unknown,
 *   url?: unknown,
 *   title?: unknown,
 *   start?: unknown,
 *   source?: unknown,
 *   venue?: unknown,
 *   city?: unknown,
 *   imageUrl?: unknown,
 *   skippedAt?: unknown,
 * }>} records
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function upsertSkippedEventsFinderRecords(records, env = process.env) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return 0;
  const db = openEventsFinderDb(env);
  const stmt = db.prepare(`
    INSERT INTO skipped_events (
      id, url_key, name_date_key, title, start_at, source, venue, city, image_url, series_key, skipped_at, taste_json
    ) VALUES (
      @id, @urlKey, @nameDateKey, @title, @startAt, @source, @venue, @city, @imageUrl, @seriesKey, @skippedAt, @tasteJson
    )
    ON CONFLICT(id) DO UPDATE SET
      url_key = COALESCE(excluded.url_key, skipped_events.url_key),
      name_date_key = COALESCE(excluded.name_date_key, skipped_events.name_date_key),
      title = COALESCE(excluded.title, skipped_events.title),
      start_at = COALESCE(excluded.start_at, skipped_events.start_at),
      source = COALESCE(excluded.source, skipped_events.source),
      venue = COALESCE(excluded.venue, skipped_events.venue),
      city = COALESCE(excluded.city, skipped_events.city),
      image_url = COALESCE(excluded.image_url, skipped_events.image_url),
      series_key = COALESCE(excluded.series_key, skipped_events.series_key),
      skipped_at = excluded.skipped_at,
      taste_json = COALESCE(excluded.taste_json, skipped_events.taste_json)
  `);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const rec of list) {
      const id = String(rec?.id || '').trim().slice(0, 400);
      if (!id) continue;
      const title = rec.title != null ? String(rec.title).trim().slice(0, 500) || null : null;
      const start = rec.start != null ? String(rec.start).trim().slice(0, 40) || null : null;
      const keyRaw = rec.key != null ? String(rec.key).trim().slice(0, 400) : '';
      const nameDateKey =
        keyRaw
        || (title && start
          ? eventNameDateDedupeKey({ title, start }, env.WEATHER_TIME_ZONE)
          : null);
      const urlKey = rec.url != null ? String(rec.url).trim().slice(0, 500) || null : null;
      const seriesKey =
        rec.seriesKey != null ? String(rec.seriesKey).trim().slice(0, 400) || null : null;
      stmt.run({
        id,
        urlKey,
        nameDateKey: nameDateKey || null,
        title,
        startAt: start,
        source: rec.source != null ? String(rec.source).trim().slice(0, 64) || null : null,
        venue: rec.venue != null ? String(rec.venue).trim().slice(0, 300) || null : null,
        city: rec.city != null ? String(rec.city).trim().slice(0, 120) || null : null,
        imageUrl: rec.imageUrl != null ? String(rec.imageUrl).trim().slice(0, 2000) || null : null,
        seriesKey,
        skippedAt:
          rec.skippedAt != null && String(rec.skippedAt).trim()
            ? String(rec.skippedAt).trim().slice(0, 40)
            : new Date().toISOString(),
        tasteJson: serializeSkippedTasteJson(/** @type {Record<string, unknown>} */ (rec)),
      });
      n += 1;
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
  return n;
}

/**
 * Replace the full skipped set in SQLite in a single transaction.
 * Prefer upsert + delete-by-id for normal Skip/Unskip — full replace is only for
 * rare admin/migration paths and must never leave an empty table on upsert failure.
 * @param {Array<object>} records
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function replaceSkippedEventsFinderRecords(records, env = process.env) {
  const list = Array.isArray(records) ? records : [];
  const db = openEventsFinderDb(env);
  const stmt = db.prepare(`
    INSERT INTO skipped_events (
      id, url_key, name_date_key, title, start_at, source, venue, city, image_url, skipped_at
    ) VALUES (
      @id, @urlKey, @nameDateKey, @title, @startAt, @source, @venue, @city, @imageUrl, @skippedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      url_key = COALESCE(excluded.url_key, skipped_events.url_key),
      name_date_key = COALESCE(excluded.name_date_key, skipped_events.name_date_key),
      title = COALESCE(excluded.title, skipped_events.title),
      start_at = COALESCE(excluded.start_at, skipped_events.start_at),
      source = COALESCE(excluded.source, skipped_events.source),
      venue = COALESCE(excluded.venue, skipped_events.venue),
      city = COALESCE(excluded.city, skipped_events.city),
      image_url = COALESCE(excluded.image_url, skipped_events.image_url),
      skipped_at = excluded.skipped_at
  `);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM skipped_events').run();
    for (const rec of list) {
      const id = String(rec?.id || '').trim().slice(0, 400);
      if (!id) continue;
      const title = rec.title != null ? String(rec.title).trim().slice(0, 500) || null : null;
      const start = rec.start != null ? String(rec.start).trim().slice(0, 40) || null : null;
      const keyRaw = rec.key != null ? String(rec.key).trim().slice(0, 400) : '';
      const nameDateKey =
        keyRaw
        || (title && start
          ? eventNameDateDedupeKey({ title, start }, env.WEATHER_TIME_ZONE)
          : null);
      const urlKey = rec.url != null ? String(rec.url).trim().slice(0, 500) || null : null;
      stmt.run({
        id,
        urlKey,
        nameDateKey: nameDateKey || null,
        title,
        startAt: start,
        source: rec.source != null ? String(rec.source).trim().slice(0, 64) || null : null,
        venue: rec.venue != null ? String(rec.venue).trim().slice(0, 300) || null : null,
        city: rec.city != null ? String(rec.city).trim().slice(0, 120) || null : null,
        imageUrl: rec.imageUrl != null ? String(rec.imageUrl).trim().slice(0, 2000) || null : null,
        skippedAt:
          rec.skippedAt != null && String(rec.skippedAt).trim()
            ? String(rec.skippedAt).trim().slice(0, 40)
            : new Date().toISOString(),
      });
      n += 1;
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
  return n;
}

/**
 * Remove skip designations by id (Unskip).
 * @param {string[]} ids
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function deleteSkippedEventsFinderByIds(ids, env = process.env) {
  const list = (Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .slice(0, 1000);
  if (!list.length) return 0;
  const db = openEventsFinderDb(env);
  const stmt = db.prepare('DELETE FROM skipped_events WHERE id = ?');
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of list) {
      const r = stmt.run(id);
      deleted += Number(r.changes) || 0;
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
