import { Router } from 'express';
import {
  buildEventTypesStatus,
  buildSkyEventTypesStatus,
} from '../lib/event-types-status.js';
import { getEventTypesManifest } from '../lib/event-types-manifest.js';
import {
  buildEarthAndMoonbowEventTypes,
  buildEarthEventTypesSlow,
} from '../lib/event-types-earth-status.js';
import { buildServiceEventTypesStatus } from '../lib/event-types-services-status.js';

const router = Router();

/**
 * GET /api/event-types-status
 *   ?manifest=1 — row list only (instant)
 *   ?part=sky|earth|slow — progressive chunks
 *   default — full payload (all parts)
 */
router.get('/', async (req, res) => {
  try {
    const wh = Number.parseInt(String(req.query.windowHours ?? '24'), 10);
    const windowHours = Number.isFinite(wh) ? wh : 24;

    if (String(req.query.manifest ?? '').trim() === '1') {
      const payload = await getEventTypesManifest();
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
      return;
    }

    const part = String(req.query.part ?? '').trim().toLowerCase();

    if (part === 'sky') {
      const payload = await buildSkyEventTypesStatus(windowHours);
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
      return;
    }

    if (part === 'earth') {
      const types = await buildEarthAndMoonbowEventTypes({ includeSlow: false });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        now: new Date().toISOString(),
        part: 'earth',
        types,
      });
      return;
    }

    if (part === 'slow') {
      const types = await buildEarthEventTypesSlow();
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        now: new Date().toISOString(),
        part: 'slow',
        types,
      });
      return;
    }

    if (part === 'services') {
      const payload = await buildServiceEventTypesStatus();
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
      return;
    }

    const payload = await buildEventTypesStatus(windowHours);
    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
