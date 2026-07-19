/**
 * Add / delete bookmark tiles in the Personal + Work bookmark files.
 * The tiles themselves are still served statically from `/data/*.json`;
 * these endpoints mutate those files so the panel can edit them in place.
 */
import { Router } from 'express';
import express from 'express';
import {
  addBookmark,
  deleteBookmark,
  bulkDeleteBookmarks,
  setBookmarkLayout,
} from '../lib/bookmarks-store.js';

const router = Router();
router.use(express.json({ limit: '256kb' }));

const ERROR_STATUS = {
  invalid_scope: 400,
  invalid_section: 400,
  invalid_word: 400,
  invalid_href: 400,
  invalid_items: 400,
  invalid_layout: 400,
  invalid_json: 500,
  not_found: 404,
};

function sendError(res, e) {
  const code = String(e?.code || '');
  res.status(ERROR_STATUS[code] || 500).json({
    ok: false,
    error: String(e?.message || e),
    code: code || undefined,
  });
}

router.post('/:scope/items', async (req, res) => {
  try {
    const data = await addBookmark(req.params.scope, req.body || {});
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ ok: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

router.delete('/:scope/items', async (req, res) => {
  try {
    const data = await deleteBookmark(req.params.scope, req.body || {});
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

router.post('/:scope/bulk-delete', async (req, res) => {
  try {
    const data = await bulkDeleteBookmarks(req.params.scope, req.body?.items);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

router.put('/:scope/layout', async (req, res) => {
  try {
    const data = await setBookmarkLayout(req.params.scope, req.body || {});
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
