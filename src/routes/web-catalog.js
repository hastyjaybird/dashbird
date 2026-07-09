import { Router } from 'express';
import express from 'express';
import {
  catalogBackend,
  collectTags,
  createDiscoveryJob,
  deleteResources,
  exportResources,
  getResourceById,
  importResources,
  listDiscoveryJobs,
  listResources,
  listReviewItems,
  patchResource,
  resolveReviewItem,
  resourceToToolRecord,
  upsertResource,
} from '../lib/web-catalog-store.js';
import { runWatchPass } from '../lib/web-catalog-watch.js';
import { processOneDiscoveryJob } from '../lib/web-catalog-discovery.js';
import { toDataSourceRow } from '../lib/web-catalog-interchange.js';
import { createClient } from '@supabase/supabase-js';

const router = Router();
router.use(express.json({ limit: '2mb' }));

function disabled() {
  return String(process.env.WEB_CATALOG || '').trim() === '0';
}

router.get('/', async (req, res) => {
  try {
    if (disabled()) {
      res.json({ ok: true, disabled: true, backend: 'off', resources: [], tags: [] });
      return;
    }
    const q = {
      project: req.query.project ? String(req.query.project) : 'dashbird',
      search: req.query.q ? String(req.query.q) : undefined,
      tag: req.query.tag ? String(req.query.tag) : undefined,
      kind: req.query.kind ? String(req.query.kind) : undefined,
      proficient:
        req.query.proficient == null ? undefined : req.query.proficient === '1' || req.query.proficient === 'true',
      watch_enabled:
        req.query.watch == null ? undefined : req.query.watch === '1' || req.query.watch === 'true',
      ingest_candidate:
        req.query.ingest == null ? undefined : req.query.ingest === '1' || req.query.ingest === 'true',
    };
    const resources = await listResources(q);
    const tags = await collectTags(resources);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      backend: catalogBackend(),
      resources,
      tools: resources
        .filter((r) => (r.kind_hints || []).includes('tool') || (r.tags || []).length)
        .map(resourceToToolRecord),
      tags,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/resources', async (req, res) => {
  try {
    if (disabled()) {
      res.status(503).json({ ok: false, error: 'disabled' });
      return;
    }
    const body = req.body || {};
    if (!body.url) {
      res.status(400).json({ ok: false, error: 'url_required' });
      return;
    }
    const resource = await upsertResource(body, {
      project: body.project || 'dashbird',
      section: body.section || null,
    });
    res.status(201).json({ ok: true, resource, tool: resourceToToolRecord(resource) });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

router.patch('/resources/:id', async (req, res) => {
  try {
    const resource = await patchResource(req.params.id, req.body || {});
    res.json({ ok: true, resource, tool: resourceToToolRecord(resource) });
  } catch (e) {
    const msg = String(e?.message || e);
    res.status(msg === 'not_found' ? 404 : 400).json({ ok: false, error: msg });
  }
});

router.post('/resources/delete', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) {
      res.status(400).json({ ok: false, error: 'ids_required' });
      return;
    }
    const result = await deleteResources(ids);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/export', async (req, res) => {
  try {
    const filter = {
      project: req.query.project ? String(req.query.project) : undefined,
      tag: req.query.tag ? String(req.query.tag) : undefined,
      kind: req.query.kind ? String(req.query.kind) : undefined,
      ingest_candidate:
        req.query.ingest == null ? undefined : req.query.ingest === '1' || req.query.ingest === 'true',
      proficient:
        req.query.proficient == null ? undefined : req.query.proficient === '1' || req.query.proficient === 'true',
      search: req.query.q ? String(req.query.q) : undefined,
    };
    const bundle = await exportResources(filter);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="web-catalog-export-${Date.now()}.json"`,
    );
    res.json(bundle);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/import', async (req, res) => {
  try {
    const membership = {
      project: req.body?.project || 'dashbird',
      section: req.body?.section || null,
    };
    const raw = req.body?.bundle ?? req.body;
    const result = await importResources(raw, membership);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

/** Promote filtered catalog rows into climate-dash data_sources (service keys required). */
router.post('/promote-to-climate-dash', async (req, res) => {
  try {
    const url = String(process.env.CLIMATE_DASH_SUPABASE_URL || '').trim();
    const key = String(process.env.CLIMATE_DASH_SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!url || !key) {
      res.status(503).json({
        ok: false,
        error: 'climate_dash_not_configured',
        hint: 'Set CLIMATE_DASH_SUPABASE_URL and CLIMATE_DASH_SUPABASE_SERVICE_ROLE_KEY',
      });
      return;
    }
    const filter = req.body?.filter || { ingest_candidate: true };
    const resources = await listResources(filter);
    const sb = createClient(url, key, { auth: { persistSession: false } });
    let upserted = 0;
    const errors = [];
    for (const r of resources) {
      const row = toDataSourceRow(r);
      const { error } = await sb.from('data_sources').upsert(row, { onConflict: 'url' });
      if (error) errors.push({ url: row.url, error: error.message });
      else upserted += 1;
    }
    res.json({ ok: true, upserted, errors, count: resources.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/review', async (req, res) => {
  try {
    const status = req.query.status != null ? String(req.query.status) : 'pending';
    const items = await listReviewItems(status);
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/review/:id/resolve', async (req, res) => {
  try {
    const status = String(req.body?.status || '');
    const result = await resolveReviewItem(req.params.id, status);
    res.json({ ok: true, ...result });
  } catch (e) {
    const msg = String(e?.message || e);
    res.status(msg === 'not_found' ? 404 : 400).json({ ok: false, error: msg });
  }
});

router.post('/jobs/alternatives', async (req, res) => {
  try {
    let resourceId = String(req.body?.resourceId || req.body?.resource_id || '').trim();
    let resource = resourceId ? await getResourceById(resourceId) : null;

    // Allow queueing by name/URL when the tool is not in the catalog yet (no modal).
    if (!resource) {
      const nameOrUrl = String(
        req.body?.url || req.body?.name || req.body?.query || req.body?.title || '',
      ).trim();
      if (!nameOrUrl) {
        res.status(400).json({ ok: false, error: 'resource_id_or_name_required' });
        return;
      }
      const { resolveToolHomepageUrl } = await import('../lib/tool-library-ai.js');
      const homepage = await resolveToolHomepageUrl(nameOrUrl);
      resource = await upsertResource(
        {
          url: homepage,
          title: String(req.body?.title || req.body?.name || nameOrUrl).trim(),
          summary: String(req.body?.summary || '').trim(),
          kind_hints: ['tool'],
          tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
        },
        { project: req.body?.project || 'dashbird', section: req.body?.section || 'Tools' },
      );
      resourceId = resource.id;
    }

    const job = await createDiscoveryJob('alternatives', resourceId);
    res.status(202).json({ ok: true, job, resourceId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/jobs', async (_req, res) => {
  try {
    const jobs = await listDiscoveryJobs(30);
    res.json({ ok: true, jobs });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/jobs/process-one', async (_req, res) => {
  try {
    const result = await processOneDiscoveryJob();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/watch/run', async (_req, res) => {
  try {
    const result = await runWatchPass();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
