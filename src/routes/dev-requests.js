/**
 * Dev / feature change requests — structured queue with priority, area, and screenshots.
 */
import { Router } from 'express';
import express from 'express';
import {
  DEV_REQUEST_AREAS,
  DEV_REQUEST_PRIORITIES,
} from '../lib/dev-request-areas.js';
import {
  createDevRequest,
  DEV_REQUESTS_INBOX_PATH,
  DEV_REQUESTS_ROOT,
  getDevRequest,
  listDevRequests,
  readDevRequestAttachment,
  rebuildDevRequestsIndex,
  updateDevRequest,
} from '../lib/dev-requests-store.js';

const router = Router();
router.use(express.json({ limit: '12mb' }));

router.get('/meta', (_req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    ok: true,
    root: DEV_REQUESTS_ROOT,
    inboxPath: DEV_REQUESTS_INBOX_PATH,
    areas: DEV_REQUEST_AREAS,
    priorities: Object.values(DEV_REQUEST_PRIORITIES),
  });
});

router.get('/', async (req, res) => {
  try {
    const status = String(req.query?.status || 'open').trim() || 'open';
    const requests = listDevRequests({ status });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, requests, inboxPath: DEV_REQUESTS_INBOX_PATH });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/', async (req, res) => {
  try {
    const request = await createDevRequest({
      title: req.body?.title,
      body: req.body?.body,
      platform: req.body?.platform,
      area: req.body?.area,
      priority: req.body?.priority,
      attachments: req.body?.attachments,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ ok: true, request, inboxPath: DEV_REQUESTS_INBOX_PATH });
  } catch (e) {
    const code = String(e?.code || '');
    const map = {
      title_required: 400,
      invalid_area: 400,
      invalid_image: 400,
      invalid_image_size: 400,
    };
    res.status(map[code] || 500).json({ ok: false, error: String(e?.message || e), code: code || undefined });
  }
});

router.post('/rebuild-index', async (_req, res) => {
  try {
    await rebuildDevRequestsIndex();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, inboxPath: DEV_REQUESTS_INBOX_PATH });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const request = getDevRequest(String(req.params.id || ''));
    if (!request) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, request });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const request = await updateDevRequest(String(req.params.id || ''), {
      status: req.body?.status,
      priority: req.body?.priority,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, request, inboxPath: DEV_REQUESTS_INBOX_PATH });
  } catch (e) {
    const code = String(e?.code || '');
    res.status(code === 'not_found' ? 404 : 500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/:id/files/:filename', async (req, res) => {
  try {
    const { buf, filename } = await readDevRequestAttachment(
      String(req.params.id || ''),
      String(req.params.filename || ''),
    );
    const ext = pathExt(filename);
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(extToMime(ext));
    res.send(buf);
  } catch (e) {
    res.status(404).json({ ok: false, error: 'not_found' });
  }
});

/** @param {string} name */
function pathExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

/** @param {string} ext */
function extToMime(ext) {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

export default router;
