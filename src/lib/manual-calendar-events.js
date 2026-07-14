/**
 * Hand-pinned calendar events (annual festivals, etc.) stored in
 * data/manual-calendar-events.json (fallback: src/data/) — merged into
 * Next-on-calendar + Events catalog.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertEventsFinderEvents } from './events-finder-store.js';

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
      return list.map(normalizeManualEvent).filter(Boolean);
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
