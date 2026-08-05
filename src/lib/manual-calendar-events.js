/**
 * Hand-pinned calendar events (annual festivals, etc.) stored in
 * data/manual-calendar-events.json (fallback: src/data/) — merged into
 * Next-on-calendar + Events catalog.
 *
 * Entries may be one-shot ({ start, end? }) or recurring:
 *   recurrence: {
 *     kind: 'nth_weekday',      // e.g. every 2nd Friday
 *     nth: 2,                   // 1-5
 *     weekday: 'friday',        // full or 3-letter weekday name
 *     time: '19:30',            // 24h local clock
 *     durationMinutes: 240,     // optional, default 120
 *     monthsAhead: 12,          // optional rolling horizon, default 12 (max 24)
 *     timeZone: 'America/Los_Angeles', // optional
 *   }
 * Recurring entries expand to dated occurrences (id suffix :YYYY-MM-DD) on every
 * load, so both the Next-on-calendar merge and the boot-time catalog sync stay
 * current without editing the file each month.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertEventsFinderEvents } from './events-finder-store.js';
import {
  nthWeekdayOfMonth,
  weekdayIndexFromName,
  ymdAtLocalTimeIso,
} from './events-finder-recurring-dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function manualCalendarEventsPaths(env = process.env) {
  const override = String(env.MANUAL_CALENDAR_EVENTS_PATH || '').trim();
  if (override) {
    return [path.isAbsolute(override) ? override : path.join(root, override)];
  }
  return [
    path.join(root, 'data', 'manual-calendar-events.json'),
    path.join(root, 'src', 'data', 'manual-calendar-events.json'),
  ];
}

/**
 * @param {unknown} raw
 * @returns {{ kind: 'nth_weekday', nth: number, weekday: number, hours: number, minutes: number, durationMinutes: number, monthsAhead: number, timeZone: string } | null}
 */
function normalizeRecurrence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rec = /** @type {Record<string, unknown>} */ (raw);
  if (String(rec.kind || '').trim() !== 'nth_weekday') return null;
  const nth = Number(rec.nth);
  const weekday = weekdayIndexFromName(rec.weekday);
  if (!Number.isFinite(nth) || nth < 1 || nth > 5 || weekday == null) return null;
  const time = String(rec.time || '12:00').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!time) return null;
  const hours = Number(time[1]);
  const minutes = Number(time[2]);
  if (hours > 23 || minutes > 59) return null;
  const duration = Number(rec.durationMinutes);
  const months = Number(rec.monthsAhead);
  return {
    kind: 'nth_weekday',
    nth: Math.trunc(nth),
    weekday,
    hours,
    minutes,
    durationMinutes: Number.isFinite(duration) && duration >= 15 ? Math.min(duration, 24 * 60) : 120,
    monthsAhead: Number.isFinite(months) && months >= 1 ? Math.min(Math.trunc(months), 24) : 12,
    timeZone: String(rec.timeZone || 'America/Los_Angeles').trim() || 'America/Los_Angeles',
  };
}

/**
 * Current year/month/day in the event's time zone (so today's ride isn't dropped
 * before it ends, and past months don't expand).
 * @param {string} timeZone
 * @param {number} [nowMs]
 */
function localYmdInZone(timeZone, nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  return {
    year: Number(parts.find((p) => p.type === 'year')?.value),
    month: Number(parts.find((p) => p.type === 'month')?.value),
    day: Number(parts.find((p) => p.type === 'day')?.value),
  };
}

/**
 * Expand a recurring entry into dated occurrences over the rolling horizon.
 * @param {Record<string, unknown>} raw
 * @param {ReturnType<typeof normalizeRecurrence>} rec
 * @param {number} [nowMs]
 * @returns {object[]}
 */
function expandRecurringManualEvent(raw, rec, nowMs = Date.now()) {
  const baseId = String(raw.id || `manual:${String(raw.title || 'event').trim()}`).trim().slice(0, 140);
  const today = localYmdInZone(rec.timeZone, nowMs);
  if (!Number.isFinite(today.year) || !Number.isFinite(today.month)) return [];
  /** @type {object[]} */
  const out = [];
  for (let i = 0; i < rec.monthsAhead; i += 1) {
    const monthIndex = today.month - 1 + i;
    const year = today.year + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const ymd = nthWeekdayOfMonth(year, month, rec.weekday, rec.nth);
    if (!ymd) continue;
    const startIso = ymdAtLocalTimeIso(ymd, rec.hours, rec.minutes, rec.timeZone);
    const startMs = startIso ? Date.parse(startIso) : Number.NaN;
    if (!Number.isFinite(startMs)) continue;
    const endMs = startMs + rec.durationMinutes * 60 * 1000;
    if (endMs <= nowMs) continue;
    const occurrence = normalizeManualEvent({
      ...raw,
      recurrence: undefined,
      id: `${baseId}:${ymd}`,
      start: startIso,
      end: new Date(endMs).toISOString(),
      allDay: false,
    });
    if (occurrence) out.push(occurrence);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeManualEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ev = /** @type {Record<string, unknown>} */ (raw);
  const title = String(ev.title || '').trim();
  const start = String(ev.start || '').trim();
  if (!title || !start || !Number.isFinite(Date.parse(start))) return null;
  const end = ev.end != null && String(ev.end).trim() ? String(ev.end).trim() : null;
  const id = String(ev.id || `manual:${title}`).trim().slice(0, 160);
  const venue = String(ev.venue || '').trim() || null;
  const location = String(ev.location || venue || '').trim() || null;
  const city = String(ev.city || '').trim() || null;
  const lat = Number(ev.lat);
  const lon = Number(ev.lon);
  return {
    id,
    title,
    start,
    end: end && Number.isFinite(Date.parse(end)) ? end : null,
    allDay: ev.allDay === true,
    venue,
    location,
    city,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    url: String(ev.url || '').trim(),
    description: String(ev.description || '').trim().slice(0, 2000) || null,
    calendarName: String(ev.calendarName || 'Manual').trim() || 'Manual',
    source: String(ev.source || 'manual').trim() || 'manual',
    online: ev.online === true,
    imageUrl: String(ev.imageUrl || '').trim() || null,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<object[]>}
 */
export async function loadManualCalendarEvents(env = process.env) {
  for (const fp of manualCalendarEventsPaths(env)) {
    try {
      const raw = await readFile(fp, 'utf8');
      const j = JSON.parse(raw);
      const list = Array.isArray(j) ? j : Array.isArray(j?.events) ? j.events : [];
      /** @type {object[]} */
      const out = [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = normalizeRecurrence(/** @type {Record<string, unknown>} */ (entry).recurrence);
        if (rec) {
          out.push(...expandRecurringManualEvent(/** @type {Record<string, unknown>} */ (entry), rec));
          continue;
        }
        const ev = normalizeManualEvent(entry);
        if (ev) out.push(ev);
      }
      return out;
    } catch {
      /* try next path */
    }
  }
  return [];
}

/**
 * Shape for /api/calendar/upcoming merge.
 * @param {object} ev
 */
export function manualEventToUpcoming(ev) {
  const startMs = Date.parse(String(ev.start || ''));
  if (!Number.isFinite(startMs)) return null;
  const endMs = ev.end != null ? Date.parse(String(ev.end)) : null;
  return {
    id: String(ev.id || `manual:${startMs}`),
    title: String(ev.title || 'Event'),
    location: String(ev.location || ev.venue || '').trim(),
    startMs,
    endMs: Number.isFinite(endMs) ? endMs : null,
    allDay: ev.allDay === true,
    calendarName: String(ev.calendarName || 'Manual'),
    url: String(ev.url || '').trim() || undefined,
  };
}

/**
 * Upsert manual events into the Events Finder catalog (idempotent).
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function syncManualCalendarEventsToCatalog(env = process.env) {
  const events = await loadManualCalendarEvents(env);
  if (!events.length) return { upserted: 0, count: 0 };
  try {
    const result = upsertEventsFinderEvents(events, env);
    return { upserted: result.upserted || 0, count: events.length };
  } catch (e) {
    console.warn('[manual-calendar] catalog upsert failed:', e?.message || e);
    return { upserted: 0, count: events.length, error: String(e?.message || e) };
  }
}
