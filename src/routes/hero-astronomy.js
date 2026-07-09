import { Router } from 'express';
import { computeHeroAstronomy } from '../lib/hero-astronomy.js';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';

const router = Router();

router.get('/', async (req, res) => {
  const qLat = parseFloat(String(req.query.lat ?? ''));
  const qLon = parseFloat(String(req.query.lon ?? ''));
  let lat = qLat;
  let lon = qLon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const resolved = await resolveDashboardWeatherLatLon();
    if (!Number.isFinite(lat)) lat = resolved.lat;
    if (!Number.isFinite(lon)) lon = resolved.lon;
  }

  try {
    const { sunsetEpochMs, moonriseEpochMs, nextFullMoonEpochMs, nextNewMoonEpochMs, moonCaptionShowsNextNewMoon, timeZone, nwsForecastUrl, nwsMapClickUrl, nwsPointsUrl } =
      await computeHeroAstronomy(lat, lon);
    res.json({
      ok: true,
      sunsetEpochMs,
      moonriseEpochMs,
      nextFullMoonEpochMs,
      nextNewMoonEpochMs,
      moonCaptionShowsNextNewMoon,
      timeZone,
      nwsForecastUrl,
      nwsMapClickUrl,
      nwsPointsUrl,
    });
  } catch (e) {
    const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    res.status(502).json({ ok: false, error: msg });
  }
});

export default router;
