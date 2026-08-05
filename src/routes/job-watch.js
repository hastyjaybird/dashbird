import { Router } from 'express';
import express from 'express';
import { getJobWatchPayload, runJobWatchScan } from '../lib/job-watch-scan.js';
import { loadJobWatchState, saveJobWatchState } from '../lib/job-watch-store.js';
import { jobWatchEnabled } from '../lib/job-watch-scheduler.js';

const router = Router();
router.use(express.json({ limit: '32kb' }));

router.get('/', async (_req, res) => {
  try {
    if (!jobWatchEnabled()) {
      res.json({ ok: true, disabled: true, targets: [], candidates: [] });
      return;
    }
    const payload = await getJobWatchPayload();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/scan', async (_req, res) => {
  try {
    if (!jobWatchEnabled()) {
      res.status(400).json({ ok: false, error: 'job_watch_disabled' });
      return;
    }
    const result = await runJobWatchScan(process.env, { force: true });
    const payload = await getJobWatchPayload();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ...payload, scanOk: result.ok, scanError: result.error || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/candidates/:id/review', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'missing_id' });
      return;
    }
    const state = await loadJobWatchState();
    const c = (state.candidates || []).find((x) => String(x.id) === id);
    if (!c) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    c.reviewedAt = new Date().toISOString();
    if (req.body?.note) c.reviewNote = String(req.body.note).slice(0, 2000);
    await saveJobWatchState(state);
    res.json({ ok: true, candidate: c });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/candidates/:id/dismiss', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'missing_id' });
      return;
    }
    const state = await loadJobWatchState();
    const c = (state.candidates || []).find((x) => String(x.id) === id);
    if (!c) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    c.dismissedAt = new Date().toISOString();
    c.reviewedAt = c.reviewedAt || c.dismissedAt;
    await saveJobWatchState(state);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
