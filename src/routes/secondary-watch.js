import { Router } from 'express';
import express from 'express';
import { buildSecondaryWatchEarthBundle } from '../lib/secondary-watch-earth.js';
import { resolveSecondaryWatchLocation } from '../lib/secondary-watch-location.js';
import {
  loadSecondaryWatchZip,
  saveSecondaryWatchZip,
} from '../lib/secondary-watch-zip-store.js';

const router = Router();
router.use(express.json({ limit: '8kb' }));

function disabled() {
  return String(process.env.SECONDARY_WATCH || '').trim() === '0';
}

router.get('/zip', async (_req, res) => {
  try {
    if (disabled()) {
      res.json({ ok: true, disabled: true, zip: '', place: '' });
      return;
    }
    const loc = await resolveSecondaryWatchLocation();
    const zip = loc?.zip || (await loadSecondaryWatchZip());
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      zip,
      place: typeof loc?.place === 'string' ? loc.place : '',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/zip', async (req, res) => {
  try {
    if (disabled()) {
      res.status(400).json({ ok: false, error: 'secondary_watch_disabled' });
      return;
    }
    const saved = await saveSecondaryWatchZip(req.body?.zip);
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }
    const loc = await resolveSecondaryWatchLocation();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      zip: saved.zip,
      place: typeof loc?.place === 'string' ? loc.place : '',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/', async (_req, res) => {
  try {
    if (disabled()) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, items: [] });
      return;
    }
    const baseUrl = (process.env.USANPN_GEOSERVER_BASE || '').trim() || undefined;
    const payload = await buildSecondaryWatchEarthBundle({ baseUrl });
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
