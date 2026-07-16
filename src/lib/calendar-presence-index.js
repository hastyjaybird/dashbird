/**
 * Rolling ~4-day calendar presence index: geocoded venues + time windows.
 * Used by Telegram contact ingest for howWeMet autofill / Yes-No prompts.
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineMiles } from './dashboard-geo.js';
import { geocodeAddress } from './geocode-address.js';
import { eventOccupancyKey } from './events-finder-calendar-occupancy.js';
import { listEventsFinderEvents } from './events-finder-store.js';
import { fetchUpcomingGoogleCalendarEvents } from './google-calendar-ical.js';
import {
  formatHowWeMetText,
  isCalendarEventHappeningNow,
  isOnlineLocation,
  matchRadiusMiles,
} from './network-how-we-met-suggest.js';
import { loadRainAlertAddress } from './rain-alert-address-store.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Rolling window ahead of now. */
const WINDOW_AHEAD_MS = 4 * 24 * 60 * 60 * 1000;
/** Keep recently-started events (same grace as how-we-met suggest). */
const PRE_START_GRACE_MS = 20 * 60 * 1000;
/** Exclude venues within this distance of home. */
const HOME_EXCLUDE_MI = 100 / 1760; // 100 yards
const REMINDER_TITLE_RE = /^(reminder|note|todo|task)\b/i;
/** Partiful / invite placeholders that are not real venues. */
const PLACEHOLDER_LOCATION_RE =
  /\b(location available|once rsvp|see (description|invite)|tbd|to be (announced|determined)|address shared)\b/i;
const DEFAULT_REFRESH_MS = 20 * 60 * 1000;
const PROMPT_TTL_MS = 24 * 60 * 60 * 1000;

/** @type {ReturnType<typeof setInterval> | null} */
let refreshTimer = null;
/** @type {Promise<unknown> | null} */
let rebuildPromise = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function calendarPresenceIndexPath(env = process.env) {
  const override = String(env.CALENDAR_PRESENCE_INDEX_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  }
  return path.join(PKG_ROOT, 'data', 'calendar-presence-index.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function howWeMetPromptsPath(env = process.env) {
  const override = String(env.TELEGRAM_HOW_WE_MET_PROMPTS_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  }
  return path.join(PKG_ROOT, 'data', 'telegram-how-we-met-prompts.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ updatedAt: string | null, timeZone: string, events: object[] }}
 */
export function loadCalendarPresenceIndex(env = process.env) {
  const filePath = calendarPresenceIndexPath(env);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw);
    const events = Array.isArray(json?.events) ? json.events : [];
    return {
      updatedAt: typeof json?.updatedAt === 'string' ? json.updatedAt : null,
      timeZone:
        String(json?.timeZone || env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
        || 'America/Los_Angeles',
      events,
    };
  } catch {
    return {
      updatedAt: null,
      timeZone:
        String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim() || 'America/Los_Angeles',
      events: [],
    };
  }
}

/**
 * @param {object[]} finderEvents
 * @param {string} timeZone
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
 * @param {object} ev
 * @param {number} nowMs
 * @param {number} windowEndMs
 */
function inRollingWindow(ev, nowMs, windowEndMs) {
  const start = Number(ev?.startMs);
  if (!Number.isFinite(start)) return false;
  const endRaw = Number(ev?.endMs);
  const end = Number.isFinite(endRaw)
    ? endRaw
    : ev?.allDay
      ? start + 24 * 60 * 60 * 1000
      : start + 3 * 60 * 60 * 1000;
  // Overlaps [now - grace, now + 4d]
  const windowStart = nowMs - PRE_START_GRACE_MS;
  return end > windowStart && start < windowEndMs + PRE_START_GRACE_MS;
}

/**
 * Rebuild data/calendar-presence-index.json from Google Calendar.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function rebuildCalendarPresenceIndex(env = process.env) {
  if (rebuildPromise) return rebuildPromise;
  rebuildPromise = (async () => {
    const nowMs = Date.now();
    const windowEndMs = nowMs + WINDOW_AHEAD_MS;
    const cal = await fetchUpcomingGoogleCalendarEvents(env);
    if (!cal?.ok) {
      return {
        ok: false,
        error: cal?.error || 'calendar_unavailable',
        count: 0,
      };
    }

    const timeZone =
      String(cal.timeZone || env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
      || 'America/Los_Angeles';

    let home = null;
    try {
      const addr = await loadRainAlertAddress();
      home = await geocodeAddress(addr);
    } catch {
      home = null;
    }

    /** @type {Map<string, object>} */
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

    const candidates = (Array.isArray(cal.events) ? cal.events : []).filter((ev) =>
      inRollingWindow(ev, nowMs, windowEndMs),
    );

    /** @type {object[]} */
    const indexed = [];
    for (const ev of candidates) {
      const title = String(ev?.title || '').trim();
      if (!title || REMINDER_TITLE_RE.test(title)) continue;

      const location = String(ev?.location || '').trim();
      if (!location || isOnlineLocation(location) || PLACEHOLDER_LOCATION_RE.test(location)) {
        continue;
      }

      const key = eventOccupancyKey(ev, timeZone);
      const finder = key ? finderByKey.get(key) || null : null;
      let lat = Number(finder?.lat);
      let lon = Number(finder?.lon);
      let venue = location;
      let city = typeof finder?.city === 'string' ? finder.city : '';
      let url = typeof finder?.url === 'string' ? finder.url : '';

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const geo = await geocodeAddress(location);
        if (!geo) continue;
        lat = geo.lat;
        lon = geo.lon;
      }

      if (home && Number.isFinite(home.lat) && Number.isFinite(home.lon)) {
        const dHome = haversineMiles(lat, lon, home.lat, home.lon);
        if (dHome <= HOME_EXCLUDE_MI) continue;
      }

      const startMs = Number(ev.startMs);
      const endRaw = Number(ev.endMs);
      const endMs = Number.isFinite(endRaw)
        ? endRaw
        : ev.allDay
          ? startMs + 24 * 60 * 60 * 1000
          : startMs + 3 * 60 * 60 * 1000;

      indexed.push({
        id: String(ev.id || `${title}|${startMs}`),
        title,
        startMs,
        endMs,
        allDay: Boolean(ev.allDay),
        lat,
        lon,
        location: venue,
        city: city || undefined,
        url: url || undefined,
        calendarName: String(ev.calendarName || cal.calendarName || '').trim() || undefined,
      });
    }

    indexed.sort((a, b) => a.startMs - b.startMs);

    const payload = {
      updatedAt: new Date().toISOString(),
      timeZone,
      events: indexed,
    };

    const filePath = calendarPresenceIndexPath(env);
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    console.log(`[calendar-presence] indexed ${indexed.length} events → ${filePath}`);
    return { ok: true, count: indexed.length, updatedAt: payload.updatedAt, timeZone };
  })().finally(() => {
    rebuildPromise = null;
  });
  return rebuildPromise;
}

/**
 * Prefer timed events over all-day; then earliest start.
 * @param {object[]} events
 */
function rankHappening(events) {
  return [...events].sort((a, b) => {
    if (Boolean(a.allDay) !== Boolean(b.allDay)) return a.allDay ? 1 : -1;
    return Number(a.startMs) - Number(b.startMs);
  });
}

/**
 * Best index event happening at atMs (time only — for Yes/No prompts).
 * @param {number} [atMs]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ event: object, howWeMet: string, timeZone: string } | null}
 */
export function eventHappeningAt(atMs = Date.now(), env = process.env) {
  const index = loadCalendarPresenceIndex(env);
  const nowMs = Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now();
  const happening = index.events.filter((ev) => isCalendarEventHappeningNow(ev, nowMs));
  if (!happening.length) return null;
  const best = rankHappening(happening)[0];
  if (!best) return null;
  const howWeMet = formatHowWeMetText(best, {
    timeZone: index.timeZone,
    venue: best.location,
    city: best.city,
    url: best.url,
  });
  return { event: best, howWeMet, timeZone: index.timeZone };
}

/**
 * Match GPS + time against the presence index.
 * @param {{ lat: number, lon: number, accuracyMeters?: number, atMs?: number }} place
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ event: object, howWeMet: string, distanceMiles: number, timeZone: string } | null}
 */
export function matchByGps(place, env = process.env) {
  const lat = Number(place?.lat);
  const lon = Number(place?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return null;

  const atMs = Number.isFinite(Number(place?.atMs)) ? Number(place.atMs) : Date.now();
  const radiusMi = matchRadiusMiles(place?.accuracyMeters);
  const index = loadCalendarPresenceIndex(env);
  const happening = index.events.filter((ev) => isCalendarEventHappeningNow(ev, atMs));
  if (!happening.length) return null;

  /** @type {{ event: object, howWeMet: string, distanceMiles: number, timeZone: string } | null} */
  let best = null;
  for (const ev of rankHappening(happening)) {
    const elat = Number(ev.lat);
    const elon = Number(ev.lon);
    if (!Number.isFinite(elat) || !Number.isFinite(elon)) continue;
    const d = haversineMiles(lat, lon, elat, elon);
    if (d > radiusMi) continue;
    const howWeMet = formatHowWeMetText(ev, {
      timeZone: index.timeZone,
      venue: ev.location,
      city: ev.city,
      url: ev.url,
      distanceMiles: d,
    });
    const candidate = {
      event: ev,
      howWeMet,
      distanceMiles: d,
      timeZone: index.timeZone,
    };
    if (!best || candidate.distanceMiles < best.distanceMiles) best = candidate;
    if (!ev.allDay) break;
  }
  return best;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadPromptsFile(env = process.env) {
  const filePath = howWeMetPromptsPath(env);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : { prompts: {} };
  } catch {
    return { prompts: {} };
  }
}

/**
 * @param {{ prompts: Record<string, object> }} data
 * @param {NodeJS.ProcessEnv} [env]
 */
function savePromptsFile(data, env = process.env) {
  const filePath = howWeMetPromptsPath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * @param {string} promptId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function getHowWeMetPrompt(promptId, env = process.env) {
  const id = String(promptId || '').trim();
  if (!id) return null;
  const data = loadPromptsFile(env);
  const prompt = data.prompts?.[id];
  if (!prompt) return null;
  if (Number(prompt.expiresAt) && Number(prompt.expiresAt) < Date.now()) {
    delete data.prompts[id];
    savePromptsFile(data, env);
    return null;
  }
  return prompt;
}

/**
 * @param {{
 *   chatId: number | string,
 *   contactIds: Array<number | string>,
 *   howWeMet: string,
 *   eventTitle: string,
 *   eventId?: string,
 * }} input
 * @param {NodeJS.ProcessEnv} [env]
 */
export function createHowWeMetPrompt(input, env = process.env) {
  const promptId = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const data = loadPromptsFile(env);
  if (!data.prompts || typeof data.prompts !== 'object') data.prompts = {};

  // Drop expired
  const now = Date.now();
  for (const [k, v] of Object.entries(data.prompts)) {
    if (Number(v?.expiresAt) && Number(v.expiresAt) < now) delete data.prompts[k];
  }

  data.prompts[promptId] = {
    promptId,
    chatId: input.chatId,
    contactIds: (input.contactIds || []).map((id) => String(id)),
    howWeMet: String(input.howWeMet || '').slice(0, 4000),
    eventTitle: String(input.eventTitle || '').slice(0, 200),
    eventId: input.eventId ? String(input.eventId) : undefined,
    createdAt: now,
    expiresAt: now + PROMPT_TTL_MS,
  };
  savePromptsFile(data, env);
  return data.prompts[promptId];
}

/**
 * @param {string} promptId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function consumeHowWeMetPrompt(promptId, env = process.env) {
  const id = String(promptId || '').trim();
  if (!id) return null;
  const data = loadPromptsFile(env);
  const prompt = data.prompts?.[id] || null;
  if (prompt) {
    delete data.prompts[id];
    savePromptsFile(data, env);
  }
  if (prompt && Number(prompt.expiresAt) && Number(prompt.expiresAt) < Date.now()) {
    return null;
  }
  return prompt;
}

/**
 * Start periodic rebuild (boot + interval).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startCalendarPresenceIndexScheduler(env = process.env) {
  if (refreshTimer) return;
  const msRaw = Number(env.CALENDAR_PRESENCE_REFRESH_MS);
  const ms = Number.isFinite(msRaw) && msRaw >= 60_000 ? msRaw : DEFAULT_REFRESH_MS;

  const tick = () => {
    void rebuildCalendarPresenceIndex(env).catch((e) => {
      console.warn('[calendar-presence] rebuild failed', e?.message || e);
    });
  };
  tick();
  refreshTimer = setInterval(tick, ms);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  console.log(`[calendar-presence] scheduler every ${Math.round(ms / 60000)}m`);
}
