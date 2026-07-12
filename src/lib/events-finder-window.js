/**
 * First-pass ingest window: keep events from slightly in the past through
 * Scrape ahead (criteria.scrape.windowWeeks), falling back to env / defaults.
 */

/** Soft floor: drop starts older than this many days. */
export const EVENTS_INGEST_PAST_DAYS = 2;

/** Default Scrape ahead when criteria / env are unset (matches criteria-store). */
export const DEFAULT_WINDOW_WEEKS = 4;

/** @deprecated Prefer windowWeeks × 7 via eventsIngestWindowDays(env, { scrape }). */
export const EVENTS_INGEST_FUTURE_DAYS = DEFAULT_WINDOW_WEEKS * 7;

/**
 * @param {unknown} raw
 * @param {number} [fallback]
 * @returns {1 | 2 | 3 | 4 | 5}
 */
export function normalizeIngestWindowWeeks(raw, fallback = DEFAULT_WINDOW_WEEKS) {
  const n = Number(raw);
  const base = Number.isFinite(n) ? Math.trunc(n) : fallback;
  const clamped = Math.min(5, Math.max(1, base));
  return /** @type {1 | 2 | 3 | 4 | 5} */ (clamped);
}

/**
 * @param {number} weeks
 * @returns {number}
 */
export function futureDaysFromWindowWeeks(weeks) {
  return normalizeIngestWindowWeeks(weeks) * 7;
}

/**
 * Resolve ingest horizon from Scrape ahead (+ optional env overrides).
 *
 * Priority for futureDays:
 *   1. env EVENTS_FINDER_INGEST_FUTURE_DAYS (ops override)
 *   2. scrape.windowWeeks × 7 / opts.windowWeeks × 7
 *   3. default 4 weeks (28 days)
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ scrape?: { windowWeeks?: number } | null, windowWeeks?: number }} [opts]
 * @returns {{ pastDays: number, futureDays: number, windowWeeks: number }}
 */
export function eventsIngestWindowDays(env = process.env, opts = {}) {
  const pastRaw = Number(env?.EVENTS_FINDER_INGEST_PAST_DAYS);
  const futureRaw = Number(env?.EVENTS_FINDER_INGEST_FUTURE_DAYS);
  const weeksRaw =
    opts.windowWeeks !== undefined
      ? opts.windowWeeks
      : opts.scrape?.windowWeeks !== undefined
        ? opts.scrape.windowWeeks
        : DEFAULT_WINDOW_WEEKS;
  const windowWeeks = normalizeIngestWindowWeeks(weeksRaw);
  const fromWeeks = futureDaysFromWindowWeeks(windowWeeks);

  return {
    pastDays: Number.isFinite(pastRaw) && pastRaw >= 0 ? pastRaw : EVENTS_INGEST_PAST_DAYS,
    futureDays:
      Number.isFinite(futureRaw) && futureRaw > 0 ? futureRaw : fromWeeks,
    windowWeeks,
  };
}

/**
 * Local calendar days from today through the scrape-ahead horizon (`weeks * 7` days).
 * @param {number} weeks
 * @param {string} [timeZone]
 * @param {Date | number} [now]
 * @returns {string[]} YYYY-MM-DD
 */
export function rollingLocalDatesForWindowWeeks(
  weeks,
  timeZone = 'America/Los_Angeles',
  now = Date.now(),
) {
  const n = futureDaysFromWindowWeeks(weeks);
  const startMs = typeof now === 'number' ? now : now.getTime();
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(startMs + i * 24 * 60 * 60 * 1000);
    out.push(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d),
    );
  }
  return out;
}

/**
 * @param {string | null | undefined} startIso
 * @param {{
 *   now?: number,
 *   pastDays?: number,
 *   futureDays?: number,
 *   allowMissingStart?: boolean,
 * }} [opts]
 * @returns {boolean}
 */
export function eventStartInIngestWindow(startIso, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const pastDays = opts.pastDays ?? EVENTS_INGEST_PAST_DAYS;
  const futureDays = opts.futureDays ?? EVENTS_INGEST_FUTURE_DAYS;
  const allowMissing = opts.allowMissingStart === true;
  if (!startIso) return allowMissing;
  const ms = Date.parse(String(startIso));
  if (!Number.isFinite(ms)) return allowMissing;
  const pastMs = pastDays * 24 * 60 * 60 * 1000;
  const futureMs = futureDays * 24 * 60 * 60 * 1000;
  return ms >= now - pastMs && ms <= now + futureMs;
}

/**
 * Filter a list of events to the ingest window.
 * @param {Array<{ start?: string | null }>} events
 * @param {{ now?: number, pastDays?: number, futureDays?: number }} [opts]
 */
export function filterEventsToIngestWindow(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  return list.filter((ev) =>
    eventStartInIngestWindow(ev?.start, {
      ...opts,
      allowMissingStart: false,
    }),
  );
}
