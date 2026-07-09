import { Router } from 'express';
import { fetchHeroCurrentWeather } from '../lib/hero-weather.js';

const router = Router();

router.get('/', async (req, res) => {
  const lat = parseFloat(String(req.query.lat ?? ''));
  const lon = parseFloat(String(req.query.lon ?? ''));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ ok: false, error: 'lat_lon_required' });
    return;
  }
  try {
    const data = await fetchHeroCurrentWeather(lat, lon);
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
