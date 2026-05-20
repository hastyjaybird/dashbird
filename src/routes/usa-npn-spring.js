import { Router } from 'express';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { buildUsaNpnSpringEarthItems } from '../lib/usanpn-spring-context.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const off = String(process.env.EARTH_USA_NPN_SPRING || '').trim() === '0';
    if (off) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, items: [] });
      return;
    }

    const { lat, lon } = await resolveDashboardWeatherLatLon();
    const timeZone = (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
    const locationLabel =
      (process.env.DASHBOARD_LOCATION_LABEL || '').trim() || 'Dashboard coordinates';
    const baseUrl = (process.env.USANPN_GEOSERVER_BASE || '').trim() || undefined;

    const built = await buildUsaNpnSpringEarthItems({ lat, lon, timeZone, baseUrl });
    if (!built.ok) {
      res.status(500).json({ ok: false, error: built.error || 'usa_npn_spring_failed' });
      return;
    }

    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({
      ok: true,
      locationLabel,
      timeZone,
      itemCount: built.items.length,
      items: built.items,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
