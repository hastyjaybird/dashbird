/**
 * GET/POST /api/dev-notes — read & export floating sticky notes for Cursor agents.
 */
import { Router } from 'express';
import express from 'express';
import {
  DEV_NOTES_PATH,
  exportDevNotes,
  readDevNotesFile,
  writeDevNotesFile,
} from '../lib/dev-notes-store.js';

const router = Router();
router.use(express.json({ limit: '256kb' }));

router.get('/', async (_req, res) => {
  try {
    const markdown = await readDevNotesFile();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, path: DEV_NOTES_PATH, markdown });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** Export sticky content into data/dev-notes.md (clears client-side after success). */
router.post('/export', async (req, res) => {
  try {
    const pageId = String(req.body?.pageId || req.body?.page || 'main').trim() || 'main';
    const content = String(req.body?.content || '');
    const result = await exportDevNotes(pageId, content);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, title: result.title, path: result.path });
  } catch (e) {
    const empty = e?.code === 'empty';
    res.status(empty ? 400 : 500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

/** Replace file contents after agents resolve tasks. */
router.put('/', async (req, res) => {
  try {
    const markdown = String(req.body?.markdown ?? '');
    await writeDevNotesFile(markdown);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, path: DEV_NOTES_PATH });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
