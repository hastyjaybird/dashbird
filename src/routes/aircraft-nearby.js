import { Router } from 'express';
import { fetchAircraftNearbyLive } from '../lib/aircraft-nearby.js';

const router = Router();

/** GET /api/aircraft-nearby — live ADS-B snapshot (optional ?lat=&lon= for device GPS). */
router.get('/', async (req, res) => {
  try {
    const lat = req.query.lat;
    const lon = req.query.lon;
    const watchOpts =
      lat != null && lon != null && String(lat).trim() !== '' && String(lon).trim() !== ''
        ? { lat, lon }
        : {};
    const live = await fetchAircraftNearbyLive(new Date(), watchOpts);
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json({ ok: true, ...live });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
