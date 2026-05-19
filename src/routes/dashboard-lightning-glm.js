import { Router } from 'express';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { buildGoesGlmLightningStripItem } from '../lib/goes-glm-lightning-strip.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const off = String(process.env.EARTH_GOES_GLM_LIGHTNING || '').trim() === '0';
    if (off) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, items: [] });
      return;
    }

    const { lat, lon } = await resolveDashboardWeatherLatLon();
    const built = await buildGoesGlmLightningStripItem({ lat, lon });

    if (!built.ok) {
      res.setHeader('Cache-Control', 'private, max-age=120');
      res.json({ ok: true, items: [], upstream: built.error || 'glm_unavailable' });
      return;
    }

    const items = Array.isArray(built.items) ? built.items : [];
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
