/**
 * Google Keep-style scratch notes — text files with optional image/voice attachment.
 */
import { Router } from 'express';
import express from 'express';
import {
  clearKeepNoteAttachment,
  createKeepNote,
  deleteKeepNote,
  getKeepNote,
  KEEP_NOTES_ROOT,
  listKeepNotes,
  readKeepNoteAttachment,
  setKeepNoteAttachment,
  updateKeepNote,
} from '../lib/keep-notes-store.js';

const router = Router();
router.use(express.json({ limit: '14mb' }));

router.get('/meta', (_req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ ok: true, root: KEEP_NOTES_ROOT });
});

router.get('/', async (_req, res) => {
  try {
    const notes = await listKeepNotes();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, notes });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const note = await getKeepNote(String(req.params.id || ''));
    if (!note) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, note });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/', async (req, res) => {
  try {
    const note = await createKeepNote({
      title: req.body?.title,
      body: req.body?.body,
      pinned: req.body?.pinned,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ ok: true, note });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const note = await updateKeepNote(String(req.params.id || ''), {
      title: req.body?.title,
      body: req.body?.body,
      pinned: req.body?.pinned,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, note });
  } catch (e) {
    const code = String(e?.code || '');
    res.status(code === 'not_found' ? 404 : 500).json({
      ok: false,
      error: String(e?.message || e),
      code: code || undefined,
    });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteKeepNote(String(req.params.id || ''));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true });
  } catch (e) {
    const code = String(e?.code || '');
    res.status(code === 'not_found' ? 404 : 500).json({
      ok: false,
      error: String(e?.message || e),
      code: code || undefined,
    });
  }
});

router.post('/:id/attachment', async (req, res) => {
  try {
    const note = await setKeepNoteAttachment(String(req.params.id || ''), req.body || {});
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, note });
  } catch (e) {
    const code = String(e?.code || '');
    const map = {
      not_found: 404,
      invalid_attachment: 400,
      invalid_attachment_type: 400,
      invalid_attachment_size: 400,
    };
    res.status(map[code] || 500).json({
      ok: false,
      error: String(e?.message || e),
      code: code || undefined,
    });
  }
});

router.delete('/:id/attachment', async (req, res) => {
  try {
    const note = await clearKeepNoteAttachment(String(req.params.id || ''));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, note });
  } catch (e) {
    const code = String(e?.code || '');
    res.status(code === 'not_found' ? 404 : 500).json({
      ok: false,
      error: String(e?.message || e),
      code: code || undefined,
    });
  }
});

router.get('/:id/attachment/:filename', async (req, res) => {
  try {
    const { buf, mimeType } = await readKeepNoteAttachment(
      String(req.params.id || ''),
      String(req.params.filename || ''),
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', mimeType);
    res.send(buf);
  } catch (e) {
    const code = String(e?.code || '');
    res.status(code === 'not_found' ? 404 : 500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

export default router;
