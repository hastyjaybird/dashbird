/**
 * NOAA SWPC Geospace Magnetosphere Movies — PNG frame loops per model run.
 * @see https://www.swpc.noaa.gov/products/geospace-magnetosphere-movies
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SWPC_PAGE = 'https://www.swpc.noaa.gov/products/geospace-magnetosphere-movies';
const SWPC_BASE = 'https://services.swpc.noaa.gov/images/animations/geospace';
const PARAMS = ['velocity', 'density', 'pressure'];
const PARAM_RANK = Object.fromEntries(PARAMS.map((p, i) => [p, i]));
const PIN_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 5 * 60 * 1000;

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;
/** @type {object | null} */
let cache = null;

function statePath(env = process.env) {
  const override = String(env.GEOSPACE_MAGNETOSPHERE_STATE_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/geospace-magnetosphere-state.json');
}

function magnetosphereDisabled(env = process.env) {
  return String(env.MAGNETOSPHERE || '').trim() === '0';
}

/**
 * @param {string} param
 * @param {string} html
 */
function parseFrameListing(param, html) {
  const re = new RegExp(
    `magnetosphere_cut_planes_${param}_(\\d{8}T\\d{4})_(\\d{8}T\\d{4})\\.png`,
    'g',
  );
  /** @type {Map<string, Array<{ frameTime: string, file: string }>>} */
  const byRun = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    const runId = m[1];
    const frameTime = m[2];
    const file = m[0];
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId).push({ frameTime, file });
  }
  for (const frames of byRun.values()) {
    frames.sort((a, b) => a.frameTime.localeCompare(b.frameTime));
  }
  return byRun;
}

/**
 * @param {string} param
 */
async function fetchRunMap(param) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const r = await fetch(`${SWPC_BASE}/${param}/`, {
      signal: ac.signal,
      headers: { Accept: 'text/html,*/*' },
    });
    if (!r.ok) return new Map();
    const html = await r.text();
    return parseFrameListing(param, html);
  } catch {
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<Array<{ runId: string, parameter: string, frames: Array<{ frameTime: string, file: string, url: string }> }>>}
 */
async function scanAllRuns() {
  /** @type {Array<{ runId: string, parameter: string, frames: Array<{ frameTime: string, file: string, url: string }> }>} */
  const out = [];
  for (const param of PARAMS) {
    const byRun = await fetchRunMap(param);
    for (const [runId, frames] of byRun) {
      out.push({
        runId,
        parameter: param,
        frames: frames.map((f) => ({
          ...f,
          url: `${SWPC_BASE}/${param}/${f.file}`,
        })),
      });
    }
  }
  return out;
}

/**
 * @param {Array<{ runId: string, parameter: string, frames: unknown[] }>} runs
 */
function pickNewestRun(runs) {
  if (!runs.length) return null;
  return [...runs].sort((a, b) => {
    const byRun = b.runId.localeCompare(a.runId);
    if (byRun !== 0) return byRun;
    return (PARAM_RANK[a.parameter] ?? 9) - (PARAM_RANK[b.parameter] ?? 9);
  })[0];
}

async function loadState() {
  try {
    const raw = await fs.readFile(statePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {object} state
 */
async function saveState(state) {
  const live = statePath();
  await fs.mkdir(path.dirname(live), { recursive: true });
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, live);
}

/**
 * @returns {Promise<object | null>}
 */
export async function refreshGeospaceMagnetosphere() {
  if (magnetosphereDisabled()) {
    cache = { ok: true, disabled: true };
    return cache;
  }

  const runs = await scanAllRuns();
  const newest = pickNewestRun(runs);
  if (!newest?.frames?.length) {
    cache = {
      ok: false,
      error: 'no_frames',
      sourceUrl: SWPC_PAGE,
      scannedAt: new Date().toISOString(),
    };
    return cache;
  }

  const prev = await loadState();
  const isNewRun = !prev?.activeRunId || newest.runId !== prev.activeRunId;
  const activeRunId = isNewRun ? newest.runId : String(prev.activeRunId);
  const activeParam = isNewRun ? newest.parameter : String(prev.parameter || newest.parameter);
  const pinnedAt = isNewRun || !prev?.pinnedAt ? new Date().toISOString() : String(prev.pinnedAt);

  const active =
    runs.find((r) => r.runId === activeRunId && r.parameter === activeParam) ||
    runs.find((r) => r.runId === activeRunId) ||
    newest;

  const pinnedMs = Date.parse(pinnedAt);
  const pinEndsAt = new Date(pinnedMs + PIN_MS).toISOString();

  const state = {
    activeRunId: active.runId,
    parameter: active.parameter,
    pinnedAt,
    pinEndsAt,
    frameCount: active.frames.length,
    lastFrameTime: active.frames.at(-1)?.frameTime ?? null,
    updatedAt: new Date().toISOString(),
  };
  await saveState(state);

  cache = {
    ok: true,
    disabled: false,
    sourceUrl: SWPC_PAGE,
    parameter: active.parameter,
    parameterLabel: active.parameter.charAt(0).toUpperCase() + active.parameter.slice(1),
    runId: active.runId,
    pinnedAt,
    pinEndsAt,
    isNewRun,
    scannedAt: state.updatedAt,
    frames: active.frames,
    frameMs: 450,
  };
  return cache;
}

export function getGeospaceMagnetosphereCache() {
  return cache;
}

export function startGeospaceMagnetosphereMonitor() {
  if (magnetosphereDisabled()) return;

  refreshGeospaceMagnetosphere().catch((e) =>
    console.error('[geospace magnetosphere]', e?.message || e),
  );

  const raw = process.env.GEOSPACE_MAGNETOSPHERE_POLL_MS;
  const ms =
    raw != null && String(raw).trim() !== ''
      ? Number.parseInt(String(raw), 10)
      : DEFAULT_POLL_MS;
  if (!Number.isFinite(ms) || ms < 60_000) return;

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    refreshGeospaceMagnetosphere().catch((e) =>
      console.error('[geospace magnetosphere refresh]', e?.message || e),
    );
  }, ms);
}
