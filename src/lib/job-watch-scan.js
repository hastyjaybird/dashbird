/**
 * Fetch Anthropic Greenhouse board, match watch targets, assess new/interesting roles.
 */
import {
  loadJobWatchState,
  loadJobWatchTargets,
  saveJobWatchState,
} from './job-watch-store.js';
import {
  assessJob,
  findMatchingTargets,
  isYellowCandidate,
  jobMatchesTarget,
} from './job-watch-assess.js';

const UA = 'dashbird-job-watch/1.0 (+local; Anthropic careers watch)';

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 */
async function fetchJson(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {object} raw Greenhouse job
 */
function normalizeJob(raw) {
  const id = raw?.id != null ? String(raw.id) : '';
  const title = String(raw?.title || '').trim();
  const url = String(raw?.absolute_url || '').trim();
  const location = String(raw?.location?.name || '').trim();
  const updatedAt = raw?.updated_at || raw?.first_published || null;
  return { id, greenhouseId: raw?.id ?? null, title, url, location, updatedAt };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ force?: boolean }} [opts]
 */
export async function runJobWatchScan(env = process.env, opts = {}) {
  const config = await loadJobWatchTargets();
  const state = await loadJobWatchState(env);
  const boardUrl = String(config.boardUrl || '').trim()
    || 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs';

  const fetched = await fetchJson(boardUrl);
  const now = new Date().toISOString();

  if (!fetched.ok) {
    state.lastScanAt = now;
    state.lastScanError = fetched.error || 'fetch_failed';
    await saveJobWatchState(state, env);
    return { ok: false, error: state.lastScanError, state };
  }

  const jobs = (Array.isArray(fetched.data?.jobs) ? fetched.data.jobs : [])
    .map(normalizeJob)
    .filter((j) => j.id && j.title && j.url);

  const byId = new Map(jobs.map((j) => [j.id, j]));
  const known = new Set(state.knownJobIds || []);
  const firstScan = known.size === 0 && !opts.forceBootstrapAsNew;

  // Target matches
  /** @type {Record<string, object | null>} */
  const targetMatches = {};
  for (const target of config.targets || []) {
    const hit = jobs.find((j) => jobMatchesTarget(j, target)) || null;
    targetMatches[target.id] = hit
      ? {
          id: hit.id,
          title: hit.title,
          location: hit.location,
          url: hit.url,
          updatedAt: hit.updatedAt,
        }
      : null;
  }

  // Update / create candidates for interesting unmatched jobs
  /** @type {Map<string, object>} */
  const candMap = new Map((state.candidates || []).map((c) => [String(c.id), c]));

  for (const job of jobs) {
    const matched = findMatchingTargets(job, config);
    const assessment = assessJob(job, config);
    const isNew = !known.has(job.id);

    // Seed: on first scan, don't flood yellow dots for the whole board —
    // only surface maybe/burn/canary that aren't hard pass, marked as backlog.
    const shouldConsider = isYellowCandidate(assessment, matched.map((t) => t.id));
    const prev = candMap.get(job.id);

    if (prev) {
      prev.lastSeenAt = now;
      prev.open = true;
      prev.title = job.title;
      prev.location = job.location;
      prev.url = job.url;
      prev.assessment = assessment;
      if (matched.length) prev.matchedTargetIds = matched.map((t) => t.id);
      continue;
    }

    // First successful scan only baselines the board — no yellow-dot flood.
    // After that, new interesting roles become review candidates.
    if (firstScan || !shouldConsider || !isNew) continue;

    candMap.set(job.id, {
      id: job.id,
      greenhouseId: job.greenhouseId,
      title: job.title,
      location: job.location,
      url: job.url,
      firstSeenAt: now,
      lastSeenAt: now,
      open: true,
      isNew: true,
      backlog: false,
      assessment,
      reviewedAt: null,
      dismissedAt: null,
    });
  }

  // Mark candidates missing from board as closed
  for (const c of candMap.values()) {
    if (!byId.has(String(c.id))) {
      c.open = false;
      c.lastSeenAt = now;
    }
  }

  state.lastScanAt = now;
  state.lastScanError = null;
  state.knownJobIds = jobs.map((j) => j.id);
  state.openJobs = jobs.map((j) => ({
    id: j.id,
    title: j.title,
    location: j.location,
    url: j.url,
  }));
  state.targetMatches = targetMatches;
  state.candidates = [...candMap.values()].sort((a, b) => {
    const ao = a.open === false ? 1 : 0;
    const bo = b.open === false ? 1 : 0;
    if (ao !== bo) return ao - bo;
    const ar = a.reviewedAt || a.dismissedAt ? 1 : 0;
    const br = b.reviewedAt || b.dismissedAt ? 1 : 0;
    if (ar !== br) return ar - br;
    return String(b.firstSeenAt || '').localeCompare(String(a.firstSeenAt || ''));
  });

  await saveJobWatchState(state, env);
  return { ok: true, state, config, jobCount: jobs.length };
}

/**
 * Build API payload for the panel.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function getJobWatchPayload(env = process.env) {
  const config = await loadJobWatchTargets();
  let state = await loadJobWatchState(env);

  // Lazy scan if never run or stale (>2h)
  const staleMs = 2 * 60 * 60 * 1000;
  const last = state.lastScanAt ? Date.parse(state.lastScanAt) : 0;
  if (!last || Date.now() - last > staleMs) {
    const scanned = await runJobWatchScan(env);
    state = scanned.state;
  }

  const targets = (config.targets || []).map((t) => {
    const match = state.targetMatches?.[t.id] || null;
    return {
      id: t.id,
      label: t.label,
      priority: t.priority,
      summary: t.summary,
      status: match ? 'open' : 'closed',
      job: match,
    };
  });

  const candidates = (state.candidates || [])
    .filter((c) => c.open !== false && !c.dismissedAt)
    .filter((c) => {
      const matched = c.assessment?.matchedTargetIds || [];
      // Hide ones that are purely represented as target rows unless canary/unreviewed interesting
      if (matched.length && targets.some((t) => t.status === 'open' && matched.includes(t.id))) {
        return false;
      }
      const v = c.assessment?.verdict;
      return v === 'maybe' || v === 'burn' || v === 'canary';
    })
    .map((c) => ({
      id: c.id,
      title: c.title,
      location: c.location,
      url: c.url,
      firstSeenAt: c.firstSeenAt,
      isNew: c.isNew === true,
      backlog: c.backlog === true,
      reviewedAt: c.reviewedAt || null,
      assessment: c.assessment,
      needsReview: !c.reviewedAt,
    }));

  return {
    ok: true,
    company: config.company || 'Anthropic',
    careersUiUrl: config.careersUiUrl,
    lastScanAt: state.lastScanAt,
    lastScanError: state.lastScanError,
    scanIntervalMs: 2 * 60 * 60 * 1000,
    targets,
    candidates,
  };
}
