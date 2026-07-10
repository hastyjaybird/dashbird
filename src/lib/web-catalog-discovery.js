/**
 * Background discovery worker: alternatives → review_items.
 */
import { findAlternatives } from './tool-library-ai.js';
import {
  addReviewItem,
  claimNextDiscoveryJob,
  getResourceById,
  getResourceByUrl,
  resourceToToolRecord,
  updateDiscoveryJob,
} from './web-catalog-store.js';

/**
 * Build a tool-shaped object for alternatives search without requiring a catalog row.
 * @param {object} job
 */
async function resolveSourceTool(job) {
  if (job.resource_id) {
    const resource = await getResourceById(job.resource_id);
    if (resource) return { tool: resourceToToolRecord(resource), resource };
  }
  const q = job.result?._query && typeof job.result._query === 'object' ? job.result._query : null;
  if (!q) return null;
  const name = String(q.name || '').trim();
  let url = String(q.url || '').trim();
  if (!url && name) {
    const { resolveToolHomepageUrl } = await import('./tool-library-ai.js');
    url = await resolveToolHomepageUrl(name);
  }
  if (!url) return null;
  // Prefer an existing catalog row if one already exists for this URL (do not create).
  const existing = await getResourceByUrl(url).catch(() => null);
  if (existing) return { tool: resourceToToolRecord(existing), resource: existing };
  return {
    tool: {
      id: null,
      catalogId: null,
      url,
      website: url,
      name: name || url,
      bestUsedFor: '',
      categories: [],
      tags: [],
    },
    resource: null,
  };
}

/**
 * Persist a heartbeat so the UI can advance progress dots only when work is moving.
 * @param {object} job
 * @param {object} progress
 */
async function heartbeatJob(job, progress) {
  const prev = job.result && typeof job.result === 'object' ? job.result : {};
  const next = {
    ...prev,
    progress: {
      ...progress,
      at: new Date().toISOString(),
    },
  };
  job.result = next;
  await updateDiscoveryJob(job.id, { result: next });
}

async function processAlternativesJob(job) {
  const resolved = await resolveSourceTool(job);
  if (!resolved?.tool) throw new Error('resource_not_found');
  const { tool, resource } = resolved;
  await heartbeatJob(job, { phase: 'resolving', checked: 0, found: 0 });
  const alternatives = await findAlternatives(tool, {
    onProgress: async (info) => {
      await heartbeatJob(job, info);
    },
  });
  let queued = 0;
  const seenHosts = new Set();
  for (const alt of alternatives || []) {
    if (alt.isOriginal || !alt.url) continue;
    let host = '';
    try {
      host = new URL(alt.url).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      host = '';
    }
    if (host && seenHosts.has(host)) continue;
    if (host) seenHosts.add(host);
    await addReviewItem({
      source_resource_id: resource?.id || null,
      candidate_url: alt.url,
      candidate_title: alt.name || alt.url,
      candidate_summary: alt.bestUsedFor || '',
      reason: `Alternative to ${tool.name || tool.url}`,
      payload: {
        kind_hints: ['tool'],
        tags: alt.categories || [],
        rating: alt.rating,
        logo_url: alt.logoUrl || null,
        snapshot_url: alt.snapshotUrl || null,
      },
    });
    queued += 1;
    await heartbeatJob(job, {
      phase: 'queueing',
      checked: alternatives.length,
      found: queued,
      total: alternatives.length,
    });
  }
  return { queued, source: tool.name || tool.url };
}

export async function processOneDiscoveryJob() {
  const job = await claimNextDiscoveryJob();
  if (!job) return null;
  try {
    let result = {};
    if (job.kind === 'alternatives') {
      result = await processAlternativesJob(job);
    } else {
      result = { skipped: true, kind: job.kind };
    }
    // Preserve ephemeral _query if present; merge job outcome into result.
    const prev = job.result && typeof job.result === 'object' ? job.result : {};
    await updateDiscoveryJob(job.id, {
      status: 'done',
      result: { ...prev, ...result },
      finished_at: new Date().toISOString(),
      error: null,
    });
    return { jobId: job.id, ...result };
  } catch (e) {
    await updateDiscoveryJob(job.id, {
      status: 'error',
      error: String(e?.message || e),
      finished_at: new Date().toISOString(),
    });
    throw e;
  }
}

let timer = null;
let inFlight = false;

export function startWebCatalogDiscoveryWorker(env = process.env) {
  if (String(env.WEB_CATALOG_DISCOVERY || '1').trim() === '0') {
    console.log('[web-catalog-discovery] disabled');
    return;
  }
  const ms = Math.max(5_000, Number(env.WEB_CATALOG_DISCOVERY_MS) || 15_000);
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await processOneDiscoveryJob();
      if (r) console.log('[web-catalog-discovery] job', r.jobId, r.queued ?? r.skipped);
    } catch (e) {
      console.warn('[web-catalog-discovery]', e?.message || e);
    } finally {
      inFlight = false;
    }
  };
  setTimeout(tick, 25_000);
  timer = setInterval(tick, ms);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[web-catalog-discovery] poll every ${Math.round(ms / 1000)}s`);
}
