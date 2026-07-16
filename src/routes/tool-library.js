import { Router } from 'express';
import express from 'express';
import path from 'node:path';
import {
  collectCategories,
  deleteTools,
  getToolById,
  loadToolLibrary,
  setToolFavorite,
  toolLibraryAssetsDir,
} from '../lib/tool-library-store.js';
import { createToolFromUrl, repairToolLibraryAssets, refreshToolAssets } from '../lib/tool-library-enrich.js';
import { findAlternatives, rankToolAmongAlternatives, searchToolOnline } from '../lib/tool-library-ai.js';
import { fetchToolRating } from '../lib/tool-library-ratings.js';
import { normalizeToolUrl } from '../lib/tool-library-store.js';
import {
  deleteResources,
  getResourceById,
  getResourceByUrl,
  patchResource,
  upsertResource,
  toolRecordToResource,
} from '../lib/web-catalog-store.js';

const router = Router();
router.use(express.json({ limit: '256kb' }));

/** At most one heavy online-search at a time. */
let searchOnlineBusy = false;
let searchOnlineBusySince = 0;
/** Stale-lock recovery if a search hangs and never clears the flag. */
const SEARCH_BUSY_MAX_MS = 60 * 1000;

const ratingsTelemetry = {
  totalRequests: 0,
  nullRatingCount: 0,
  errorCount: 0,
  totalLatencyMs: 0,
  bySource: {
    g2: 0,
    openrouter: 0,
    none: 0,
    other: 0,
  },
  lastEvent: null,
};

function normalizeRatingsSource(rating) {
  const raw = String(rating?.resolvedBy || rating?.source || '').trim().toLowerCase();
  if (!raw) return 'none';
  if (raw === 'g2' || raw === 'openrouter') return raw;
  return 'other';
}

function recordRatingsTelemetry(event) {
  ratingsTelemetry.totalRequests += 1;
  ratingsTelemetry.totalLatencyMs += Math.max(0, Number(event.latencyMs || 0));
  if (event.nullRating) ratingsTelemetry.nullRatingCount += 1;
  if (event.error) ratingsTelemetry.errorCount += 1;
  ratingsTelemetry.bySource[event.sourceUsed] =
    (ratingsTelemetry.bySource[event.sourceUsed] || 0) + 1;
  ratingsTelemetry.lastEvent = event;
  console.info('[tool-library][ratings-telemetry]', JSON.stringify(event));
}

function disabled() {
  return String(process.env.TOOL_LIBRARY || '').trim() === '0';
}

router.get('/', async (_req, res) => {
  try {
    if (disabled()) {
      res.json({ ok: true, disabled: true, tools: [], categories: [] });
      return;
    }
    const data = await loadToolLibrary();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      tools: data.tools,
      categories: collectCategories(data.tools),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/tools', async (req, res) => {
  try {
    if (disabled()) {
      res.status(503).json({ ok: false, error: 'disabled' });
      return;
    }
    const url = req.body?.url;
    if (!url) {
      res.status(400).json({ ok: false, error: 'url_required' });
      return;
    }
    const tool = await createToolFromUrl(url);
    res.status(201).json({ ok: true, tool });
  } catch (e) {
    const msg = String(e?.message || e);
    const code = msg.includes('could_not_resolve') ? 400 : 400;
    res.status(code).json({ ok: false, error: msg });
  }
});

/** Search the web for a tool by name; returns match + alternatives to add. */
router.post('/tools/search-online', async (req, res) => {
  try {
    if (disabled()) {
      res.status(503).json({ ok: false, error: 'disabled' });
      return;
    }
    if (searchOnlineBusy) {
      const age = Date.now() - searchOnlineBusySince;
      if (age < SEARCH_BUSY_MAX_MS) {
        res.status(429).json({ ok: false, error: 'search_busy' });
        return;
      }
      // Previous search never cleared the flag (hang / crash mid-flight).
      searchOnlineBusy = false;
    }
    const query = String(req.body?.query || req.body?.q || '').trim();
    if (!query) {
      res.status(400).json({ ok: false, error: 'query_required' });
      return;
    }
    searchOnlineBusy = true;
    searchOnlineBusySince = Date.now();
    try {
      // Absolute ceiling so a stuck outbound fetch cannot hold the lock forever.
      const result = await Promise.race([
        searchToolOnline(query),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('search_timeout')), 25_000);
        }),
      ]);
      const body = JSON.stringify({
        ok: true,
        query: result.query,
        matched: result.matched,
        ranked: result.ranked,
      });
      // Do not gate on req.destroyed — Node can mark the request destroyed while the
      // response is still writable, which previously left the client hanging forever.
      if (!res.headersSent) {
        res.status(200).type('json').end(body);
      }
    } finally {
      searchOnlineBusy = false;
      searchOnlineBusySince = 0;
    }
  } catch (e) {
    searchOnlineBusy = false;
    searchOnlineBusySince = 0;
    if (res.writableEnded || req.destroyed) return;
    const msg = String(e?.message || e);
    const status = msg.includes('could_not_resolve')
      ? 404
      : msg === 'search_timeout'
        ? 504
        : 500;
    res.status(status).json({ ok: false, error: msg });
  }
});

router.post('/tools/delete', async (req, res) => {
  try {
    if (disabled()) {
      res.status(503).json({ ok: false, error: 'disabled' });
      return;
    }
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const catalogIds = Array.isArray(req.body?.catalogIds)
      ? req.body.catalogIds.map(String)
      : [];
    const urls = Array.isArray(req.body?.urls) ? req.body.urls.map(String) : [];
    if (!ids.length && !catalogIds.length && !urls.length) {
      res.status(400).json({ ok: false, error: 'ids_required' });
      return;
    }
    // Resolve URLs from tool-library rows before deleting them
    const lib = await loadToolLibrary();
    const idSet = new Set(ids);
    const resolvedUrls = [
      ...urls,
      ...lib.tools.filter((t) => idSet.has(String(t.id))).map((t) => t.url),
    ];
    const result = ids.length ? await deleteTools(ids) : { removed: 0 };
    let catalogRemoved = 0;
    let catalogError = null;
    try {
      const cat = await deleteResources(catalogIds, {
        urls: resolvedUrls,
        legacyToolIds: ids,
      });
      catalogRemoved = cat.removed || 0;
    } catch (e) {
      catalogError = String(e?.message || e);
      console.warn('[tool-library] catalog delete failed:', catalogError);
    }
    if (catalogError && (catalogIds.length || resolvedUrls.length)) {
      res.status(500).json({
        ok: false,
        error: 'catalog_delete_failed',
        detail: catalogError,
        removed: result.removed,
        catalogRemoved: 0,
      });
      return;
    }
    res.json({ ok: true, removed: result.removed, catalogRemoved });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** Toggle favorite on a tool (tool-library + catalog). */
router.post('/tools/:id/favorite', async (req, res) => {
  try {
    if (disabled()) {
      res.status(503).json({ ok: false, error: 'disabled' });
      return;
    }
    const favorite = Boolean(req.body?.favorite);
    const id = String(req.params.id || '');
    let tool = await setToolFavorite(id, favorite);
    const url = String(req.body?.url || tool?.url || '').trim();
    const catalogId = String(req.body?.catalogId || '').trim();

    // Catalog-only tools (approved review items) may not be in tool-library.json
    if (!tool && (catalogId || url)) {
      try {
        let resource = catalogId ? await getResourceById(catalogId) : null;
        if (!resource && url) resource = await getResourceByUrl(url);
        if (resource) {
          resource = await patchResource(resource.id, { ...resource, favorite });
          tool = {
            id: resource.legacy_tool_id || resource.id,
            catalogId: resource.id,
            url: resource.url,
            website: resource.url,
            name: resource.title,
            favorite: Boolean(resource.favorite),
          };
        }
      } catch (e) {
        console.warn('[tool-library] catalog favorite failed:', e?.message || e);
      }
    } else if (tool) {
      try {
        await upsertResource(
          { ...toolRecordToResource(tool), favorite },
          { project: 'dashbird', section: 'Tools' },
        );
      } catch (e) {
        console.warn('[tool-library] catalog favorite sync failed:', e?.message || e);
      }
    }

    if (!tool) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true, tool: { ...tool, favorite } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/ratings', async (req, res) => {
  const startedAt = Date.now();
  try {
    const name = String(req.query?.name || '').trim();
    if (!name) {
      res.status(400).json({ ok: false, error: 'name_required' });
      return;
    }
    const rating = await fetchToolRating(name);
    const sourceUsed = normalizeRatingsSource(rating);
    const nullRating = !rating || !Number.isFinite(Number(rating?.rating));
    const latencyMs = Date.now() - startedAt;
    const event = {
      ts: new Date().toISOString(),
      route: '/api/tool-library/ratings',
      name,
      sourceUsed,
      nullRating,
      latencyMs,
      status: 200,
      error: false,
    };
    recordRatingsTelemetry(event);
    const payload = rating ? { ...rating } : { rating: null, source: '' };
    delete payload.resolvedBy;
    res.json({ ok: true, name, ...payload });
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    recordRatingsTelemetry({
      ts: new Date().toISOString(),
      route: '/api/tool-library/ratings',
      name: String(req.query?.name || '').trim(),
      sourceUsed: 'none',
      nullRating: true,
      latencyMs,
      status: 500,
      error: true,
      errorMessage: String(e?.message || e),
    });
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** Lightweight local counters for ratings telemetry debugging. */
router.get('/ratings/debug', (_req, res) => {
  const averageLatencyMs = ratingsTelemetry.totalRequests
    ? Math.round((ratingsTelemetry.totalLatencyMs / ratingsTelemetry.totalRequests) * 10) / 10
    : 0;
  res.json({
    ok: true,
    route: '/api/tool-library/ratings',
    telemetry: {
      ...ratingsTelemetry,
      averageLatencyMs,
    },
  });
});

router.post('/tools/repair-assets', async (_req, res) => {
  try {
    if (disabled()) {
      res.status(503).json({ ok: false, error: 'disabled' });
      return;
    }
    const result = await repairToolLibraryAssets();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/tools/:id/refresh-assets', async (req, res) => {
  try {
    if (disabled()) {
      res.status(503).json({ ok: false, error: 'disabled' });
      return;
    }
    const tool = await refreshToolAssets(req.params.id);
    res.json({ ok: true, tool });
  } catch (e) {
    const msg = String(e?.message || e);
    res.status(msg === 'not_found' ? 404 : 500).json({ ok: false, error: msg });
  }
});

router.post('/tools/:id/alternatives', async (req, res) => {
  try {
    if (disabled()) {
      res.status(503).json({ ok: false, error: 'disabled' });
      return;
    }
    const tool = await getToolById(req.params.id);
    if (!tool) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const alternatives = await findAlternatives(tool);
    const ranked = rankToolAmongAlternatives(tool, alternatives);
    res.json({ ok: true, ranked, sourceToolId: tool.id });
  } catch (e) {
    const msg = String(e?.message || e);
    res.status(500).json({ ok: false, error: msg });
  }
});

/** Add selected alternatives (or re-add original) by URL. */
router.post('/tools/import-batch', async (req, res) => {
  try {
    if (disabled()) {
      res.status(503).json({ ok: false, error: 'disabled' });
      return;
    }
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = rawItems.slice(0, 12);
    /** @type {object[]} */
    const added = [];
    /** @type {string[]} */
    const errors = [];
    for (const item of items) {
      const url = item?.url;
      if (!url) continue;
      try {
        const normalized = normalizeToolUrl(url);
        const data = await loadToolLibrary();
        if (data.tools.some((t) => t.url === normalized)) continue;
        const tool = await createToolFromUrl(url);
        added.push(tool);
      } catch (e) {
        const msg = String(e?.message || e);
        errors.push(msg);
        console.warn('[tool-library] import-batch skip', url, msg);
      }
    }
    res.json({
      ok: true,
      added,
      truncated: rawItems.length > items.length,
      skipped: errors.length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/assets/:file', async (req, res) => {
  const file = path.basename(String(req.params.file || ''));
  if (!file || file.includes('..')) {
    res.status(400).end();
    return;
  }
  const fp = path.join(toolLibraryAssetsDir(), file);
  // Snapshot-once assets: cache for fast remote loads (immutable content per filename).
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.sendFile(fp, (err) => {
    if (err) res.status(404).end();
  });
});

export default router;
