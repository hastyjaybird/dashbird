/**
 * Task location: project default, per-task override in task meta.
 */
export const TASK_LOCATION_OPTIONS = [
  { id: 'home', label: 'Home' },
  { id: 'makerfarm', label: 'Maker Farm' },
  { id: 'out', label: 'Out and about' },
  { id: 'laptop', label: 'Laptop only' },
  { id: 'phone', label: 'Phone ok' },
];

/** @type {Record<string, string>} */
export const TASK_LOCATION_LABELS = Object.fromEntries(
  TASK_LOCATION_OPTIONS.map((o) => [o.id, o.label]),
);

/**
 * @param {Record<string, unknown> | null | undefined} taskMeta
 */
export function taskHasLocationOverride(taskMeta) {
  if (!taskMeta) return false;
  if (taskMeta.locationAny) return true;
  if (typeof taskMeta.location === 'string' && taskMeta.location) return true;
  if (Array.isArray(taskMeta.locations) && taskMeta.locations.length) return true;
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
export function projectDefaultLocationLabel(projectMeta) {
  const loc = projectMeta?.location;
  if (typeof loc === 'string' && loc) {
    return TASK_LOCATION_LABELS[loc] || loc;
  }
  return 'Any';
}

/**
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
export function taskLocationSelectValue(taskMeta, _projectMeta) {
  if (taskMeta?.locationAny) return '__any__';
  if (typeof taskMeta?.location === 'string' && taskMeta.location) return taskMeta.location;
  if (Array.isArray(taskMeta?.locations) && taskMeta.locations.length) {
    return String(taskMeta.locations[0]);
  }
  // No project-default inheritance: unset tasks read as "Any" until explicitly set.
  return '__any__';
}

/**
 * @param {string} value
 * @param {Record<string, unknown> | null | undefined} [projectMeta]
 */
export function patchBodyForTaskLocation(value, projectMeta) {
  if (value === '__any__') return { locationAny: true };
  return { location: value };
}

/**
 * @param {{ byTaskId?: Record<string, unknown>, byProjectId?: Record<string, unknown> }} [cached]
 */
export async function fetchTaskRandomMeta(cached) {
  if (cached?.byTaskId && cached?.byProjectId) return cached;
  try {
    const r = await fetch('/api/vikunja/task-meta', { cache: 'no-store' });
    if (!r.ok) return { byTaskId: {}, byProjectId: {} };
    const j = await r.json();
    return {
      byTaskId: j.byTaskId && typeof j.byTaskId === 'object' ? j.byTaskId : {},
      byProjectId: j.byProjectId && typeof j.byProjectId === 'object' ? j.byProjectId : {},
    };
  } catch {
    return { byTaskId: {}, byProjectId: {} };
  }
}

/**
 * @param {string} taskId
 * @param {Record<string, unknown>} patch
 */
export async function patchTaskRandomMeta(taskId, patch) {
  const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(taskId)}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error('save_failed');
  const j = await r.json();
  return j.meta || { byTaskId: {}, byProjectId: {} };
}

/**
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
export function taskLocationDisplayLabel(taskMeta, projectMeta) {
  const value = taskLocationSelectValue(taskMeta, projectMeta);
  if (value === '__any__') return 'Any location';
  return TASK_LOCATION_LABELS[value] || value;
}

/**
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
export function listTaskLocationOptions(projectMeta) {
  return [{ id: '__any__', label: 'Any location' }, ...TASK_LOCATION_OPTIONS];
}

/**
 * @param {{ taskId: string, taskMeta: Record<string, unknown> | null | undefined, projectMeta: Record<string, unknown> | null | undefined, className?: string, onOpen?: (taskId: string) => void }} opts
 */
export function buildMobileTaskLocationTrigger(opts) {
  const {
    taskId,
    taskMeta,
    projectMeta,
    className = 'mobile-tasks__loc-trigger',
    onOpen,
  } = opts;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = taskLocationDisplayLabel(taskMeta, projectMeta);
  btn.title = 'Change task location';
  btn.setAttribute('aria-label', 'Task location');
  if (taskHasLocationOverride(taskMeta)) {
    btn.classList.add('tasks-loc-select--override');
  }
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onOpen?.(taskId);
  });
  return btn;
}

/**
 * @param {{ taskId: string, taskMeta: Record<string, unknown> | null | undefined, projectMeta: Record<string, unknown> | null | undefined, className?: string, onSaved?: (meta: object) => void }} opts
 */
export function buildTaskLocationSelect(opts) {
  const { taskId, taskMeta, projectMeta, className = 'tasks-panel__loc-select', onSaved } = opts;
  const sel = document.createElement('select');
  sel.className = className;
  sel.title = 'Task location (default unless changed)';
  sel.setAttribute('aria-label', 'Task location');

  const anyOpt = document.createElement('option');
  anyOpt.value = '__any__';
  anyOpt.textContent = 'Any location';
  sel.append(anyOpt);

  for (const loc of TASK_LOCATION_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = loc.id;
    opt.textContent = loc.label;
    sel.append(opt);
  }

  sel.value = taskLocationSelectValue(taskMeta, projectMeta);
  if (taskHasLocationOverride(taskMeta)) {
    sel.classList.add('tasks-loc-select--override');
  }

  sel.addEventListener('change', () => {
    const prev = sel.value;
    sel.disabled = true;
    void patchTaskRandomMeta(taskId, patchBodyForTaskLocation(sel.value, projectMeta))
      .then((meta) => {
        const row = meta.byTaskId?.[taskId];
        sel.classList.toggle('tasks-loc-select--override', taskHasLocationOverride(row));
        onSaved?.(meta);
      })
      .catch(() => {
        sel.value = prev;
      })
      .finally(() => {
        sel.disabled = false;
      });
  });

  return sel;
}
