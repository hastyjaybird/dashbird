/**
 * Scan Anthropic careers every 2 hours for Job Watch targets + new-fit candidates.
 */
import { runJobWatchScan } from './job-watch-scan.js';

export const JOB_WATCH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 25_000;

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
let tickInFlight = false;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function jobWatchEnabled(env = process.env) {
  return String(env.JOB_WATCH ?? '1').trim() !== '0';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function tick(env = process.env) {
  if (!jobWatchEnabled(env)) return;
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const result = await runJobWatchScan(env);
    if (result.ok) {
      console.log(`[job-watch] scanned ${result.jobCount ?? '?'} jobs`);
    } else {
      console.warn('[job-watch] scan failed:', result.error);
    }
  } catch (e) {
    console.warn('[job-watch]', e?.message || e);
  } finally {
    tickInFlight = false;
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startJobWatchScheduler(env = process.env) {
  if (!jobWatchEnabled(env)) {
    console.log('[job-watch] disabled (JOB_WATCH=0)');
    return;
  }
  if (timer) return;
  const kick = setTimeout(() => {
    void tick(env);
  }, STARTUP_DELAY_MS);
  if (typeof kick.unref === 'function') kick.unref();
  timer = setInterval(() => {
    void tick(env);
  }, JOB_WATCH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[job-watch] scheduler every 2h');
}
