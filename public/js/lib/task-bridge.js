/** @typedef {{ id: string, text?: string, projectId?: number | null, dueDate?: string | null }} TaskBridgePayload */

const PROJECT_LS_KEY = 'dashbird-tasks-project-id';
const TASK_CREATED_EVENT = 'dashbird:task-created';

/**
 * Last-selected Vikunja project from the Tasks panel (desktop + mobile share key).
 * @returns {number | null}
 */
export function readTasksProjectId() {
  try {
    const raw = localStorage.getItem(PROJECT_LS_KEY);
    if (raw == null || raw === '') return null;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Broadcast that a task was created elsewhere (Daily Summary, etc.).
 * @param {TaskBridgePayload} task
 */
export function notifyTaskCreated(task) {
  if (!task?.id) return;
  document.dispatchEvent(new CustomEvent(TASK_CREATED_EVENT, { detail: task }));
}

/**
 * Scroll the desktop Tasks panel into view after creating a task.
 */
export function focusTasksPanel() {
  const section = document.getElementById('mount-tasks')?.closest('section');
  section?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * @param {(task: TaskBridgePayload) => void} handler
 * @returns {() => void}
 */
export function onTaskCreated(handler) {
  /** @param {Event} e */
  const listener = (e) => {
    const detail = /** @type {CustomEvent<TaskBridgePayload>} */ (e).detail;
    if (detail?.id) handler(detail);
  };
  document.addEventListener(TASK_CREATED_EVENT, listener);
  return () => document.removeEventListener(TASK_CREATED_EVENT, listener);
}
