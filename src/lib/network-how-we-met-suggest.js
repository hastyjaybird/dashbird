/**
 * Suggest contact.howWeMet when phone GPS confirms the user is at a
 * currently-happening Google Calendar event.
 */
import { haversineMiles } from './dashboard-geo.js';
import { geocodeAddress } from './geocode-address.js';
import { eventOccupancyKey } from './events-finder-calendar-occupancy.js';
import { listEventsFinderEvents } from './events-finder-store.js';
import { fetchUpcomingGoogleCalendarEvents } from './google-calendar-ical.js';

/** Base venue match radius (miles). Widened by GPS accuracy, capped below. */
const BASE_MATCH_MI = 0.45;
const MAX_MATCH_MI = 1.25;
/** Allow arriving a bit early. */
const PRE_START_GRACE_MS = 20 * 60 * 1000;
/** Ignore calendar "locations" that are clearly remote links. */
const ONLINE_LOCATION_RE =
  /\b(zoom\.us|meet\.google|teams\.microsoft|webex\.com|whereby\.com|https?:\/\/)/i;

/**
 * @param {number} [accuracyMeters]
 * @returns {number}
 */
export function matchRadiusMiles(accuracyMeters) {
  const accM = Number(accuracyMeters);
  const accMi = Number.isFinite(accM) && accM > 0 ? accM / 1609.344 : 0;
  return Math.min(MAX_MATCH_MI, Math.max(BASE_MATCH_MI, BASE_MATCH_MI + accMi));
}

/**
 * @param {string} [location]
 */
export function isOnlineLocation(location) {
  const s = String(location || '').trim();
  if (!s) return false;
  if (ONLINE_LOCATION_RE.test(s)) return true;
  return /^(zoom|google meet|teams|webex|online|virtual)\b/i.test(s);
}

/**
 * @param {object} ev  calendar upcoming event
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isCalendarEventHappeningNow(ev, nowMs = Date.now()) {
  if (!ev || typeof ev !== 'object') return false;
  const start = Number(ev.startMs);
  if (!Number.isFinite(start)) return false;
  const endRaw = Number(ev.endMs);
  const end = Number.isFinite(endRaw)
    ? endRaw
    : ev.allDay
      ? start + 24 * 60 * 60 * 1000
      : start + 3 * 60 * 60 * 1000;
  if (end <= nowMs) return false;
  if (ev.allDay) {
    // All-day: treat as "today" while wall-clock is still on that day window.
    return start <= nowMs + PRE_START_GRACE_MS;
  }
  return start - PRE_START_GRACE_MS <= nowMs && nowMs < end;
}

/**
 * @param {number} ms
 * @param {string} timeZone
 * @param {{ dateStyle?: string, timeStyle?: string, allDay?: boolean }} [opts]
 */
function formatInZone(ms, timeZone, opts = {}) {
  if (!Number.isFinite(ms)) return '';
  try {
    if (opts.allDay) {
      return new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date(ms));
    }
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString('en-US');
  }
}

/**
 * @param {number} startMs
 * @param {number | null | undefined} endMs
 * @param {string} timeZone
 * @param {boolean} [allDay]
 */
export function formatEventWhen(startMs, endMs, timeZone, allDay = false) {
  const tz = String(timeZone || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  if (allDay) {
    const day = formatInZone(startMs, tz, { allDay: true });
    return day ? `${day} (all day)` : '';
  }
  const start = formatInZone(startMs, tz);
  if (!start) return '';
  const endN = Number(endMs);
  if (!Number.isFinite(endN) || endN <= startMs) return start;
  try {
    const endTime = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(endN));
    return `${start} – ${endTime}`;
  } catch {
    return start;
  }
}

/**
 * Build the howWeMet textarea value from a confirmed calendar (+ optional finder) event.
 * @param {{
 *   title?: string,
 *   location?: string,
 *   startMs?: number,
 *   endMs?: number | null,
 *   allDay?: boolean,
 *   calendarName?: string,
 * }} cal
 * @param {{
 *   timeZone?: string,
 *   venue?: string,
 *   city?: string,
 *   url?: string,
 *   distanceMiles?: number,
 * }} [extra]
 */
export function formatHowWeMetText(cal, extra = {}) {
  const title = String(cal?.title || '').trim() || 'an event';
  const lines = [`Met at ${title}`];

  const venue =
    String(extra.venue || '').trim()
    || String(cal?.location || '').trim();
  const city = String(extra.city || '').trim();
  if (venue && city && !venue.toLowerCase().includes(city.toLowerCase())) {
    lines.push(`${venue}, ${city}`);
  } else if (venue) {
    lines.push(venue);
  } else if (city) {
    lines.push(city);
  }

  const when = formatEventWhen(
    Number(cal?.startMs),
    cal?.endMs,
    extra.timeZone || 'America/Los_Angeles',
    Boolean(cal?.allDay),
  );
  if (when) lines.push(when);

  const calName = String(cal?.calendarName || '').trim();
  if (calName) lines.push(`Calendar: ${calName}`);

  const url = String(extra.url || '').trim();
  if (url) lines.push(url);

  return lines.join('\n').slice(0, 4000);
}

/**
 * @param {object[]} finderEvents
 * @param {string} timeZone
 * @returns {Map<string, object>}
 */
function buildFinderByOccupancyKey(finderEvents, timeZone) {
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const ev of finderEvents) {
    const key = eventOccupancyKey(ev, timeZone);
    if (!key) continue;
    const prev = map.get(key);
    const hasCoords =
      Number.isFinite(Number(ev?.lat)) && Number.isFinite(Number(ev?.lon));
    const prevCoords =
      prev && Number.isFinite(Number(prev.lat)) && Number.isFinite(Number(prev.lon));
    if (!prev || (hasCoords && !prevCoords)) map.set(key, ev);
  }
  return map;
}

/**
 * @param {object} cal
 * @param {object | null} finder
 * @param {{ lat: number, lon: number }} place
 * @param {number} radiusMi
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ ok: true, lat: number, lon: number, source: string, distanceMiles: number, venue?: string, city?: string, url?: string } | { ok: false }>}
 */
async function resolveEventCoords(cal, finder, place, radiusMi, env) {
  const finderLat = Number(finder?.lat);
  const finderLon = Number(finder?.lon);
  if (Number.isFinite(finderLat) && Number.isFinite(finderLon)) {
    const d = haversineMiles(place.lat, place.lon, finderLat, finderLon);
    if (d <= radiusMi) {
      return {
        ok: true,
        lat: finderLat,
        lon: finderLon,
        source: 'events-finder',
        distanceMiles: d,
        venue: typeof finder.venue === 'string' ? finder.venue : undefined,
        city: typeof finder.city === 'string' ? finder.city : undefined,
        url: typeof finder.url === 'string' ? finder.url : undefined,
      };
    }
  }

  const location = String(cal?.location || '').trim();
  if (!location || isOnlineLocation(location)) {
    return { ok: false };
  }

  const geo = await geocodeAddress(location);
  if (!geo) return { ok: false };
  const d = haversineMiles(place.lat, place.lon, geo.lat, geo.lon);
  if (d > radiusMi) return { ok: false };
  return {
    ok: true,
    lat: geo.lat,
    lon: geo.lon,
    source: 'calendar-geocode',
    distanceMiles: d,
    venue: location,
  };
}

/**
 * @param {{
 *   lat: number,
 *   lon: number,
 *   accuracy?: number,
 *   nowMs?: number,
 * }} place
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{
 *   ok: boolean,
 *   matched: boolean,
 *   howWeMet?: string,
 *   event?: object,
 *   reason?: string,
 * }>}
 */
export async function suggestHowWeMetFromPresence(place, env = process.env) {
  const lat = Number(place?.lat);
  const lon = Number(place?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, matched: false, reason: 'lat_lon_required' };
  }
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) {
    return { ok: false, matched: false, reason: 'lat_lon_required' };
  }

  const nowMs = Number.isFinite(Number(place?.nowMs)) ? Number(place.nowMs) : Date.now();
  const radiusMi = matchRadiusMiles(place?.accuracy);

  const cal = await fetchUpcomingGoogleCalendarEvents(env);
  if (!cal?.ok) {
    return { ok: false, matched: false, reason: cal?.error || 'calendar_unavailable' };
  }

  const timeZone =
    String(cal.timeZone || env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles';

  const happening = (Array.isArray(cal.events) ? cal.events : []).filter((ev) =>
    isCalendarEventHappeningNow(ev, nowMs),
  );
  if (!happening.length) {
    return { ok: true, matched: false, reason: 'no_ongoing_calendar_event' };
  }

  // Prefer timed events over all-day when ranking.
  happening.sort((a, b) => {
    if (Boolean(a.allDay) !== Boolean(b.allDay)) return a.allDay ? 1 : -1;
    return Number(a.startMs) - Number(b.startMs);
  });

  let finderByKey = new Map();
  try {
    const finderEvents = listEventsFinderEvents({
      env,
      cutoffIso: new Date(nowMs - 36 * 60 * 60 * 1000).toISOString(),
      limit: 1500,
    });
    finderByKey = buildFinderByOccupancyKey(finderEvents, timeZone);
  } catch {
    finderByKey = new Map();
  }

  /** @type {{ howWeMet: string, event: object, distanceMiles: number } | null} */
  let best = null;

  for (const ev of happening) {
    const key = eventOccupancyKey(ev, timeZone);
    const finder = key ? finderByKey.get(key) || null : null;
    const loc = await resolveEventCoords(
      ev,
      finder,
      { lat, lon },
      radiusMi,
      env,
    );
    if (!loc.ok) continue;

    const howWeMet = formatHowWeMetText(ev, {
      timeZone,
      venue: loc.venue,
      city: loc.city,
      url: loc.url,
      distanceMiles: loc.distanceMiles,
    });

    const candidate = {
      howWeMet,
      distanceMiles: loc.distanceMiles,
      event: {
        id: ev.id,
        title: ev.title,
        location: ev.location,
        startMs: ev.startMs,
        endMs: ev.endMs,
        allDay: Boolean(ev.allDay),
        calendarName: ev.calendarName || '',
        matchSource: loc.source,
        distanceMiles: Math.round(loc.distanceMiles * 100) / 100,
        finderUrl: loc.url || null,
      },
    };

    if (!best || candidate.distanceMiles < best.distanceMiles) {
      best = candidate;
    }
    // Timed match is enough — don't keep scanning all-day noise.
    if (!ev.allDay) break;
  }

  if (!best) {
    return { ok: true, matched: false, reason: 'location_not_at_event' };
  }

  return {
    ok: true,
    matched: true,
    howWeMet: best.howWeMet,
    event: best.event,
  };
}
