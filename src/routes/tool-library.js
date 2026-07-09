import { Router } from 'express';
import express from 'express';
import path from 'node:path';
import {
  collectCategories,
  deleteTools,
  getToolById,
  loadToolLibrary,
  toolLibraryAssetsDir,
} from '../lib/tool-library-store.js';
import { createToolFromUrl, repairToolLibraryAssets, refreshToolAssets } from '../lib/tool-library-enrich.js';
import { findAlternatives, rankToolAmongAlternatives } from '../lib/tool-library-ai.js';
import { fetchToolRating } from '../lib/tool-library-ratings.js';
import { normalizeToolUrl } from '../lib/tool-library-store.js';

const router = Router();
router.use(express.json({ limit: '256kb' }));

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

router.post('/tools/delete', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) {
      res.status(400).json({ ok: false, error: 'ids_required' });
      return;
    }
    const result = await deleteTools(ids);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/ratings', async (req, res) => {
  try {
    const name = String(req.query?.name || '').trim();
    if (!name) {
      res.status(400).json({ ok: false, error: 'name_required' });
      return;
    }
    const rating = await fetchToolRating(name);
    res.json({ ok: true, name, ...(rating || { rating: null, source: '' }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
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
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    /** @type {object[]} */
    const added = [];
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
        console.warn('[tool-library] import-batch skip', url, e?.message || e);
      }
    }
    res.json({ ok: true, added });
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
  res.sendFile(fp, (err) => {
    if (err) res.status(404).end();
  });
});

export default router;
