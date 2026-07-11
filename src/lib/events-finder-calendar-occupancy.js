/**
 * Hide Events-finder rows that already appear on the dashboard Google Calendar.
 * Match is title+local-day (same key as catalog dedupe) — not Skip; just omit from the feed.
 */
import { eventLocalDayAndMinutes } from './events-finder-geo.js';
import { normalizeEventTitleKey } from './events-finder-store.js';
import { fetchUpcomingGoogleCalendarEvents } from './google-calendar-ical.js';

/**
 * @param {unknown} title
 * @param {unknown} start  ISO string, Date, or epoch ms
 * @param {string} [timeZone]
 * @returns {string | null}
 */
export function eventTitleDayKey(title, start, timeZone = 'America/Los_Angeles') {
  const titleKey = normalizeEventTitleKey(title);
  if (!titleKey) return null;

  let startDate = null;
  if (start instanceof Date) {
    startDate = start;
  } else if (typeof start === 'number' && Number.isFinite(start)) {
    const ms = start > 1e12 ? start : start * 1000;
    startDate = new Date(ms);
  } else if (start != null && String(start).trim()) {
    const ms = Date.parse(String(start));
    if (Number.isFinite(ms)) startDate = new Date(ms);
  }
  if (!startDate || Number.isNaN(startDate.getTime())) return null;

  const local = eventLocalDayAndMinutes(startDate, timeZone);
  const day = local?.day;
  if (!day) return null;
  return `${titleKey}|${day}`;
}

/**
 * @param {object} event  finder or calendar event ({ title, start } or { title, startMs })
 * @param {string} [timeZone]
 * @returns {string | null}
 */
export function eventOccupancyKey(event, timeZone = 'America/Los_Angeles') {
  if (!event || typeof event !== 'object') return null;
  const title = /** @type {{ title?: unknown }} */ (event).title;
  const start =
    /** @type {{ start?: unknown, startMs?: unknown }} */ (event).start
    ?? /** @type {{ startMs?: unknown }} */ (event).startMs;
  return eventTitleDayKey(title, start, timeZone);
}

/**
 * Load upcoming Google Calendar events and return a Set of title|YYYY-MM-DD keys.
 * Soft-fails quickly so the Events feed never blocks on a slow iCal fetch.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [timeZone]
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ keys: Set<string>, count: number, ok: boolean }>}
 */
export async function loadGoogleCalendarOccupancyKeys(env = process.env, timeZone, opts = {}) {
  const tz =
    String(timeZone || env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles';
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 2500, 500), 15_000);
  try {
    const cal = await Promise.race([
      fetchUpcomingGoogleCalendarEvents(env),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('calendar_occupancy_timeout')), timeoutMs);
      }),
    ]);
    const keys = new Set();
    for (const ev of Array.isArray(cal?.events) ? cal.events : []) {
      const key = eventOccupancyKey(ev, tz);
      if (key) keys.add(key);
    }
    return { keys, count: keys.size, ok: cal?.ok === true };
  } catch {
    return { keys: new Set(), count: 0, ok: false };
  }
}

/**
 * @param {object} event
 * @param {Set<string>} occupancyKeys
 * @param {string} [timeZone]
 * @returns {boolean}
 */
export function eventMatchesGoogleCalendar(event, occupancyKeys, timeZone) {
  if (!occupancyKeys || occupancyKeys.size === 0) return false;
  const key = eventOccupancyKey(event, timeZone);
  return Boolean(key && occupancyKeys.has(key));
}
