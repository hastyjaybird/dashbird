import { Router } from 'express';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { isEarthDebugShowInactive } from '../lib/earth-debug.js';
import { evaluateNasturtiumBloom } from '../lib/nasturtium-bloom.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const off = String(process.env.EARTH_NASTURTIUM_BLOOM || '').trim() === '0';
    if (off) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, items: [] });
      return;
    }

    const timeZone = (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
    const locationLabel =
      (process.env.DASHBOARD_LOCATION_LABEL || '').trim() || 'Dashboard coordinates';
    const { lat, lon } = await resolveDashboardWeatherLatLon();
    const debug = isEarthDebugShowInactive();

    const result = await evaluateNasturtiumBloom({
      lat,
      lon,
      timeZone,
      includeInactive: debug,
    });

    res.setHeader('Cache-Control', 'private, max-age=1800');
    res.json({
      ok: true,
      locationLabel,
      timeZone,
      earthDebugShowInactive: debug,
      ...result,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
