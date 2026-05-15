import { Router } from 'express';

const router = Router();

router.all('*', (req, res) => {
  res.status(501).json({
    error: 'not_implemented',
    detail: 'Google Keep integration is deferred to v2 — see docs/v2-roadmap.md',
  });
});

export default router;
