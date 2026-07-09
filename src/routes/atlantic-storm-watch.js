import { Router } from 'express';
import {
  NHC_CURRENT_STORMS_URL,
  buildAtlanticStormEarthItems,
} from '../lib/atlantic-storm-watch.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const stormsResp = await fetch(NHC_CURRENT_STORMS_URL, {
      headers: { 'User-Agent': 'Dashbird/1.0 (dashbird dashboard; atlantic storm watch)' },
    });
    if (!stormsResp.ok) {
      res.status(502).json({ ok: false, error: `nhc_http_${stormsResp.status}` });
      return;
    }
    const stormsJson = await stormsResp.json();
    const activeStorms = Array.isArray(stormsJson?.activeStorms) ? stormsJson.activeStorms : [];
    const { items, scanned } = await buildAtlanticStormEarthItems(activeStorms);

    res.setHeader('Cache-Control', 'private, max-age=600');
    res.json({
      ok: true,
      source: NHC_CURRENT_STORMS_URL,
      items,
      scanned,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
