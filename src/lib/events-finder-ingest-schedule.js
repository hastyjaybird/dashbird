/**
 * Shared cadence for non-Facebook Events Finder ingest.
 * Default: every 2 hours, paused 02:00–07:00 local (Facebook daily 4am is separate).
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function eventsFinderScheduleTz(env = process.env) {
  return (
    String(env.EVENTS_FINDER_INGEST_TZ || env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles'
  );
}

/**
 * @param {Date} [now]
 * @param {string} [timeZone]
 * @returns {{ hour: number, minute: number, ymd: string }}
 */
function localParts(now = new Date(), timeZone = 'America/Los_Angeles') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  /** @type {Record<string, string>} */
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return {
    hour: Number(map.hour),
    minute: Number(map.minute),
    ymd: `${map.year}-${map.month}-${map.day}`,
  };
}

/**
 * Min gap between non-Facebook live ingests (default 2h).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function eventsFinderIngestCooldownMs(env = process.env) {
  const n = Number(env.EVENTS_FINDER_INGEST_COOLDOWN_MS);
  // Floor 10 minutes so misconfigured tiny values cannot hammer sources.
  if (Number.isFinite(n) && n >= 10 * 60 * 1000) return n;
  return 2 * 60 * 60 * 1000;
}

/**
 * Quiet window [start, end) in local hours — default 2 ≤ hour < 7.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ startHour: number, endHour: number }}
 */
export function eventsFinderIngestQuietHours(env = process.env) {
  const startRaw = Number(env.EVENTS_FINDER_INGEST_QUIET_START_HOUR);
  const endRaw = Number(env.EVENTS_FINDER_INGEST_QUIET_END_HOUR);
  const startHour =
    Number.isFinite(startRaw) && startRaw >= 0 && startRaw <= 23 ? Math.round(startRaw) : 2;
  const endHour =
    Number.isFinite(endRaw) && endRaw >= 0 && endRaw <= 23 ? Math.round(endRaw) : 7;
  return { startHour, endHour };
}

/**
 * True during the quiet window (no Gmail / Meetup / Luma / … live scrape).
 * Facebook’s daily 4am Apify run is scheduled separately and is allowed inside this window.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isEventsFinderIngestQuietHours(env = process.env, now = new Date()) {
  const { startHour, endHour } = eventsFinderIngestQuietHours(env);
  if (startHour === endHour) return false;
  const hour = localParts(now, eventsFinderScheduleTz(env)).hour;
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  // Window wraps midnight (e.g. 22 → 6).
  return hour >= startHour || hour < endHour;
}
