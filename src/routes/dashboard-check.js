import { Router } from 'express';
import { runDashboardChecks } from '../lib/dashboard-check.js';

const router = Router();

/**
 * POST /api/dashboard-check — run connectivity checks (bookmarks, OpenRouter, sky-events, etc.).
 * Triggered from the health sidebar; extend checks in src/lib/dashboard-check.js.
 */
router.post('/', async (_req, res) => {
  try {
    const out = await runDashboardChecks();
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) {
    res.status(500).json({
      ok: false,
      checkedAt: new Date().toISOString(),
      results: [],
      error: String(e?.message || e),
    });
  }
});

export default router;
