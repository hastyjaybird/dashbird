import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendCalendarEmbedSrcs,
  normalizeCalendarEmbedUrl,
  resolveCalendarEmbedExtraSrcs,
} from './calendar-embed.js';
import { fetchGcalIcsPinnedEvents } from './events-finder-gcal-ics.js';
import { expandRecurringIcsEvents } from './ical-recurrence.js';
import { parseIcsCalendarMeta, parseIcsEvents, upcomingCalendarEvents } from './ical-parse.js';
import {
  loadManualCalendarEvents,
  manualEventToUpcoming,
} from './manual-calendar-events.js';

const CACHE_MS = 3 * 60 * 1000;
const DISK_CACHE_MAX_MS = 30 * 60 * 1000;
const DISK_CACHE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/calendar-upcoming-cache.json',
);
const DEFAULT_CALENDAR_CTZ = 'America/Los_Angeles';
/** @type {{ at: number, key: string, events: object[] } | null} */
let cache = null;
/** @type {Promise<void> | null} */
let refreshPromise = null;

/**
 * Normalize GOOGLE_CALENDAR_ICAL_URL: trim quotes, fix `basic.` → `basic.ics`.
 * @param {string|undefined} raw
 * @returns {string}
 */
export function normalizeGoogleCalendarIcalUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/&amp;/g, '&');
  if (/\/basic\.\s*$/i.test(s)) s = `${s}ics`;
  if (/\/basic$/i.test(s)) s = `${s}.ics`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    if (!u.hostname.toLowerCase().includes('google.com')) return '';
    if (!u.pathname.includes('/calendar/ical/')) return '';
    return u.toString();
  } catch {
    return '';
  }
}

/**
 * @param {string} icalUrl
 */
export function calendarSrcFromIcalUrl(icalUrl) {
  try {
    const m = new URL(icalUrl).pathname.match(/\/calendar\/ical\/([^/]+)\//i);
    return m?.[1] ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} calendarSrc
 * @param {string} [ctz]
 */
export function embedUrlFromCalendarSrc(calendarSrc, ctz = DEFAULT_CALENDAR_CTZ) {
  const s = String(calendarSrc || '').trim();
  if (!s) return '';
  const u = new URL('https://calendar.google.com/calendar/embed');
  u.searchParams.set('src', s);
  u.searchParams.set('ctz', ctz || DEFAULT_CALENDAR_CTZ);
  return normalizeCalendarEmbedUrl(u.toString());
}

/**
 * @param {string} embedUrl
 */
export function calendarSrcFromEmbedUrl(embedUrl) {
  try {
    const src = new URL(embedUrl).searchParams.get('src');
    return src ? decodeURIComponent(src) : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} calendarSrc email or calendar id from embed `src`
 */
/**
 * @param {string} embedUrl
 */
export function calendarWeekUrlFromEmbed(embedUrl) {
  try {
    const u = new URL(embedUrl);
    const out = new URL('https://calendar.google.com/calendar/u/0/r/week');
    const src = u.searchParams.get('src');
    const ctz = u.searchParams.get('ctz');
    if (src) out.searchParams.set('src', src);
    if (ctz) out.searchParams.set('ctz', ctz);
    return out.toString();
  } catch {
    return 'https://calendar.google.com/';
  }
}

export function publicIcalUrlFromCalendarSrc(calendarSrc) {
  const s = String(calendarSrc || '').trim();
  if (!s) return '';
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(s)}/public/basic.ics`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveGoogleCalendarIcalUrl(env = process.env) {
  const explicit = normalizeGoogleCalendarIcalUrl(env.GOOGLE_CALENDAR_ICAL_URL);
  if (explicit) return explicit;

  const embed = normalizeCalendarEmbedUrl(env.CALENDAR_EMBED_URL);
  if (!embed) return '';
  const src = calendarSrcFromEmbedUrl(embed);
  return publicIcalUrlFromCalendarSrc(src);
}

/**
 * Embed URL from CALENDAR_EMBED_URL or derived from GOOGLE_CALENDAR_ICAL_URL,
 * plus extra calendars (Random Events / CALENDAR_EMBED_EXTRA_SRCS).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveCalendarEmbedUrl(env = process.env) {
  let embed = normalizeCalendarEmbedUrl(env.CALENDAR_EMBED_URL);
  if (!embed) {
    const ical = resolveGoogleCalendarIcalUrl(env);
    if (!ical) return '';
    const src = calendarSrcFromIcalUrl(ical);
    embed = embedUrlFromCalendarSrc(src, resolveCalendarTimeZone(env));
  }
  return appendCalendarEmbedSrcs(embed, resolveCalendarEmbedExtraSrcs(env));
}

/**
 * @param {object} ev  normalized gcal-ics / Partiful pin event
 * @returns {{ id: string, title: string, location: string, startMs: number, endMs: number | null, allDay: boolean, calendarName: string } | null}
 */
function pinEventToUpcoming(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const startMs = Date.parse(String(/** @type {{ start?: unknown }} */ (ev).start || ''));
  if (!Number.isFinite(startMs)) return null;
  const endRaw = /** @type {{ end?: unknown }} */ (ev).end;
  const endMs = endRaw != null && String(endRaw).trim() ? Date.parse(String(endRaw)) : null;
  const title = String(/** @type {{ title?: unknown }} */ (ev).title || '').trim() || 'Calendar event';
  const location = String(
    /** @type {{ venue?: unknown, location?: unknown }} */ (ev).venue
      || /** @type {{ location?: unknown }} */ (ev).location
      || '',
  ).trim();
  const calendarName = String(
    /** @type {{ calendarName?: unknown }} */ (ev).calendarName
      || /** @type {{ source?: unknown }} */ (ev).source
      || 'Synced',
  ).trim() || 'Synced';
  const id = String(/** @type {{ id?: unknown }} */ (ev).id || `${calendarName}:${startMs}`).trim();
  return {
    id,
    title,
    location,
    startMs,
    endMs: Number.isFinite(endMs) ? endMs : null,
    allDay: false,
    calendarName,
  };
}

/**
 * @param {object[]} primary
 * @param {object[]} pinned
 * @returns {object[]}
 */
function mergeUpcomingCalendarEvents(primary, pinned) {
  /**
   * @param {unknown} title
   */
  function titleKey(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * Same calendar day in UTC (good enough for all-day + timed merge).
   * @param {number} startMs
   */
  function dayKey(startMs) {
    if (!Number.isFinite(startMs)) return '';
    return new Date(startMs).toISOString().slice(0, 10);
  }

  /**
   * Treat "Open Sauce" / "Open Sauce 2026" as the same event when days overlap.
   * @param {string} a
   * @param {string} b
   */
  function titlesMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.includes(b) || b.includes(a);
  }

  /** @type {object[]} */
  const out = [];

  for (const ev of [...(primary || []), ...(pinned || [])]) {
    if (!ev || typeof ev !== 'object') continue;
    const tk = titleKey(ev.title);
    const dk = dayKey(ev.startMs);
    if (!tk) continue;

    const existing = out.find((o) => titlesMatch(titleKey(o.title), tk) && (
      !dk
      || !dayKey(o.startMs)
      || dayKey(o.startMs) === dk
      // Multi-day spans: overlap if either start falls inside the other's window.
      || (
        Number.isFinite(o.startMs)
        && Number.isFinite(o.endMs)
        && ev.startMs >= o.startMs
        && ev.startMs < o.endMs
      )
      || (
        Number.isFinite(ev.startMs)
        && Number.isFinite(ev.endMs)
        && o.startMs >= ev.startMs
        && o.startMs < ev.endMs
      )
    ));

    if (!existing) {
      out.push({ ...ev });
      continue;
    }

    // Prefer richer location / longer title / explicit url.
    if (!existing.location && ev.location) existing.location = ev.location;
    if (String(ev.title || '').length > String(existing.title || '').length) {
      existing.title = ev.title;
    }
    if (!existing.url && ev.url) existing.url = ev.url;
    if (
      (!Number.isFinite(existing.endMs) || existing.endMs == null)
      && Number.isFinite(ev.endMs)
    ) {
      existing.endMs = ev.endMs;
    }
    // Keep the earlier start when merging a timed detail onto an all-day block.
    if (
      Number.isFinite(ev.startMs)
      && Number.isFinite(existing.startMs)
      && ev.startMs < existing.startMs
      && ev.allDay !== true
    ) {
      existing.startMs = ev.startMs;
      existing.allDay = false;
    }
  }

  out.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? 1 : -1;
    return (a.startMs || 0) - (b.startMs || 0);
  });
  return out.slice(0, 80);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveCalendarTimeZone(env = process.env) {
  const fromEnv = (env.WEATHER_TIME_ZONE || '').trim();
  if (fromEnv) return fromEnv;
  const embed = normalizeCalendarEmbedUrl(env.CALENDAR_EMBED_URL);
  if (embed) {
    try {
      const ctz = new URL(embed).searchParams.get('ctz');
      if (ctz) return decodeURIComponent(ctz);
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_CALENDAR_CTZ;
}

function isPublicIcalPath(url) {
  return /\/public\/basic\.ics$/i.test(String(url || ''));
}

/**
 * @param {string} icalUrl
 * @param {string} tz
 * @param {number} nowMs
 */
async function fetchIcalEventsFromGoogle(icalUrl, tz, nowMs = Date.now()) {
  const ac = new AbortController();
  const fetchTimer = setTimeout(() => ac.abort(), 25_000);
  let r;
  try {
    r = await fetch(icalUrl, {
      headers: { 'User-Agent': 'Dashbird/1.0 (calendar-upcoming)' },
      signal: ac.signal,
    });
  } catch (e) {
    return {
      ok: false,
      error: e?.name === 'AbortError' ? 'ical_fetch_timeout' : 'ical_fetch_failed',
      hint:
        e?.name === 'AbortError'
          ? 'Google did not respond within 25s. Check network/DNS from the host or try again.'
          : 'Could not reach the iCal URL. Check GOOGLE_CALENDAR_ICAL_URL and outbound connectivity.',
      events: [],
    };
  } finally {
    clearTimeout(fetchTimer);
  }
  if (!r.ok) {
    const calendarSrc = calendarSrcFromIcalUrl(icalUrl);
    const publicPath = isPublicIcalPath(icalUrl);
    const needsSecretIcal = r.status === 404 && publicPath;
    let hint =
      'Could not fetch the calendar feed. For private calendars, paste the secret iCal URL from Google Calendar settings into GOOGLE_CALENDAR_ICAL_URL.';
    if (needsSecretIcal) {
      hint = calendarSrc
        ? `Google returned 404 for the public iCal feed (${calendarSrc}). The calendar is not shared publicly yet — in Google Calendar → Settings → that calendar → Access permissions, turn on “Make available to public”, save, wait a minute, and restart. Or paste the Secret address in iCal format into GOOGLE_CALENDAR_ICAL_URL instead.`
        : 'Google returned 404 for this public iCal URL. Enable “Make available to public” for the calendar, or use the Secret address in iCal format in GOOGLE_CALENDAR_ICAL_URL.';
    } else if (r.status === 404) {
      hint =
        'Google returned 404 for GOOGLE_CALENDAR_ICAL_URL. Check the URL from Calendar → Settings → Integrate calendar (public or secret iCal).';
    }
    return {
      ok: false,
      error: `ical_http_${r.status}`,
      needsSecretIcal,
      calendarSrc: calendarSrc || '',
      hint,
      events: [],
    };
  }

  const text = await r.text();
  const head = text.slice(0, 512).trimStart();
  if (!head.startsWith('BEGIN:VCALENDAR')) {
    return {
      ok: false,
      error: 'ical_not_calendar',
      hint: 'The iCal URL did not return a valid calendar file. Check GOOGLE_CALENDAR_ICAL_URL in .env.',
      events: [],
    };
  }
  const parsed = parseIcsEvents(text, tz);
  const expanded = expandRecurringIcsEvents(parsed, nowMs);
  const calendarName =
    parseIcsCalendarMeta(text) || calendarSrcFromIcalUrl(icalUrl) || '';
  const events = upcomingCalendarEvents(expanded, nowMs).slice(0, 80).map((ev) => ({
    id: ev.id,
    title: ev.title,
    location: ev.location,
    startMs: ev.startMs,
    endMs: ev.endMs,
    allDay: ev.allDay,
    calendarName,
  }));

  return { ok: true, events, calendarName };
}

function calendarSuccessPayload(icalUrl, tz, events, meta = {}) {
  const calendarName = events[0]?.calendarName || calendarSrcFromIcalUrl(icalUrl) || '';
  return {
    ok: true,
    timeZone: tz,
    icalUrl,
    calendarName,
    events,
    cached: false,
    stale: false,
    ...meta,
  };
}

async function loadDiskCalendarCache(icalUrl) {
  try {
    const raw = await fs.readFile(DISK_CACHE_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (j?.key !== icalUrl || !Array.isArray(j.events)) return null;
    if (Date.now() - Number(j.at) > DISK_CACHE_MAX_MS) return null;
    return { at: Number(j.at), key: icalUrl, events: j.events };
  } catch {
    return null;
  }
}

async function saveDiskCalendarCache(icalUrl, events) {
  try {
    await fs.mkdir(path.dirname(DISK_CACHE_PATH), { recursive: true });
    await fs.writeFile(
      DISK_CACHE_PATH,
      JSON.stringify({ at: Date.now(), key: icalUrl, events }),
      'utf8',
    );
  } catch {
    /* ignore */
  }
}

async function refreshCalendarCache(icalUrl, tz) {
  const result = await fetchIcalEventsFromGoogle(icalUrl, tz);
  if (result.ok && Array.isArray(result.events)) {
    cache = { at: Date.now(), key: icalUrl, events: result.events };
    await saveDiskCalendarCache(icalUrl, result.events);
  }
  return result;
}

/** Single in-flight Google fetch shared by warmup and API handlers. */
function ensureCalendarCacheRefresh(icalUrl, tz) {
  if (!refreshPromise) {
    refreshPromise = refreshCalendarCache(icalUrl, tz).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/** Prefetch Google iCal on server start so the first dashboard load is not blocked ~10s. */
export function warmGoogleCalendarCache(env = process.env) {
  const icalUrl = resolveGoogleCalendarIcalUrl(env);
  if (!icalUrl) return;
  const tz = resolveCalendarTimeZone(env);
  const now = Date.now();
  if (cache && cache.key === icalUrl && now - cache.at < CACHE_MS) return;
  ensureCalendarCacheRefresh(icalUrl, tz);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function fetchUpcomingGoogleCalendarEvents(env = process.env) {
  const icalUrl = resolveGoogleCalendarIcalUrl(env);
  if (!icalUrl) {
    return {
      ok: false,
      error: 'no_ical_url',
      hint: 'Set GOOGLE_CALENDAR_ICAL_URL to your Google Calendar secret iCal link, or use a public calendar embed src.',
      events: [],
    };
  }

  const tz = resolveCalendarTimeZone(env);
  const key = icalUrl;
  const now = Date.now();

  /** @type {{ ok: boolean, events?: object[], calendarName?: string, error?: string, hint?: string, needsSecretIcal?: boolean, calendarSrc?: string, cached?: boolean, stale?: boolean }} */
  let primary;
  if (cache && cache.key === key) {
    const fresh = now - cache.at < CACHE_MS;
    if (fresh) {
      primary = calendarSuccessPayload(icalUrl, tz, cache.events, { cached: true });
    } else {
      ensureCalendarCacheRefresh(icalUrl, tz);
      primary = calendarSuccessPayload(icalUrl, tz, cache.events, { cached: true, stale: true });
    }
  } else {
    const disk = await loadDiskCalendarCache(icalUrl);
    if (disk) {
      cache = disk;
      ensureCalendarCacheRefresh(icalUrl, tz);
      primary = calendarSuccessPayload(icalUrl, tz, cache.events, { cached: true, stale: true });
    } else {
      const result = await ensureCalendarCacheRefresh(icalUrl, tz);
      if (cache && cache.key === key) {
        primary = calendarSuccessPayload(icalUrl, tz, cache.events, { cached: false });
      } else {
        primary = result;
      }
    }
  }

  if (!primary?.ok) return primary;

  /** @type {object[]} */
  let pinUpcoming = [];
  try {
    const pins = await fetchGcalIcsPinnedEvents(env);
    pinUpcoming = (Array.isArray(pins?.events) ? pins.events : [])
      .map(pinEventToUpcoming)
      .filter(Boolean)
      .filter((ev) => {
        const end = ev.endMs != null && Number.isFinite(ev.endMs) ? ev.endMs : ev.startMs + 60 * 60 * 1000;
        return end > now;
      });
  } catch {
    pinUpcoming = [];
  }

  try {
    const manual = await loadManualCalendarEvents(env);
    for (const ev of manual) {
      const up = manualEventToUpcoming(ev);
      if (!up) continue;
      const end = up.endMs != null && Number.isFinite(up.endMs) ? up.endMs : up.startMs + 60 * 60 * 1000;
      if (end > now) pinUpcoming.push(up);
    }
  } catch {
    /* ignore manual load errors */
  }

  const events = mergeUpcomingCalendarEvents(primary.events || [], pinUpcoming);
  return {
    ...primary,
    events,
    pinnedCalendars: pinUpcoming.length
      ? [...new Set(pinUpcoming.map((e) => e.calendarName).filter(Boolean))]
      : [],
  };
}
