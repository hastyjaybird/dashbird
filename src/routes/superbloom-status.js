import { Router } from 'express';
import { getSuperbloomCache, refreshSuperbloomCache } from '../lib/superbloom-agent.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    let data = getSuperbloomCache();
    if (!data) data = await refreshSuperbloomCache();
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
