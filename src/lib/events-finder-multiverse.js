/**
 * Events finder — The Multiverse School public Google Calendar (ICS).
 * Source: https://themultiverse.school/calendar embed → public basic.ics
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRRule, effectiveEndMs } from './ical-recurrence.js';
import { parseIcsEvents } from './ical-parse.js';
import { loadEventsFinderCriteria } from './events-finder-criteria-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

/** Public Multiverse School calendar (from /calendar embed `src=`). */
export const MULTIVERSE_CALENDAR_ID =
  'c_e9fbd687c00a0947f9bb561a447d8b98164989ac6d7e58b527ba43097e9d1abe@group.calendar.google.com';

export const MULTIVERSE_SITE_URL = 'https://themultiverse.school/';
export const MULTIVERSE_CALENDAR_PAGE_URL = 'https://themultiverse.school/calendar';

const DEFAULT_CACHE_MS = 6 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; DashbirdEvents/1.0; +https://github.com/local/dashbird)';

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function multiverseEventsIcalUrl(env = process.env) {
  const override = String(env.MULTIVERSE_SCHOOL_ICAL_URL || '').trim();
  if (override) return override;
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(MULTIVERSE_CALENDAR_ID)}/public/basic.ics`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function multiverseEventsCachePath(env = process.env) {
  const override = String(env.MULTIVERSE_EVENTS_CACHE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'multiverse-events-cache.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function cacheMs(env = process.env) {
  const n = Number(env.MULTIVERSE_EVENTS_CACHE_MS);
  if (Number.isFinite(n) && n >= 60_000) return Math.min(n, 7 * 24 * 60 * 60 * 1000);
  return DEFAULT_CACHE_MS;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function readCache(env = process.env) {
  try {
    const raw = await readFile(multiverseEventsCachePath(env), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * @param {object} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeCache(payload, env = process.env) {
  const p = multiverseEventsCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * Expand RRULE masters to all occurrences in [now - 12h, now + horizonMs].
 * @param {ReturnType<typeof parseIcsEvents>} events
 * @param {number} nowMs
 * @param {number} horizonMs
 */
function expandInWindow(events, nowMs, horizonMs) {
  const windowStart = nowMs - 12 * 60 * 60 * 1000;
  const windowEnd = nowMs + horizonMs;
  /** @type {typeof events} */
  const out = [];
  const seen = new Set();

  /**
   * @param {object} ev
   */
  function push(ev) {
    const key = `${ev.id}|${ev.startMs}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ev);
  }

  for (const ev of events) {
    if (ev.status === 'CANCELLED') continue;
    if (ev.recurrenceId || !ev.rrule) {
      if (ev.startMs >= windowStart && ev.startMs <= windowEnd) push(ev);
      continue;
    }
    try {
      const rule = buildRRule(ev.rrule, ev.dtstartKey, ev.dtstartVal, ev.exdates || []);
      const duration =
        ev.endMs != null && ev.endMs > ev.startMs
          ? ev.endMs - ev.startMs
          : ev.allDay
            ? 24 * 60 * 60 * 1000
            : 60 * 60 * 1000;
      const between = rule.between(new Date(windowStart), new Date(windowEnd), true);
      for (const occ of between) {
        const startMs = occ.getTime();
        push({
          ...ev,
          id: `${ev.id}@${startMs}`,
          startMs,
          endMs: startMs + duration,
          seriesId: ev.id,
          rrule: '',
        });
      }
    } catch (err) {
      console.warn('[multiverse] RRULE expand failed:', ev.title, err?.message || err);
      if (ev.startMs >= windowStart && ev.startMs <= windowEnd) push(ev);
    }
  }

  return out;
}

/**
 * @param {object} ev ical event
 * @returns {object}
 */
function toFinderEvent(ev) {
  const loc = String(ev.location || '').trim();
  const locIsUrl = /^https?:\/\//i.test(loc);
  const online =
    locIsUrl
    || /meet\.google|zoom\.us|gather\.town|whereby\.com|discord\.gg/i.test(loc);
  return {
    id: `multiverse:${Buffer.from(String(ev.id)).toString('base64url').slice(0, 48)}`,
    title: String(ev.title || 'Multiverse School').trim(),
    start: new Date(ev.startMs).toISOString(),
    end: ev.endMs != null ? new Date(ev.endMs).toISOString() : null,
    venue: locIsUrl ? 'Online — Multiverse School' : loc || 'Multiverse School',
    city: online ? null : 'Oakland',
    lat: null,
    lon: null,
    url: locIsUrl ? loc : MULTIVERSE_CALENDAR_PAGE_URL,
    source: 'multiverse',
    online,
    isOnline: online,
    location: locIsUrl ? 'Online — Multiverse School' : loc || 'Multiverse School',
    description: null,
    imageUrl: null,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function fetchMultiverseSchoolEvents(env = process.env, opts = {}) {
  const force = opts.forceRefresh === true;
  const icalUrl = multiverseEventsIcalUrl(env);
  const cache = await readCache(env);
  if (!force && cache?.cachedAt) {
    const age = Date.now() - Date.parse(cache.cachedAt);
    if (Number.isFinite(age) && age >= 0 && age < cacheMs(env)) {
      return {
        ok: true,
        events: cache.events,
        fromCache: true,
        cachedAt: cache.cachedAt,
        count: cache.events.length,
        icalUrl,
        calendarPage: MULTIVERSE_CALENDAR_PAGE_URL,
      };
    }
  }

  let text = '';
  try {
    const r = await fetch(icalUrl, {
      headers: { Accept: 'text/calendar,text/plain,*/*', 'User-Agent': UA },
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) {
      if (cache?.events?.length) {
        return {
          ok: true,
          events: cache.events,
          fromCache: true,
          stale: true,
          cachedAt: cache.cachedAt,
          count: cache.events.length,
          icalUrl,
          error: `ical_http_${r.status}`,
        };
      }
      return {
        ok: false,
        events: [],
        fromCache: false,
        icalUrl,
        error: `ical_http_${r.status}`,
      };
    }
    text = await r.text();
  } catch (e) {
    if (cache?.events?.length) {
      return {
        ok: true,
        events: cache.events,
        fromCache: true,
        stale: true,
        cachedAt: cache.cachedAt,
        count: cache.events.length,
        icalUrl,
        error: String(e?.message || e),
      };
    }
    return {
      ok: false,
      events: [],
      fromCache: false,
      icalUrl,
      error: String(e?.message || e),
    };
  }

  if (!/BEGIN:VCALENDAR/i.test(text)) {
    return {
      ok: false,
      events: [],
      fromCache: false,
      icalUrl,
      error: 'ical_not_calendar',
    };
  }

  const tz =
    String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  let weeks = 2;
  try {
    const criteria = await loadEventsFinderCriteria();
    weeks = Math.min(Math.max(Number(criteria.scrape?.windowWeeks) || 2, 1), 4);
  } catch {
    /* defaults */
  }
  const horizonMs = weeks * 7 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const parsed = parseIcsEvents(text, tz);
  const expanded = expandInWindow(parsed, nowMs, horizonMs);
  const upcoming = expanded
    .filter((ev) => effectiveEndMs(ev, nowMs) > nowMs - 12 * 60 * 60 * 1000)
    .filter((ev) => ev.startMs <= nowMs + horizonMs)
    .sort((a, b) => a.startMs - b.startMs);

  const events = upcoming.map(toFinderEvent);
  const payload = {
    cachedAt: new Date().toISOString(),
    icalUrl,
    weeks,
    count: events.length,
    events,
  };
  await writeCache(payload, env);

  return {
    ok: true,
    events,
    fromCache: false,
    cachedAt: payload.cachedAt,
    count: events.length,
    icalUrl,
    calendarPage: MULTIVERSE_CALENDAR_PAGE_URL,
  };
}
