import { Router } from 'express';
import {
  assessGeomagneticStormActivity,
  geomagneticStormMeetsG2Threshold,
} from '../lib/geomagnetic-storm-merge.js';
import {
  getGeospaceMagnetosphereCache,
  refreshGeospaceMagnetosphere,
} from '../lib/geospace-magnetosphere.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const storm = await assessGeomagneticStormActivity();
    const stormGte2 = geomagneticStormMeetsG2Threshold(storm);
    if (!stormGte2) {
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.json({
        ok: true,
        disabled: false,
        stormActive: false,
        stormGte2: false,
        storm,
        frames: [],
      });
      return;
    }

    let data = getGeospaceMagnetosphereCache();
    if (!data) data = await refreshGeospaceMagnetosphere();
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json({
      ...(data ?? { ok: false, error: 'unavailable' }),
      stormActive: true,
      stormGte2: true,
      storm,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
