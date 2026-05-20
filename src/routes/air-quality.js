import { Router } from 'express';
import express from 'express';
import { getAirQualityPanelPayload } from '../lib/dashboard-air-quality-panel.js';
import {
  loadAirQualityForceShow,
  saveAirQualityForceShow,
} from '../lib/air-quality-force-show-store.js';

const router = Router();
router.use(express.json({ limit: '4kb' }));

function airQualityDisabled() {
  return String(process.env.AIR_QUALITY || '').trim() === '0';
}

router.get('/force-show', async (_req, res) => {
  try {
    if (airQualityDisabled()) {
      res.json({ ok: true, disabled: true, forceShow: false });
      return;
    }
    const forceShow = await loadAirQualityForceShow();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, forceShow });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/force-show', async (req, res) => {
  try {
    if (airQualityDisabled()) {
      res.status(400).json({ ok: false, error: 'air_quality_disabled' });
      return;
    }
    const saved = await saveAirQualityForceShow(Boolean(req.body?.forceShow));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(saved);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/', async (_req, res) => {
  try {
    const data = await getAirQualityPanelPayload();
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, show: false, error: String(e?.message || e) });
  }
});

export default router;
