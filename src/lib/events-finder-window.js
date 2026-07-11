/**
 * First-pass ingest window: keep events from slightly in the past through N days ahead.
 */

/** Default: drop starts older than 2 days; keep through 30 days from now. */
export const EVENTS_INGEST_PAST_DAYS = 2;
export const EVENTS_INGEST_FUTURE_DAYS = 30;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ pastDays: number, futureDays: number }}
 */
export function eventsIngestWindowDays(env = process.env) {
  const pastRaw = Number(env.EVENTS_FINDER_INGEST_PAST_DAYS);
  const futureRaw = Number(env.EVENTS_FINDER_INGEST_FUTURE_DAYS);
  return {
    pastDays: Number.isFinite(pastRaw) && pastRaw >= 0 ? pastRaw : EVENTS_INGEST_PAST_DAYS,
    futureDays:
      Number.isFinite(futureRaw) && futureRaw > 0 ? futureRaw : EVENTS_INGEST_FUTURE_DAYS,
  };
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
