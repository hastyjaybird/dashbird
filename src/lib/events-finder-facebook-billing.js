/**
 * Persist Apify Facebook scrape charges and sum the current billing month.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function facebookBillingLogPath(env = process.env) {
  const override = String(env.FACEBOOK_EVENTS_BILLING_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'facebook-billing-log.json');
}

/**
 * Calendar month key in local dashboard TZ (YYYY-MM).
 * @param {Date | string | number} [when]
 * @param {string} [timeZone]
 */
export function billingMonthKey(when = new Date(), timeZone = 'America/Los_Angeles') {
  const d = when instanceof Date ? when : new Date(when);
  if (!Number.isFinite(d.getTime())) return billingMonthKey(new Date(), timeZone);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    if (y && m) return `${y}-${m}`;
  } catch {
    /* fall through */
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ runs: Array<object> }>}
 */
async function readLog(env = process.env) {
  try {
    const raw = await readFile(facebookBillingLogPath(env), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { runs: [] };
    return { runs: Array.isArray(data.runs) ? data.runs : [] };
  } catch {
    return { runs: [] };
  }
}

/**
 * @param {{ runs: Array<object> }} log
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeLog(log, env = process.env) {
  const p = facebookBillingLogPath(env);
  await mkdir(path.dirname(p), { recursive: true });
  const trimmed = {
    runs: (log.runs || []).slice(-200),
  };
  await writeFile(p, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
}

/**
 * @param {{
 *   runAt?: string,
 *   chargeUsd?: number | null,
 *   runId?: string | null,
 *   eventsBilled?: number | null,
 *   eventsKept?: number | null,
 *   searchQueries?: string[],
 *   startUrls?: string[],
 *   estimated?: boolean,
 * }} entry
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function appendFacebookBillingRun(entry, env = process.env) {
  const timeZone =
    String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  const runAt = entry.runAt || new Date().toISOString();
  const charge =
    entry.chargeUsd == null || !Number.isFinite(Number(entry.chargeUsd))
      ? null
      : Math.round(Number(entry.chargeUsd) * 10000) / 10000;
  const log = await readLog(env);
  log.runs.push({
    runAt,
    month: billingMonthKey(runAt, timeZone),
    chargeUsd: charge,
    runId: entry.runId ? String(entry.runId) : null,
    eventsBilled: Number.isFinite(Number(entry.eventsBilled))
      ? Math.round(Number(entry.eventsBilled))
      : null,
    eventsKept: Number.isFinite(Number(entry.eventsKept))
      ? Math.round(Number(entry.eventsKept))
      : null,
    searchQueries: Array.isArray(entry.searchQueries) ? entry.searchQueries.slice(0, 20) : [],
    startUrls: Array.isArray(entry.startUrls) ? entry.startUrls.slice(0, 40) : [],
    estimated: entry.estimated === true,
  });
  await writeLog(log, env);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ month?: string }} [opts]
 */
export async function getFacebookBillingMonthSummary(env = process.env, opts = {}) {
  const timeZone =
    String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  const month = String(opts.month || billingMonthKey(new Date(), timeZone)).slice(0, 7);
  const log = await readLog(env);
  const runs = log.runs.filter((r) => String(r.month || '') === month);
  let totalUsd = 0;
  let known = 0;
  let estimated = 0;
  for (const r of runs) {
    if (r.chargeUsd == null || !Number.isFinite(Number(r.chargeUsd))) continue;
    totalUsd += Number(r.chargeUsd);
    known += 1;
    if (r.estimated) estimated += 1;
  }
  const freeCreditsUsd = Number(env.FACEBOOK_EVENTS_MONTHLY_CREDITS_USD);
  const credits =
    Number.isFinite(freeCreditsUsd) && freeCreditsUsd > 0 ? freeCreditsUsd : 5;
  return {
    month,
    timeZone,
    runCount: runs.length,
    chargedRunCount: known,
    estimatedRunCount: estimated,
    totalUsd: Math.round(totalUsd * 10000) / 10000,
    monthlyCreditsUsd: credits,
    remainingCreditsUsd: Math.max(0, Math.round((credits - totalUsd) * 10000) / 10000),
    runs: runs.slice(-30),
  };
}
