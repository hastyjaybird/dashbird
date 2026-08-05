/**
 * Job Watch state — Anthropic Greenhouse scan snapshot + candidate reviews.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TARGETS_PATH = path.join(PKG_ROOT, 'src/data/job-watch-targets.json');

/** @typedef {{
 *   id: string,
 *   greenhouseId: number | null,
 *   title: string,
 *   location: string,
 *   url: string,
 *   firstSeenAt: string,
 *   lastSeenAt: string,
 *   open: boolean,
 *   assessment: object | null,
 *   reviewedAt: string | null,
 *   dismissedAt: string | null,
 * }} JobWatchCandidate */

/** @typedef {{
 *   version: number,
 *   lastScanAt: string | null,
 *   lastScanError: string | null,
 *   knownJobIds: string[],
 *   openJobs: Array<object>,
 *   targetMatches: Record<string, object | null>,
 *   candidates: JobWatchCandidate[],
 * }} JobWatchState */

const DEFAULT_STATE = /** @type {JobWatchState} */ ({
  version: 1,
  lastScanAt: null,
  lastScanError: null,
  knownJobIds: [],
  openJobs: [],
  targetMatches: {},
  candidates: [],
});

let targetsCache = null;

export function jobWatchStatePath(env = process.env) {
  const override = String(env.JOB_WATCH_STATE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/job-watch.json');
}

/**
 * @returns {Promise<object>}
 */
export async function loadJobWatchTargets() {
  if (targetsCache) return targetsCache;
  const raw = await fs.readFile(TARGETS_PATH, 'utf8');
  targetsCache = JSON.parse(raw);
  return targetsCache;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<JobWatchState>}
 */
export async function loadJobWatchState(env = process.env) {
  try {
    const raw = await fs.readFile(jobWatchStatePath(env), 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch {
    return { ...DEFAULT_STATE, knownJobIds: [], openJobs: [], targetMatches: {}, candidates: [] };
  }
}

/**
 * @param {unknown} raw
 * @returns {JobWatchState}
 */
export function normalizeState(raw) {
  const o = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    version: 1,
    lastScanAt: o.lastScanAt ? String(o.lastScanAt) : null,
    lastScanError: o.lastScanError ? String(o.lastScanError) : null,
    knownJobIds: Array.isArray(o.knownJobIds) ? o.knownJobIds.map(String) : [],
    openJobs: Array.isArray(o.openJobs) ? o.openJobs : [],
    targetMatches:
      o.targetMatches && typeof o.targetMatches === 'object' && !Array.isArray(o.targetMatches)
        ? /** @type {Record<string, object | null>} */ (o.targetMatches)
        : {},
    candidates: Array.isArray(o.candidates) ? /** @type {JobWatchCandidate[]} */ (o.candidates) : [],
  };
}

/**
 * @param {JobWatchState} state
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveJobWatchState(state, env = process.env) {
  const target = jobWatchStatePath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(staging, target);
}
