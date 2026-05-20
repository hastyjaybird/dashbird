import { Router } from 'express';
import {
  assessGeomagneticStormActivity,
  geomagneticStormMeetsG2Threshold,
} from '../lib/geomagnetic-storm-merge.js';
import { getGeoelectricFieldPayload } from '../lib/geoelectric-field.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const storm = await assessGeomagneticStormActivity();
    const stormGte2 = geomagneticStormMeetsG2Threshold(storm);
    if (!stormGte2) {
      res.setHeader('Cache-Control', 'private, max-age=120');
      res.json({
        ok: true,
        disabled: false,
        active: false,
        stormActive: false,
        stormGte2: false,
        storm,
      });
      return;
    }

    const data = await getGeoelectricFieldPayload();
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.json({
      ...data,
      stormActive: true,
      stormGte2: true,
      storm: data.storm ?? storm,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
