import { Router } from 'express';
import { buildKilaueaDashboardPayload } from '../lib/kilauea-status.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const payload = await buildKilaueaDashboardPayload();
    if (!payload.ok) {
      res.setHeader('Cache-Control', 'private, max-age=120');
      res.json({ ok: true, items: [], cameras: [], upstream: payload.error || 'kilauea_unavailable' });
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
