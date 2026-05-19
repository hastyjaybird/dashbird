import { Router } from 'express';
import express from 'express';
import { geocodeAddress } from '../lib/geocode-address.js';
import {
  loadRainAlertAddress,
  saveRainAlertAddress,
} from '../lib/rain-alert-address-store.js';
import { rainImminentWithin2Hours } from '../lib/rain-imminent.js';

const router = Router();
router.use(express.json({ limit: '32kb' }));

function rainAlertDisabled() {
  return String(process.env.RAIN_ALERT || '').trim() === '0';
}

router.get('/address', async (_req, res) => {
  try {
    if (rainAlertDisabled()) {
      res.json({ ok: true, disabled: true, address: '' });
      return;
    }
    const address = await loadRainAlertAddress();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, address });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/address', async (req, res) => {
  try {
    if (rainAlertDisabled()) {
      res.status(400).json({ ok: false, error: 'rain_alert_disabled' });
      return;
    }
    const saved = await saveRainAlertAddress(req.body?.address);
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, address: saved.address });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/', async (_req, res) => {
  try {
    if (rainAlertDisabled()) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, imminent: false, message: '' });
      return;
    }

    const address = await loadRainAlertAddress();
    const geo = await geocodeAddress(address);
    if (!geo) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        ok: true,
        address,
        geo: null,
        imminent: false,
        minutesUntil: null,
        message: '',
        geocodeError: true,
      });
      return;
    }

    const tz = String(process.env.TZ || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
    const rain = await rainImminentWithin2Hours(geo.lat, geo.lon, tz);

    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json({
      ok: true,
      address,
      geo: { lat: geo.lat, lon: geo.lon, displayName: geo.displayName },
      imminent: rain.imminent,
      minutesUntil: rain.minutesUntil,
      message: rain.message,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
