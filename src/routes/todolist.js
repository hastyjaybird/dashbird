import { Router } from 'express';
import express from 'express';
import {
  addTodoItem,
  clearTodoItemDone,
  loadSessionTodoItems,
  markTodoItemDone,
} from '../lib/todolist-store.js';

const router = Router();
router.use(express.json({ limit: '32kb' }));

router.get('/', async (_req, res) => {
  try {
    const items = await loadSessionTodoItems();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/', async (req, res) => {
  try {
    const saved = await addTodoItem(req.body?.text);
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json(saved);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.patch('/:id/done', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const saved = await markTodoItemDone(id);
    if (!saved.ok) {
      res.status(saved.error === 'not_found' ? 404 : 400).json(saved);
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(saved);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.patch('/:id/undo', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const saved = await clearTodoItemDone(id);
    if (!saved.ok) {
      res.status(saved.error === 'not_found' ? 404 : 400).json(saved);
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(saved);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
