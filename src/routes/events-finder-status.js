import { Router } from 'express';
import { getEventsFinderSourcesManifest } from '../lib/events-finder-sources.js';
import { buildEventsFinderStatus } from '../lib/events-finder-status.js';

const router = Router();

/**
 * GET /api/events-finder-status
 *   ?manifest=1  — source list + strategies only (no outbound probes)
 *   ?fresh=1     — bypass short TTL cache and re-probe now
 *   (default)    — live reachability + status/output/ingestion test (cached ~90s)
 */
router.get('/', async (req, res) => {
  try {
    const wantManifest =
      req.query.manifest === '1' ||
      req.query.manifest === 'true' ||
      String(req.query.manifest || '').toLowerCase() === 'yes';

    if (wantManifest) {
      const sources = await getEventsFinderSourcesManifest();
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        ok: true,
        pending: true,
        sources,
        source: 'bookmarks-personal.json § Events',
      });
      return;
    }

    const fresh =
      req.query.fresh === '1' ||
      req.query.fresh === 'true' ||
      String(req.query.fresh || '').toLowerCase() === 'yes';

    const payload = await buildEventsFinderStatus({ fresh });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ...payload,
      source: 'bookmarks-personal.json § Events',
    });
  } catch (e) {
    const code = e?.code === 'bookmarks_missing' ? 404 : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
