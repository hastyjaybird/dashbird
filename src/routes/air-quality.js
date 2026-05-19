import { Router } from 'express';
import { getAirQualityPanelPayload } from '../lib/dashboard-air-quality-panel.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const data = await getAirQualityPanelPayload();
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, show: false, error: String(e?.message || e) });
  }
});

export default router;
