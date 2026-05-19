import { Router } from 'express';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { buildUsgsEarthquakeWeekItem } from '../lib/usgs-earthquake-week.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const off = String(process.env.EARTH_USGS_QUAKE_WEEK || '').trim() === '0';
    if (off) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, items: [] });
      return;
    }

    const { lat, lon } = await resolveDashboardWeatherLatLon();
    const built = await buildUsgsEarthquakeWeekItem({ lat, lon });

    if (!built.ok) {
      res.setHeader('Cache-Control', 'private, max-age=120');
      res.json({ ok: true, items: [], upstream: built.error || 'usgs_unavailable' });
      return;
    }

    const items = built.item ? [built.item] : [];
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
