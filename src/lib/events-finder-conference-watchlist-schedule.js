/**
 * Daily refresh for tracked Big Events. Once per day (default 04:00 local) re-run
 * research for every conference/festival on the watchlist so newly-announced
 * dates, ticket price changes, early-bird windows, and sale-status changes are
 * picked up automatically. Runs sequentially with small delays and respects the
 * research in-flight dedup inside researchConferenceQuery.
 */
import { loadEventsFinderCriteria } from './events-finder-criteria-store.js';
import { dataBackupLocalParts } from './data-backup-schedule.js';
import {
  researchConferenceQuery,
  normalizeConferenceWatchlist,
} from './events-finder-conference-watchlist.js';

const CHECK_MS = 60_000;
const STARTUP_DELAY_MS = 30_000;
const DELAY_BETWEEN_MS = 8_000;

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
/** @type {string | null} */
let lastRunYmd = null;
let inFlight = false;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function bigEventsDailyRefreshEnabled(env = process.env) {
  return String(env.BIG_EVENTS_DAILY_REFRESH ?? '1').trim() !== '0';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function refreshHour(env = process.env) {
  const n = Number(env.BIG_EVENTS_DAILY_REFRESH_HOUR);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.round(n) : 4;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function refreshTz(env = process.env) {
  return (
    String(env.BIG_EVENTS_DAILY_REFRESH_TZ || env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles'
  );
}

/**
 * Re-research every tracked Big Event sequentially.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ count: number, ok: number }>}
 */
export async function runBigEventsDailyRefresh(env = process.env) {
  const criteria = await loadEventsFinderCriteria();
  const names = normalizeConferenceWatchlist(criteria.conferenceWatchlist);
  let ok = 0;
  for (const name of names) {
    try {
      const r = await researchConferenceQuery(name, env);
      if (r?.ok) ok += 1;
    } catch (e) {
      console.warn('[big-events] daily refresh failed for', name, e?.message || e);
    }
    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_MS));
  }
  return { count: names.length, ok };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startBigEventsDailyRefreshScheduler(env = process.env) {
  if (!bigEventsDailyRefreshEnabled(env)) {
    console.log('[big-events] daily refresh disabled');
    return;
  }
  if (timer) return;

  const hour = refreshHour(env);
  const zone = refreshTz(env);
  console.log(`[big-events] daily refresh: ${String(hour).padStart(2, '0')}:00 ${zone}`);

  const tick = async () => {
    if (inFlight) return;
    const local = dataBackupLocalParts(new Date(), zone);
    if (local.hour !== hour) return;
    if (lastRunYmd === local.ymd) return;
    inFlight = true;
    lastRunYmd = local.ymd;
    console.log(`[big-events] daily refresh starting (${local.ymd})`);
    try {
      const r = await runBigEventsDailyRefresh(env);
      console.log(`[big-events] daily refresh done (${r.ok}/${r.count})`);
    } catch (e) {
      console.warn('[big-events] daily refresh failed', e?.message || e);
      lastRunYmd = null;
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, CHECK_MS);
  if (typeof timer.unref === 'function') timer.unref();

  setTimeout(() => {
    void tick();
  }, STARTUP_DELAY_MS);
}
