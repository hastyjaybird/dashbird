import { Router } from 'express';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { buildGoesGlmLightningStripItem } from '../lib/goes-glm-lightning-strip.js';

const router = Router();

const GLM_CACHE_MS = 5 * 60 * 1000;
/** @type {{ at: number, key: string, body: object } | null} */
let glmCache = null;
/** @type {Promise<object> | null} */
let glmInFlight = null;
/** @type {string} */
let glmInFlightKey = '';

router.get('/', async (req, res) => {
  try {
    const off = String(process.env.EARTH_GOES_GLM_LIGHTNING || '').trim() === '0';
    if (off) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, items: [] });
      return;
    }

    const { lat, lon } = await resolveDashboardWeatherLatLon();
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    const now = Date.now();
    if (glmCache && glmCache.key === key && now - glmCache.at < GLM_CACHE_MS) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json(glmCache.body);
      return;
    }

    if (glmInFlight && glmInFlightKey === key) {
      const body = await glmInFlight;
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json(body);
      return;
    }

    glmInFlightKey = key;
    glmInFlight = (async () => {
      const built = await buildGoesGlmLightningStripItem({ lat, lon });
      if (!built.ok) {
        return { ok: true, items: [], upstream: built.error || 'glm_unavailable' };
      }
      return { ok: true, items: Array.isArray(built.items) ? built.items : [] };
    })()
      .then((body) => {
        // Cache successes and empty/upstream misses briefly so refresh storms skip S3.
        glmCache = { at: Date.now(), key, body };
        return body;
      })
      .finally(() => {
        glmInFlight = null;
        glmInFlightKey = '';
      });

    const body = await glmInFlight;
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(body);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
