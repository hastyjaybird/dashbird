import { Router } from 'express';
import { fetchAircraftNearbyLive } from '../lib/aircraft-nearby.js';

const router = Router();

/** GET /api/aircraft-nearby — live ADS-B snapshot (debug / smoke). */
router.get('/', async (_req, res) => {
  try {
    const live = await fetchAircraftNearbyLive();
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json({ ok: true, ...live });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
