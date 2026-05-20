import { Router } from 'express';
import { getMonitoringSourcesPayload } from '../lib/dashboard-monitoring-sources.js';

const router = Router();

router.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.json(getMonitoringSourcesPayload());
});

export default router;
