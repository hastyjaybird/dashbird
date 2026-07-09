import { Router } from 'express';
import express from 'express';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
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

function parseCoord(raw, min, max) {
  const n = Number.parseFloat(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * Prefer live GPS query params; otherwise dashboard WEATHER_ZIP / lat-lon.
 * @param {import('express').Request} req
 * @returns {Promise<{ lat: number, lon: number, displayName: string, source: 'device' | 'dashboard' }>}
 */
async function resolveRainGeo(req) {
  const qLat = parseCoord(req.query?.lat, -90, 90);
  const qLon = parseCoord(req.query?.lon, -180, 180);
  if (qLat != null && qLon != null) {
    return {
      lat: qLat,
      lon: qLon,
      displayName: `${qLat.toFixed(4)}, ${qLon.toFixed(4)}`,
      source: 'device',
    };
  }

  const dash = await resolveDashboardWeatherLatLon();
  return {
    lat: dash.lat,
    lon: dash.lon,
    displayName: dash.place || (dash.zip ? `ZIP ${dash.zip}` : 'Dashboard location'),
    source: 'dashboard',
  };
}

/** Kept for aircraft-nearby and legacy clients; Settings no longer edits this. */
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

router.get('/', async (req, res) => {
  try {
    if (rainAlertDisabled()) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, imminent: false, message: '' });
      return;
    }

    if (String(process.env.RAIN_ALERT_DEBUG || '').trim() === '1') {
      const minutes = Math.max(
        1,
        Number.parseInt(String(process.env.RAIN_ALERT_DEBUG_MINUTES || '42').trim(), 10) || 42,
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        ok: true,
        debug: true,
        imminent: true,
        minutesUntil: minutes,
        message: minutes <= 1 ? 'rain expected now' : `rain expected in ${minutes} minutes`,
        geo: { lat: 0, lon: 0, displayName: 'debug' },
        source: 'debug',
      });
      return;
    }

    const geo = await resolveRainGeo(req);
    const tz = String(process.env.TZ || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
    const rain = await rainImminentWithin2Hours(geo.lat, geo.lon, tz);

    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json({
      ok: true,
      geo: { lat: geo.lat, lon: geo.lon, displayName: geo.displayName },
      source: geo.source,
      imminent: rain.imminent,
      minutesUntil: rain.minutesUntil,
      message: rain.message,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
