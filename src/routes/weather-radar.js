import { Router } from 'express';
import { getWeatherRadarStatus, radarDisabled } from '../lib/weather-radar-status.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    if (radarDisabled()) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, show: false });
      return;
    }

    const payload = await getWeatherRadarStatus();
    if (!payload.ok) {
      res.status(500).json({ ok: false, error: payload.error || 'radar_failed' });
      return;
    }

    res.setHeader(
      'Cache-Control',
      payload.show ? 'private, max-age=90' : 'private, max-age=60',
    );
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
