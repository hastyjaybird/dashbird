import { Router } from 'express';
import { reverseGeocodeCoords } from '../lib/reverse-geocode.js';

const router = Router();

function parseCoord(raw, min, max) {
  const n = Number.parseFloat(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

router.get('/reverse', async (req, res) => {
  try {
    const lat = parseCoord(req.query.lat, -90, 90);
    const lon = parseCoord(req.query.lon, -180, 180);
    if (lat == null || lon == null) {
      res.status(400).json({ ok: false, error: 'lat and lon required' });
      return;
    }

    const geo = await reverseGeocodeCoords(lat, lon);
    if (!geo) {
      res.status(502).json({ ok: false, error: 'reverse_geocode_failed' });
      return;
    }

    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json({
      ok: true,
      lat: geo.lat,
      lon: geo.lon,
      shortLabel: geo.shortLabel,
      label: geo.label,
      timeZone: geo.timeZone,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
