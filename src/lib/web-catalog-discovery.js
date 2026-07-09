/**
 * Background discovery worker: alternatives → review_items.
 */
import { findAlternatives } from './tool-library-ai.js';
import {
  addReviewItem,
  claimNextDiscoveryJob,
  getResourceById,
  resourceToToolRecord,
  updateDiscoveryJob,
} from './web-catalog-store.js';

async function processAlternativesJob(job) {
  const resource = await getResourceById(job.resource_id);
  if (!resource) throw new Error('resource_not_found');
  const tool = resourceToToolRecord(resource);
  const alternatives = await findAlternatives(tool);
  let queued = 0;
  for (const alt of alternatives || []) {
    if (alt.isOriginal || !alt.url) continue;
    await addReviewItem({
      source_resource_id: resource.id,
      candidate_url: alt.url,
      candidate_title: alt.name || alt.url,
      candidate_summary: alt.bestUsedFor || '',
      reason: `Alternative to ${resource.title}`,
      payload: {
        kind_hints: ['tool'],
        tags: alt.categories || [],
        rating: alt.rating,
      },
    });
    queued += 1;
  }
  return { queued, source: resource.title };
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
    await updateDiscoveryJob(job.id, {
      status: 'done',
      result,
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
