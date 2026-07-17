import { Router } from 'express';
import express from 'express';
import {
  createPanelProject,
  createPanelTodo,
  deletePanelProject,
  listPanelProjects,
  listPanelTodos,
  movePanelTodo,
  renamePanelProject,
  reorderPanelProjects,
  resolveVikunjaConfig,
  setPanelTodoDone,
  updatePanelProject,
  vikunjaFetch,
} from '../lib/vikunja-client.js';

const router = Router();
router.use(express.json({ limit: '32kb' }));

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * @param {unknown} e
 * @param {import('express').Response} res
 */
function sendErr(e, res) {
  const code = String(e?.code || e?.message || 'vikunja_error');
  const status = Number(e?.status) || (code === 'vikunja_not_configured' ? 503 : 500);
  const safe =
    status >= 500 && !String(e?.message || '').startsWith('vikunja_')
      ? code
      : String(e?.message || code);
  res.status(status).json({
    ok: false,
    error: code,
    detail: safe === code ? undefined : safe,
  });
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function parseProjectId(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

router.get('/health', async (_req, res) => {
  const cfg = resolveVikunjaConfig();
  if (!cfg.configured) {
    res.status(503).json({
      ok: false,
      configured: false,
      error: 'vikunja_not_configured',
      detail: 'Set VIKUNJA_BASE_URL and VIKUNJA_TOKEN in server env.',
    });
    return;
  }

  try {
    const upstream = await vikunjaFetch('info');
    const version =
      upstream.json && typeof upstream.json.version === 'string'
        ? upstream.json.version
        : undefined;
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(upstream.ok ? 200 : 502).json({
      ok: upstream.ok,
      configured: true,
      projectId: cfg.projectId,
      version,
      error: upstream.ok ? undefined : 'vikunja_unreachable',
    });
  } catch (e) {
    sendErr(e, res);
  }
});

/** Top-level projects for the main Tasks panel. */
router.get('/projects', async (_req, res) => {
  try {
    const projects = await listPanelProjects();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      configured: true,
      defaultProjectId: resolveVikunjaConfig().projectId,
      projects,
    });
  } catch (e) {
    sendErr(e, res);
  }
});

router.post('/projects', async (req, res) => {
  try {
    const project = await createPanelProject(req.body?.title ?? req.body?.name);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ ok: true, project });
  } catch (e) {
    sendErr(e, res);
  }
});

router.post('/projects/reorder', async (req, res) => {
  try {
    const projects = await reorderPanelProjects(req.body?.ids ?? req.body?.order);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, projects });
  } catch (e) {
    sendErr(e, res);
  }
});

router.patch('/projects/:id', async (req, res) => {
  try {
    const id = parseProjectId(req.params.id);
    if (id == null) {
      res.status(400).json({ ok: false, error: 'invalid_id' });
      return;
    }
    /** @type {{ title?: string, position?: number }} */
    const patch = {};
    if (req.body?.title != null || req.body?.name != null) {
      patch.title = req.body?.title ?? req.body?.name;
    }
    if (req.body?.position != null && Number.isFinite(Number(req.body.position))) {
      patch.position = Number(req.body.position);
    }
    if (patch.title == null && patch.position == null) {
      res.status(400).json({ ok: false, error: 'invalid_patch' });
      return;
    }
    const project =
      patch.title != null && patch.position == null
        ? await renamePanelProject(id, patch.title)
        : await updatePanelProject(id, patch);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, project });
  } catch (e) {
    sendErr(e, res);
  }
});

router.delete('/projects/:id', async (req, res) => {
  try {
    const id = parseProjectId(req.params.id);
    if (id == null) {
      res.status(400).json({ ok: false, error: 'invalid_id' });
      return;
    }
    await deletePanelProject(id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true });
  } catch (e) {
    sendErr(e, res);
  }
});

/** Panel-shaped list (open tasks only). Prefer this from the Tasks UI. */
router.get('/todos', async (req, res) => {
  try {
    const projectId = parseProjectId(req.query.projectId ?? req.query.project_id);
    const items = await listPanelTodos(process.env, { projectId });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      configured: true,
      projectId: projectId ?? resolveVikunjaConfig().projectId,
      items,
    });
  } catch (e) {
    sendErr(e, res);
  }
});

router.post('/todos', async (req, res) => {
  try {
    const dueDate = req.body?.dueDate ?? req.body?.due_date ?? null;
    const projectId = parseProjectId(req.body?.projectId ?? req.body?.project_id);
    const item = await createPanelTodo(req.body?.text ?? req.body?.title, process.env, {
      dueDate,
      projectId,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ ok: true, item });
  } catch (e) {
    sendErr(e, res);
  }
});

router.patch('/todos/:id/done', async (req, res) => {
  try {
    const moveToArchive = req.body?.archive !== false && req.query.archive !== '0';
    const item = await setPanelTodoDone(req.params.id, true, process.env, {
      moveToArchive,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, item });
  } catch (e) {
    sendErr(e, res);
  }
});

router.patch('/todos/:id/undo', async (req, res) => {
  try {
    const restoreProjectId = parseProjectId(req.body?.projectId ?? req.body?.project_id);
    const item = await setPanelTodoDone(req.params.id, false, process.env, {
      restoreProjectId,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, item });
  } catch (e) {
    sendErr(e, res);
  }
});

router.patch('/todos/:id/move', async (req, res) => {
  try {
    const projectId = parseProjectId(req.body?.projectId ?? req.body?.project_id);
    if (projectId == null) {
      res.status(400).json({ ok: false, error: 'invalid_project' });
      return;
    }
    const item = await movePanelTodo(req.params.id, projectId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, item });
  } catch (e) {
    sendErr(e, res);
  }
});

/**
 * Raw same-origin proxy for Vikunja REST under /api/vikunja/*.
 * Fail closed when env is unset. No stack traces to the client.
 */
router.all('*', async (req, res) => {
  const cfg = resolveVikunjaConfig();
  if (!cfg.configured) {
    res.status(503).json({
      ok: false,
      error: 'vikunja_not_configured',
      detail: 'Set VIKUNJA_BASE_URL and VIKUNJA_TOKEN in server env.',
    });
    return;
  }

  const method = String(req.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const sub = String(req.url || '/').replace(/^\//, '');
  if (!sub || sub === '*') {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }

  // Block path traversal / absolute URLs in the proxied path.
  if (sub.includes('..') || sub.includes('://')) {
    res.status(400).json({ ok: false, error: 'invalid_path' });
    return;
  }

  try {
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';
    const upstream = await vikunjaFetch(sub, {
      method,
      body: hasBody ? req.body : undefined,
    });

    res.status(upstream.status);
    res.setHeader('Cache-Control', 'private, no-store');
    if (upstream.contentType) {
      res.setHeader('Content-Type', upstream.contentType);
    } else {
      res.setHeader('Content-Type', 'application/json');
    }

    if (upstream.json != null) {
      res.json(upstream.json);
      return;
    }
    if (upstream.text) {
      res.send(upstream.text);
      return;
    }
    res.end();
  } catch (e) {
    sendErr(e, res);
  }
});

export default router;
