/**
 * Server-side Vikunja REST client. Tokens stay in env; never sent to the browser.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TITLE_LEN = 280;

const ARCHIVE_PROJECT_TITLE = 'Archive';

/** @type {number | null} */
let cachedArchiveProjectId = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ configured: boolean, baseUrl: string, token: string, projectId: number | null, archiveProjectId: number | null, timeoutMs: number }}
 */
export function resolveVikunjaConfig(env = process.env) {
  const baseRaw = String(env.VIKUNJA_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.VIKUNJA_TOKEN || '').trim();
  const projectRaw = String(env.VIKUNJA_PROJECT_ID || '').trim();
  const projectId = projectRaw && /^\d+$/.test(projectRaw) ? Number(projectRaw) : null;
  const archiveRaw = String(env.VIKUNJA_ARCHIVE_PROJECT_ID || '').trim();
  const archiveProjectId =
    archiveRaw && /^\d+$/.test(archiveRaw) ? Number(archiveRaw) : null;
  const timeoutRaw = Number(env.VIKUNJA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw >= 3000 && timeoutRaw <= 60_000
      ? Math.floor(timeoutRaw)
      : DEFAULT_TIMEOUT_MS;

  if (!baseRaw || !token) {
    return {
      configured: false,
      baseUrl: '',
      token: '',
      projectId,
      archiveProjectId,
      timeoutMs,
    };
  }

  let baseUrl = baseRaw;
  if (!/\/api\/v1$/i.test(baseUrl)) {
    baseUrl = `${baseUrl}/api/v1`;
  }

  return { configured: true, baseUrl, token, projectId, archiveProjectId, timeoutMs };
}

/**
 * @param {unknown} task
 * @returns {{ id: string, text: string, done: boolean, projectId: number | null } | null}
 */
export function mapVikunjaTask(task) {
  if (!task || typeof task !== 'object') return null;
  const id = task.id != null ? String(task.id) : '';
  const text = String(task.title || '').trim();
  if (!id || !text) return null;
  const projectId =
    task.project_id != null && Number.isFinite(Number(task.project_id))
      ? Number(task.project_id)
      : null;
  return {
    id,
    text,
    done: Boolean(task.done),
    projectId,
  };
}

/**
 * @param {string} title
 */
export function normalizeTodoTitle(title) {
  const t = String(title || '').trim();
  if (!t || t.length > MAX_TITLE_LEN) return null;
  return t;
}

/**
 * @param {string} pathAndQuery e.g. "/tasks?per_page=50" or "tasks"
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [opts]
 */
export async function vikunjaFetch(pathAndQuery, opts = {}) {
  const cfg = resolveVikunjaConfig(opts.env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }

  const rel = String(pathAndQuery || '').replace(/^\/+/, '');
  if (!rel || rel.includes('://') || rel.includes('..')) {
    const err = new Error('invalid_path');
    err.code = 'invalid_path';
    err.status = 400;
    throw err;
  }

  const url = `${cfg.baseUrl}/${rel}`;
  const method = String(opts.method || 'GET').toUpperCase();
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/json',
  };

  /** @type {RequestInit} */
  const init = {
    method,
    headers,
    signal: opts.signal ?? AbortSignal.timeout(cfg.timeoutMs),
  };

  if (opts.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let upstream;
  try {
    upstream = await fetch(url, init);
  } catch (e) {
    const err = new Error(String(e?.message || e || 'vikunja_unreachable'));
    err.code = 'vikunja_unreachable';
    err.status = 502;
    throw err;
  }

  const text = await upstream.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return {
    status: upstream.status,
    ok: upstream.ok,
    json,
    text,
    contentType: upstream.headers.get('content-type') || '',
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function listPanelTodos(env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }
  if (cfg.projectId == null) {
    const err = new Error('vikunja_project_required');
    err.code = 'vikunja_project_required';
    err.status = 503;
    throw err;
  }

  const qs = new URLSearchParams({
    per_page: '50',
    sort_by: 'id',
    order_by: 'desc',
    filter: `done = false && project_id = ${cfg.projectId}`,
  });

  const res = await vikunjaFetch(`tasks?${qs}`, { env });
  if (!res.ok) {
    const err = new Error(safeUpstreamMessage(res) || 'vikunja_list_failed');
    err.code = 'vikunja_upstream';
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const rows = Array.isArray(res.json) ? res.json : [];
  return rows.map(mapVikunjaTask).filter(Boolean);
}

/**
 * @param {string} title
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function createPanelTodo(title, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }
  if (cfg.projectId == null) {
    const err = new Error('vikunja_project_required');
    err.code = 'vikunja_project_required';
    err.status = 503;
    throw err;
  }

  const text = normalizeTodoTitle(title);
  if (!text) {
    const err = new Error('invalid_text');
    err.code = 'invalid_text';
    err.status = 400;
    throw err;
  }

  const res = await vikunjaFetch(`projects/${cfg.projectId}/tasks`, {
    method: 'PUT',
    body: { title: text },
    env,
  });
  if (!res.ok) {
    const err = new Error(safeUpstreamMessage(res) || 'vikunja_create_failed');
    err.code = 'vikunja_upstream';
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const item = mapVikunjaTask(res.json);
  if (!item) {
    const err = new Error('vikunja_create_failed');
    err.code = 'vikunja_upstream';
    err.status = 502;
    throw err;
  }
  return item;
}

/**
 * Find or create the Archive project used when completing todos.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
export async function resolveArchiveProjectId(env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (cfg.archiveProjectId != null) return cfg.archiveProjectId;
  if (cachedArchiveProjectId != null) return cachedArchiveProjectId;

  const listRes = await vikunjaFetch('projects?per_page=50', { env });
  if (!listRes.ok || !Array.isArray(listRes.json)) {
    const err = new Error(safeUpstreamMessage(listRes) || 'vikunja_projects_failed');
    err.code = 'vikunja_upstream';
    err.status = listRes.status >= 400 && listRes.status < 600 ? listRes.status : 502;
    throw err;
  }

  const existing = listRes.json.find(
    (p) =>
      p &&
      Number(p.id) > 0 &&
      String(p.title || '').trim().toLowerCase() === ARCHIVE_PROJECT_TITLE.toLowerCase(),
  );
  if (existing?.id != null) {
    cachedArchiveProjectId = Number(existing.id);
    return cachedArchiveProjectId;
  }

  const createRes = await vikunjaFetch('projects', {
    method: 'PUT',
    body: {
      title: ARCHIVE_PROJECT_TITLE,
      description: 'Completed tasks from Dashbird Today’s To Do.',
    },
    env,
  });
  if (!createRes.ok || !createRes.json?.id) {
    const err = new Error(safeUpstreamMessage(createRes) || 'vikunja_archive_create_failed');
    err.code = 'vikunja_upstream';
    err.status = createRes.status >= 400 && createRes.status < 600 ? createRes.status : 502;
    throw err;
  }

  cachedArchiveProjectId = Number(createRes.json.id);
  return cachedArchiveProjectId;
}

/**
 * Mark done (and move into Archive) or undo (restore to the active project).
 * @param {string} id
 * @param {boolean} done
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function setPanelTodoDone(id, done, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  const taskId = String(id || '').trim();
  if (!/^\d+$/.test(taskId)) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }

  const getRes = await vikunjaFetch(`tasks/${taskId}`, { env });
  if (getRes.status === 404) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }
  if (!getRes.ok || !getRes.json || typeof getRes.json !== 'object') {
    const err = new Error(safeUpstreamMessage(getRes) || 'vikunja_get_failed');
    err.code = 'vikunja_upstream';
    err.status = getRes.status >= 400 && getRes.status < 600 ? getRes.status : 502;
    throw err;
  }

  const markDone = Boolean(done);
  /** @type {Record<string, unknown>} */
  const body = {
    ...getRes.json,
    done: markDone,
    percent_done: markDone ? 1 : 0,
  };

  if (markDone) {
    body.project_id = await resolveArchiveProjectId(env);
  } else if (cfg.projectId != null) {
    body.project_id = cfg.projectId;
  }

  const postRes = await vikunjaFetch(`tasks/${taskId}`, {
    method: 'POST',
    body,
    env,
  });
  if (!postRes.ok) {
    const err = new Error(safeUpstreamMessage(postRes) || 'vikunja_update_failed');
    err.code = 'vikunja_upstream';
    err.status = postRes.status >= 400 && postRes.status < 600 ? postRes.status : 502;
    throw err;
  }

  return mapVikunjaTask(postRes.json) || {
    id: taskId,
    text: String(getRes.json.title || '').trim(),
    done: markDone,
    projectId:
      body.project_id != null
        ? Number(body.project_id)
        : getRes.json.project_id != null
          ? Number(getRes.json.project_id)
          : null,
  };
}

/**
 * @param {{ status: number, json?: any, text?: string }} res
 */
function safeUpstreamMessage(res) {
  const msg =
    (res.json && (res.json.message || res.json.error || res.json.detail)) ||
    '';
  const s = String(msg || '').trim();
  if (!s) return '';
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}
