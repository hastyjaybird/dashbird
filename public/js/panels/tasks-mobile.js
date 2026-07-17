/**
 * Mobile Vikunja Tasks: project list → task detail (add / complete).
 * @param {HTMLElement | null} root
 * @param {{ vikunjaPublicUrl?: string, vikunjaConfigured?: boolean }} [config]
 */
import {
  pushMobileNav,
  mobileNavBack,
  isMobileNavApplying,
} from '../lib/mobile-history.js';

const PROJECT_LS_KEY = 'dashbird-tasks-project-id';
const DONE_HIDE_MS = 3000;
const PTR_THRESHOLD = 70;
const PTR_MAX = 100;
const DND_PROJECT_MIME = 'application/x-dashbird-project-id';
const DND_TASK_MIME = 'application/x-dashbird-task-id';

/**
 * @param {string} className
 * @param {string} title
 */
function makeDragHandle(className, title) {
  const handle = document.createElement('span');
  handle.className = className;
  handle.setAttribute('aria-hidden', 'true');
  handle.title = title;
  const grip = document.createElement('span');
  grip.className = 'tasks-panel__grip';
  handle.append(grip);
  return handle;
}

/**
 * Midpoint position between neighbors (same as desktop Tasks panel).
 * @param {number | null | undefined} before
 * @param {number | null | undefined} after
 */
function positionBetween(before, after) {
  if (before == null && after == null) return 65536;
  if (before == null) return Math.max(1, Number(after) / 2);
  if (after == null) return Number(before) + 65536;
  const b = Number(before);
  const a = Number(after);
  if (a - b > 2) return (a + b) / 2;
  return b + 1;
}

/**
 * Touch pull-to-refresh on a scroll container.
 * @param {HTMLElement} scrollEl
 * @param {() => Promise<void>} onRefresh
 */
function attachPullToRefresh(scrollEl, onRefresh) {
  let startY = 0;
  let pullPx = 0;
  let tracking = false;
  let refreshing = false;

  const ptr = document.createElement('div');
  ptr.className = 'mobile-tasks__ptr';
  ptr.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'mobile-tasks__ptr-label';
  label.textContent = 'Pull to refresh';
  ptr.append(label);
  scrollEl.insertBefore(ptr, scrollEl.firstChild);

  function atTop() {
    return scrollEl.scrollTop <= 1;
  }

  function applyHeight(h) {
    pullPx = Math.min(Math.max(h, 0), PTR_MAX);
    ptr.style.height = `${pullPx}px`;
    ptr.classList.toggle('mobile-tasks__ptr--ready', pullPx >= PTR_THRESHOLD);
    ptr.classList.toggle('mobile-tasks__ptr--pulling', pullPx > 0);
  }

  function reset() {
    tracking = false;
    pullPx = 0;
    ptr.style.height = '';
    ptr.classList.remove(
      'mobile-tasks__ptr--ready',
      'mobile-tasks__ptr--pulling',
      'mobile-tasks__ptr--loading',
    );
  }

  scrollEl.addEventListener(
    'touchstart',
    (e) => {
      if (refreshing || e.touches.length !== 1) return;
      if (!atTop()) return;
      startY = e.touches[0].clientY;
      tracking = true;
    },
    { passive: true },
  );

  scrollEl.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking || refreshing) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 0 && atTop()) {
        applyHeight(dy * 0.5);
        if (pullPx > 8) e.preventDefault();
      } else {
        tracking = false;
        applyHeight(0);
      }
    },
    { passive: false },
  );

  const end = async () => {
    if (refreshing) return;
    const shouldRefresh = tracking && pullPx >= PTR_THRESHOLD;
    tracking = false;
    if (!shouldRefresh) {
      reset();
      return;
    }
    refreshing = true;
    ptr.classList.add('mobile-tasks__ptr--loading');
    ptr.classList.remove('mobile-tasks__ptr--ready');
    label.textContent = 'Refreshing…';
    applyHeight(PTR_THRESHOLD * 0.85);
    try {
      await onRefresh();
    } finally {
      refreshing = false;
      label.textContent = 'Pull to refresh';
      reset();
    }
  };

  scrollEl.addEventListener('touchend', () => void end(), { passive: true });
  scrollEl.addEventListener(
    'touchcancel',
    () => {
      if (!refreshing) reset();
    },
    { passive: true },
  );
}

/**
 * @returns {number | null}
 */
function readSavedProjectId() {
  try {
    const n = Number(localStorage.getItem(PROJECT_LS_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * @param {number | null} id
 */
function saveProjectId(id) {
  try {
    if (id != null) localStorage.setItem(PROJECT_LS_KEY, String(id));
  } catch {
    /* ignore */
  }
}

/**
 * @param {HTMLElement | null} root
 * @param {{ vikunjaPublicUrl?: string, vikunjaConfigured?: boolean }} [config]
 */
export function mountTasksMobile(root, config = {}) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('mobile-tasks');

  const listPane = document.createElement('div');
  listPane.className = 'mobile-tasks__list-pane';

  const listHead = document.createElement('div');
  listHead.className = 'mobile-tasks__list-head';
  const listTitle = document.createElement('h2');
  listTitle.className = 'mobile-tasks__title';
  listTitle.textContent = 'Projects';
  const listHeadActions = document.createElement('div');
  listHeadActions.className = 'mobile-tasks__head-actions';
  const listRefreshBtn = document.createElement('button');
  listRefreshBtn.type = 'button';
  listRefreshBtn.className = 'mobile-tasks__refresh';
  listRefreshBtn.textContent = 'Refresh';
  listRefreshBtn.setAttribute('aria-label', 'Refresh projects');
  const openLink = document.createElement('a');
  openLink.className = 'mobile-tasks__open';
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  openLink.textContent = 'Vikunja';
  const publicUrl = String(config.vikunjaPublicUrl || '').trim();
  if (publicUrl) openLink.href = publicUrl;
  else openLink.hidden = true;
  listHeadActions.append(listRefreshBtn, openLink);
  listHead.append(listTitle, listHeadActions);

  const projectsList = document.createElement('ul');
  projectsList.className = 'mobile-tasks__projects';
  projectsList.setAttribute('role', 'list');

  const addProjectForm = document.createElement('form');
  addProjectForm.className = 'mobile-tasks__add';
  addProjectForm.setAttribute('aria-label', 'Add a project');
  const addProjectInput = document.createElement('input');
  addProjectInput.type = 'text';
  addProjectInput.className = 'mobile-tasks__input';
  addProjectInput.placeholder = 'New project…';
  addProjectInput.maxLength = 120;
  addProjectInput.autocomplete = 'off';
  const addProjectBtn = document.createElement('button');
  addProjectBtn.type = 'submit';
  addProjectBtn.className = 'mobile-tasks__add-btn';
  addProjectBtn.textContent = 'Add';
  addProjectForm.append(addProjectInput, addProjectBtn);

  listPane.append(listHead, projectsList, addProjectForm);

  const detailPane = document.createElement('div');
  detailPane.className = 'mobile-tasks__detail-pane';
  detailPane.hidden = true;

  const status = document.createElement('p');
  status.className = 'mobile-tasks__status';
  status.textContent = 'Loading…';

  root.append(status, listPane, detailPane);

  const moveOverlay = document.createElement('div');
  moveOverlay.className = 'mobile-tasks__move-overlay';
  moveOverlay.hidden = true;
  const moveTitle = document.createElement('p');
  moveTitle.className = 'mobile-tasks__move-title';
  moveTitle.textContent = 'Move to project';
  const moveList = document.createElement('div');
  moveList.className = 'mobile-tasks__move-list';
  moveOverlay.append(moveTitle, moveList);
  root.append(moveOverlay);

  /** @type {Array<{ id: number, title: string, position?: number }>} */
  let projects = [];
  /** @type {Array<{ id: string, text: string, done: boolean }>} */
  let items = [];
  /** @type {number | null} */
  let projectId = null;
  let canWrite = false;
  /** @type {'list' | 'detail'} */
  let view = 'list';
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pendingDone = new Map();
  let listRefreshing = false;
  let detailRefreshing = false;
  /** @type {number | null} */
  let draggingProjectId = null;
  let projectDragMoved = false;
  /** @type {number | null} */
  let projectPointerId = null;
  /** @type {string | null} */
  let draggingTaskId = null;
  /** @type {number | null} */
  let taskPointerId = null;
  /** @type {number | null} */
  let moveTargetProjectId = null;

  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg;
    status.classList.toggle('mobile-tasks__status--err', Boolean(isErr));
  }

  function clearPending(id) {
    const t = pendingDone.get(id);
    if (t != null) {
      clearTimeout(t);
      pendingDone.delete(id);
    }
  }

  function clearAllPending() {
    for (const t of pendingDone.values()) clearTimeout(t);
    pendingDone.clear();
  }

  function projectTitle(id) {
    return projects.find((p) => p.id === id)?.title || 'Project';
  }

  function sortProjectsInPlace() {
    projects.sort(
      (a, b) =>
        (a.position ?? a.id) - (b.position ?? b.id) ||
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
    );
  }

  function clearProjectDropIndicators() {
    projectsList
      .querySelectorAll(
        '.mobile-tasks__project--reorder-before, .mobile-tasks__project--reorder-after, .mobile-tasks__project--drop',
      )
      .forEach((el) => {
        el.classList.remove(
          'mobile-tasks__project--reorder-before',
          'mobile-tasks__project--reorder-after',
          'mobile-tasks__project--drop',
        );
      });
  }

  /**
   * @param {number} movedId
   */
  async function persistMovedProject(movedId) {
    const idx = projects.findIndex((p) => p.id === movedId);
    if (idx < 0) return;
    const before = idx > 0 ? projects[idx - 1].position : null;
    const after = idx < projects.length - 1 ? projects[idx + 1].position : null;
    const needsRebalance =
      before != null && after != null && Number(after) - Number(before) <= 2;

    if (needsRebalance) {
      projects = projects.map((p, i) => ({ ...p, position: (i + 1) * 65536 }));
      void fetch('/api/vikunja/projects/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: projects.map((p) => p.id) }),
      }).catch(() => {});
      return;
    }

    const position = positionBetween(before, after);
    projects[idx] = { ...projects[idx], position };
    try {
      const r = await fetch(`/api/vikunja/projects/${encodeURIComponent(String(movedId))}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      showStatus('Could not save project order.', true);
    }
  }

  /**
   * @param {number} fromId
   * @param {number} toId
   * @param {'before' | 'after'} place
   */
  function reorderProjectLocal(fromId, toId, place) {
    if (fromId === toId) return;
    const fromIdx = projects.findIndex((p) => p.id === fromId);
    const toIdx = projects.findIndex((p) => p.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = projects.slice();
    const [moved] = next.splice(fromIdx, 1);
    let insertAt = next.findIndex((p) => p.id === toId);
    if (insertAt < 0) return;
    if (place === 'after') insertAt += 1;
    next.splice(insertAt, 0, moved);
    projects = next;
    renderProjects();
    void persistMovedProject(fromId);
  }

  /**
   * @param {string} taskId
   * @param {number} targetProjectId
   */
  async function moveTask(taskId, targetProjectId) {
    if (targetProjectId === projectId) return;
    const prev = items.slice();
    items = items.filter((it) => it.id !== taskId);
    clearPending(taskId);
    renderDetailShell();

    try {
      const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(taskId)}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: targetProjectId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      showStatus('');
    } catch {
      items = prev;
      renderDetailShell();
      showStatus('Could not move task.', true);
    }
  }

  function clearMoveTargetHighlight() {
    moveList
      .querySelectorAll('.mobile-tasks__move-target--hover')
      .forEach((el) => el.classList.remove('mobile-tasks__move-target--hover'));
  }

  /**
   * @param {string} taskId
   */
  function showMoveOverlay(taskId) {
    moveList.replaceChildren();
    const others = projects.filter((p) => p.id !== projectId);
    if (!others.length) {
      const empty = document.createElement('p');
      empty.className = 'mobile-tasks__move-empty muted';
      empty.textContent = 'No other projects to move into.';
      moveList.append(empty);
    } else {
      for (const p of others) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mobile-tasks__move-target';
        btn.dataset.projectId = String(p.id);
        btn.textContent = p.title;
        btn.addEventListener('click', () => {
          void moveTask(taskId, p.id);
          hideMoveOverlay();
        });
        moveList.append(btn);
      }
    }
    draggingTaskId = taskId;
    moveTargetProjectId = null;
    moveOverlay.hidden = false;
    root.classList.add('mobile-tasks--moving');
    if (!isMobileNavApplying() && projectId != null) {
      pushMobileNav({
        tab: 'tasks',
        pane: 'project',
        projectId,
        overlay: 'task-move',
      });
    }
  }

  function hideMoveOverlay(fromPop = false) {
    moveOverlay.hidden = true;
    draggingTaskId = null;
    taskPointerId = null;
    moveTargetProjectId = null;
    clearMoveTargetHighlight();
    root.classList.remove('mobile-tasks--moving');
    detailPane
      .querySelectorAll('.mobile-tasks__task--dragging')
      .forEach((el) => el.classList.remove('mobile-tasks__task--dragging'));
    if (!fromPop && history.state?.overlay === 'task-move') mobileNavBack();
  }

  function highlightMoveTarget(clientX, clientY) {
    clearMoveTargetHighlight();
    moveTargetProjectId = null;
    const el = document.elementFromPoint(clientX, clientY)?.closest('.mobile-tasks__move-target');
    if (!(el instanceof HTMLElement)) return;
    el.classList.add('mobile-tasks__move-target--hover');
    const id = Number(el.dataset.projectId);
    if (Number.isFinite(id) && id > 0) moveTargetProjectId = id;
  }

  function showList() {
    view = 'list';
    projectId = null;
    clearAllPending();
    items = [];
    hideMoveOverlay();
    detailPane.hidden = true;
    detailPane.replaceChildren();
    listPane.hidden = false;
    renderProjects();
  }

  /**
   * @param {number} id
   * @param {{ fromHistory?: boolean }} [opts]
   */
  async function openProject(id, opts = {}) {
    view = 'detail';
    projectId = id;
    saveProjectId(id);
    listPane.hidden = true;
    detailPane.hidden = false;
    clearAllPending();
    items = [];
    canWrite = false;
    renderDetailShell('Loading…');
    showStatus('');
    if (!opts.fromHistory && !isMobileNavApplying()) {
      pushMobileNav({ tab: 'tasks', pane: 'project', projectId: id });
    }
    await loadTodos();
  }

  async function deleteCurrentProject() {
    if (projectId == null) return;
    const id = projectId;
    const title = projectTitle(id);
    const openCount = items.length;
    const msg =
      openCount > 0
        ? `Delete “${title}” and its ${openCount} open task${openCount === 1 ? '' : 's'}? This cannot be undone.`
        : `Delete “${title}”? This cannot be undone.`;
    if (!confirm(msg)) return;

    const deleteBtn = detailPane.querySelector('.mobile-tasks__delete');
    if (deleteBtn instanceof HTMLButtonElement) deleteBtn.disabled = true;
    showStatus('Deleting…');

    try {
      const r = await fetch(`/api/vikunja/projects/${encodeURIComponent(String(id))}`, {
        method: 'DELETE',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) {
        const err =
          j.error === 'archive_project_protected'
            ? 'The Archive project cannot be deleted.'
            : j.error === 'not_found'
              ? 'Project not found.'
              : j.detail || j.error || `HTTP ${r.status}`;
        throw new Error(err);
      }
      projects = projects.filter((p) => p.id !== id);
      try {
        if (readSavedProjectId() === id) localStorage.removeItem(PROJECT_LS_KEY);
      } catch {
        /* ignore */
      }
      showStatus('Project deleted.');
      showList();
      renderProjects();
      if (
        history.state?.dashbirdMobile &&
        history.state.tab === 'tasks' &&
        history.state.pane === 'project'
      ) {
        history.replaceState(
          /** @type {import('../lib/mobile-history.js').MobileNavState} */ ({
            dashbirdMobile: true,
            tab: 'tasks',
            pane: 'list',
          }),
          '',
        );
      }
    } catch (e) {
      showStatus(`Could not delete project: ${e?.message || e}`, true);
      if (deleteBtn instanceof HTMLButtonElement) deleteBtn.disabled = false;
    }
  }

  /**
   * @param {string} [emptyMsg]
   */
  function renderDetailShell(emptyMsg) {
    detailPane.replaceChildren();

    const detailHead = document.createElement('div');
    detailHead.className = 'mobile-tasks__detail-head';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mobile-tasks__back';
    back.textContent = '← Projects';
    back.addEventListener('click', () => {
      if (!moveOverlay.hidden) {
        hideMoveOverlay();
        return;
      }
      mobileNavBack();
    });

    const detailRefreshBtn = document.createElement('button');
    detailRefreshBtn.type = 'button';
    detailRefreshBtn.className = 'mobile-tasks__refresh';
    detailRefreshBtn.textContent = 'Refresh';
    detailRefreshBtn.setAttribute('aria-label', 'Refresh tasks');
    detailRefreshBtn.addEventListener('click', () => void refreshTodos());

    detailHead.append(back, detailRefreshBtn);

    const head = document.createElement('h2');
    head.className = 'mobile-tasks__detail-title';
    head.textContent = projectId != null ? projectTitle(projectId) : 'Project';

    const addForm = document.createElement('form');
    addForm.className = 'mobile-tasks__add';
    addForm.setAttribute('aria-label', 'Add a task');
    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.className = 'mobile-tasks__input';
    addInput.placeholder = 'Add a task…';
    addInput.maxLength = 280;
    addInput.autocomplete = 'off';
    addInput.disabled = !canWrite;
    addForm.classList.toggle('mobile-tasks__add--disabled', !canWrite);
    addForm.append(addInput);
    addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = addInput.value.trim();
      if (!t) return;
      addInput.value = '';
      void addItem(t);
    });

    const list = document.createElement('ul');
    list.className = 'mobile-tasks__tasks';
    list.setAttribute('role', 'list');

    const empty = document.createElement('p');
    empty.className = 'mobile-tasks__empty';
    empty.hidden = true;

    const detailFoot = document.createElement('div');
    detailFoot.className = 'mobile-tasks__detail-foot';
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'mobile-tasks__delete';
    deleteBtn.textContent = 'Delete project';
    deleteBtn.setAttribute('aria-label', `Delete ${projectId != null ? projectTitle(projectId) : 'project'}`);
    deleteBtn.addEventListener('click', () => void deleteCurrentProject());
    detailFoot.append(deleteBtn);

    detailPane.append(detailHead, head, addForm, list, empty, detailFoot);

    if (!items.length) {
      empty.hidden = false;
      empty.textContent = emptyMsg || (canWrite ? 'No open tasks.' : 'Loading…');
      return;
    }

    for (const item of items) {
      list.append(renderTask(item));
    }
  }

  /**
   * @param {{ id: string, text: string, done: boolean }} item
   */
  function renderTask(item) {
    const li = document.createElement('li');
    li.className = 'mobile-tasks__task';
    li.dataset.id = item.id;
    if (item.done) li.classList.add('mobile-tasks__task--done');
    if (pendingDone.has(item.id)) li.classList.add('mobile-tasks__task--pending');

    const row = document.createElement('div');
    row.className = 'mobile-tasks__task-row';

    const canDrag = !item.done && !pendingDone.has(item.id);
    if (canDrag) {
      const handle = makeDragHandle('mobile-tasks__task-drag', 'Move to another project');
      handle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMoveOverlay(item.id);
      });
      row.append(handle);
    }

    const label = document.createElement('label');
    label.className = 'mobile-tasks__task-label';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'mobile-tasks__check';
    cb.checked = item.done;

    const text = document.createElement('span');
    text.className = 'mobile-tasks__task-text';
    text.textContent = item.text;

    label.append(cb, text);
    row.append(label);
    li.append(row);

    cb.addEventListener('change', () => {
      if (cb.checked) scheduleDone(item.id);
      else cancelDone(item.id);
    });

    if (canDrag) {
      li.draggable = true;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DND_TASK_MIME, item.id);
        e.dataTransfer.setData('text/plain', item.id);
        li.classList.add('mobile-tasks__task--dragging');
        showMoveOverlay(item.id);
      });
      li.addEventListener('dragend', () => {
        li.classList.remove('mobile-tasks__task--dragging');
        hideMoveOverlay();
      });
    }

    return li;
  }

  function syncTaskDom(id, done) {
    const li = detailPane.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!li) return;
    li.classList.toggle('mobile-tasks__task--done', done);
    li.classList.toggle('mobile-tasks__task--pending', pendingDone.has(id));
    const cb = li.querySelector('.mobile-tasks__check');
    if (cb instanceof HTMLInputElement) cb.checked = done;
  }

  /**
   * @param {string} id
   */
  function scheduleDone(id) {
    const index = items.findIndex((it) => it.id === id);
    if (index < 0 || pendingDone.has(id)) return;
    items[index] = { ...items[index], done: true };
    const timer = setTimeout(() => {
      pendingDone.delete(id);
      void commitDone(id);
    }, DONE_HIDE_MS);
    pendingDone.set(id, timer);
    syncTaskDom(id, true);
  }

  /**
   * @param {string} id
   */
  function cancelDone(id) {
    if (!pendingDone.has(id)) return;
    clearPending(id);
    const index = items.findIndex((it) => it.id === id);
    if (index < 0) return;
    items[index] = { ...items[index], done: false };
    syncTaskDom(id, false);
  }

  /**
   * @param {string} id
   */
  async function commitDone(id) {
    const index = items.findIndex((it) => it.id === id);
    if (index < 0) return;
    const prev = items[index];
    try {
      const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(id)}/done`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive: false }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      items = items.filter((it) => it.id !== id);
      renderDetailShell();
      showStatus('');
    } catch {
      clearPending(id);
      const i = items.findIndex((it) => it.id === id);
      if (i >= 0) items[i] = { ...prev, done: false };
      renderDetailShell();
      showStatus('Could not mark task done.', true);
    }
  }

  async function loadTodos() {
    if (projectId == null) return;
    const requestFor = projectId;
    const r = await fetch(
      `/api/vikunja/todos?projectId=${encodeURIComponent(String(projectId))}`,
      { cache: 'no-store' },
    );
    const j = await r.json().catch(() => ({}));
    if (view !== 'detail' || projectId !== requestFor) return;

    if (
      r.status === 503 ||
      j.error === 'vikunja_not_configured' ||
      j.error === 'vikunja_project_required'
    ) {
      canWrite = false;
      items = [];
      renderDetailShell(
        j.error === 'vikunja_project_required'
          ? 'Pick a project or set VIKUNJA_PROJECT_ID.'
          : 'Vikunja is not configured.',
      );
      showStatus(
        j.error === 'vikunja_project_required'
          ? 'Pick a project or set VIKUNJA_PROJECT_ID.'
          : 'Set VIKUNJA_BASE_URL and VIKUNJA_TOKEN in server env.',
        true,
      );
      return;
    }
    if (!r.ok || j.ok === false) {
      canWrite = false;
      items = [];
      renderDetailShell('Could not load tasks.');
      showStatus(j.detail || j.error || `HTTP ${r.status}`, true);
      return;
    }

    clearAllPending();
    items = Array.isArray(j.items)
      ? j.items
          .map((it) => ({
            id: String(it.id),
            text: String(it.text || '').trim(),
            done: Boolean(it.done),
          }))
          .filter((it) => it.id && it.text)
      : [];
    canWrite = true;
    renderDetailShell();
    showStatus('');
  }

  /**
   * @param {string} text
   */
  async function addItem(text) {
    const t = text.trim();
    if (!t || !canWrite || projectId == null) return;
    try {
      const r = await fetch('/api/vikunja/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t, projectId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false || !j.item) throw new Error(j.error || `HTTP ${r.status}`);
      items.unshift({
        id: String(j.item.id),
        text: String(j.item.text).trim(),
        done: false,
      });
      renderDetailShell();
      showStatus('');
    } catch {
      showStatus('Could not add task.', true);
    }
  }

  function renderProjects() {
    projectsList.replaceChildren();
    if (!projects.length) {
      const empty = document.createElement('li');
      empty.className = 'mobile-tasks__empty-row';
      empty.textContent = 'No projects yet.';
      projectsList.append(empty);
      return;
    }
    for (const p of projects) {
      const li = document.createElement('li');
      li.className = 'mobile-tasks__project';
      li.dataset.id = String(p.id);

      const handle = makeDragHandle('mobile-tasks__project-drag', 'Drag to reorder');
      handle.draggable = true;
      handle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      handle.addEventListener('dragstart', (e) => {
        draggingProjectId = p.id;
        projectDragMoved = false;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DND_PROJECT_MIME, String(p.id));
        e.dataTransfer.setData('text/plain', `project:${p.id}`);
        li.classList.add('mobile-tasks__project--dragging');
      });
      handle.addEventListener('dragend', () => {
        draggingProjectId = null;
        li.classList.remove('mobile-tasks__project--dragging');
        clearProjectDropIndicators();
      });

      const name = document.createElement('div');
      name.className = 'mobile-tasks__project-name';
      name.textContent = p.title;
      const chevron = document.createElement('span');
      chevron.className = 'mobile-tasks__chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '›';
      li.append(handle, name, chevron);
      li.addEventListener('click', () => {
        if (projectDragMoved) {
          projectDragMoved = false;
          return;
        }
        void openProject(p.id);
      });

      li.addEventListener('dragover', (e) => {
        const types = [...e.dataTransfer.types];
        const isProject = types.includes(DND_PROJECT_MIME);
        const isTask = types.includes(DND_TASK_MIME);
        if (!isProject && !isTask && !types.includes('text/plain')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearProjectDropIndicators();
        if (isProject || (draggingProjectId != null && !isTask)) {
          if (draggingProjectId === p.id) return;
          const rect = li.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          li.classList.add(
            before ? 'mobile-tasks__project--reorder-before' : 'mobile-tasks__project--reorder-after',
          );
          return;
        }
        li.classList.add('mobile-tasks__project--drop');
      });
      li.addEventListener('dragleave', () => {
        li.classList.remove(
          'mobile-tasks__project--drop',
          'mobile-tasks__project--reorder-before',
          'mobile-tasks__project--reorder-after',
        );
      });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const projectRaw = e.dataTransfer.getData(DND_PROJECT_MIME);
        const taskRaw = e.dataTransfer.getData(DND_TASK_MIME);
        const plain = e.dataTransfer.getData('text/plain');
        clearProjectDropIndicators();

        if (projectRaw || (plain && plain.startsWith('project:'))) {
          const fromId = Number(projectRaw || plain.replace(/^project:/, ''));
          if (!Number.isFinite(fromId) || fromId <= 0 || fromId === p.id) return;
          const rect = li.getBoundingClientRect();
          const place = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          projectDragMoved = true;
          reorderProjectLocal(fromId, p.id, place);
          return;
        }

        const taskId = String(taskRaw || plain || '').trim();
        if (!/^\d+$/.test(taskId)) return;
        hideMoveOverlay();
        void moveTask(taskId, p.id);
      });

      projectsList.append(li);
    }
  }

  /**
   * @param {string} title
   */
  async function createProject(title) {
    const t = title.trim();
    if (!t) return;
    try {
      const r = await fetch('/api/vikunja/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false || !j.project) {
        showStatus(
          j.error === 'invalid_title' ? 'Enter a valid project name.' : 'Could not add project.',
          true,
        );
        return;
      }
      const maxPos = projects.reduce((m, p) => Math.max(m, p.position || 0), 0);
      projects.push({
        id: j.project.id,
        title: j.project.title,
        position: Number(j.project.position) || maxPos + 65536,
      });
      projects.sort(
        (a, b) =>
          (a.position ?? a.id) - (b.position ?? b.id) ||
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      );
      showStatus('');
      void openProject(j.project.id);
    } catch {
      showStatus('Could not add project.', true);
    }
  }

  addProjectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = addProjectInput.value.trim();
    if (!t) return;
    addProjectInput.value = '';
    void createProject(t);
  });

  async function refreshProjects() {
    if (listRefreshing) return;
    listRefreshing = true;
    listRefreshBtn.disabled = true;
    showStatus('Refreshing…');
    try {
      await loadProjects();
    } finally {
      listRefreshing = false;
      listRefreshBtn.disabled = false;
    }
  }

  async function refreshTodos() {
    if (detailRefreshing || projectId == null || view !== 'detail') return;
    detailRefreshing = true;
    const btn = detailPane.querySelector('.mobile-tasks__refresh');
    if (btn instanceof HTMLButtonElement) btn.disabled = true;
    showStatus('Refreshing…');
    try {
      await loadProjects();
      if (view === 'detail' && projectId != null) await loadTodos();
    } finally {
      detailRefreshing = false;
      const refreshBtn = detailPane.querySelector('.mobile-tasks__refresh');
      if (refreshBtn instanceof HTMLButtonElement) refreshBtn.disabled = false;
    }
  }

  listRefreshBtn.addEventListener('click', () => void refreshProjects());

  async function loadProjects() {
    try {
      const r = await fetch('/api/vikunja/projects', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (
        r.status === 503 ||
        j.error === 'vikunja_not_configured'
      ) {
        showStatus('Set VIKUNJA_BASE_URL and VIKUNJA_TOKEN in server env.', true);
        projects = [];
        renderProjects();
        return;
      }
      if (!r.ok || j.ok === false) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      projects = Array.isArray(j.projects)
        ? j.projects
            .map((p) => ({
              id: Number(p.id),
              title: String(p.title || '').trim() || `Project ${p.id}`,
              position: Number(p.position) || Number(p.id) || 0,
            }))
            .filter((p) => Number.isFinite(p.id) && p.id > 0)
        : [];
      projects.sort(
        (a, b) =>
          (a.position ?? a.id) - (b.position ?? b.id) ||
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      );
      showStatus('');
      renderProjects();
      const s = history.state;
      if (s?.dashbirdMobile && s.tab === 'tasks' && s.pane === 'project' && s.projectId != null) {
        document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: s }));
      }

      const preferred = readSavedProjectId();
      if (preferred && projects.some((p) => p.id === preferred)) {
        // Stay on list — last project is remembered when they open one.
      }
    } catch (e) {
      showStatus(`Could not load projects: ${e?.message || e}`, true);
      projects = [];
      renderProjects();
    }
  }

  attachPullToRefresh(root, async () => {
    if (draggingProjectId != null || draggingTaskId != null || !moveOverlay.hidden) return;
    if (view === 'detail') await refreshTodos();
    else await refreshProjects();
  });

  projectsList.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.mobile-tasks__project-drag');
    if (!handle) return;
    const li = handle.closest('.mobile-tasks__project');
    if (!li) return;
    draggingProjectId = Number(li.dataset.id);
    projectDragMoved = false;
    projectPointerId = e.pointerId;
    li.classList.add('mobile-tasks__project--dragging');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  projectsList.addEventListener('pointermove', (e) => {
    if (draggingProjectId == null || e.pointerId !== projectPointerId) return;
    projectDragMoved = true;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mobile-tasks__project');
    clearProjectDropIndicators();
    if (target instanceof HTMLElement && Number(target.dataset.id) !== draggingProjectId) {
      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      target.classList.add(
        before ? 'mobile-tasks__project--reorder-before' : 'mobile-tasks__project--reorder-after',
      );
    }
  });

  function finishProjectPointerDrag(e) {
    if (draggingProjectId == null || e.pointerId !== projectPointerId) return;
    const fromId = draggingProjectId;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mobile-tasks__project');
    clearProjectDropIndicators();
    projectsList
      .querySelectorAll('.mobile-tasks__project--dragging')
      .forEach((el) => el.classList.remove('mobile-tasks__project--dragging'));
    draggingProjectId = null;
    projectPointerId = null;
    if (target instanceof HTMLElement) {
      const toId = Number(target.dataset.id);
      if (Number.isFinite(toId) && toId > 0 && toId !== fromId) {
        const rect = target.getBoundingClientRect();
        const place = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        reorderProjectLocal(fromId, toId, place);
      }
    }
  }

  projectsList.addEventListener('pointerup', finishProjectPointerDrag);
  projectsList.addEventListener('pointercancel', finishProjectPointerDrag);

  detailPane.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.mobile-tasks__task-drag');
    if (!handle) return;
    const li = handle.closest('.mobile-tasks__task');
    if (!li || li.classList.contains('mobile-tasks__task--done')) return;
    const taskId = String(li.dataset.id || '');
    if (!taskId) return;
    taskPointerId = e.pointerId;
    li.classList.add('mobile-tasks__task--dragging');
    showMoveOverlay(taskId);
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  detailPane.addEventListener('pointermove', (e) => {
    if (taskPointerId == null || e.pointerId !== taskPointerId) return;
    highlightMoveTarget(e.clientX, e.clientY);
  });

  function finishTaskPointerDrag(e) {
    if (taskPointerId == null || e.pointerId !== taskPointerId) return;
    const taskId = draggingTaskId;
    const targetProjectId = moveTargetProjectId;
    hideMoveOverlay();
    if (taskId && targetProjectId != null) void moveTask(taskId, targetProjectId);
  }

  detailPane.addEventListener('pointerup', finishTaskPointerDrag);
  detailPane.addEventListener('pointercancel', () => hideMoveOverlay(true));

  moveOverlay.addEventListener('pointerup', (e) => {
    if (taskPointerId == null) return;
    highlightMoveTarget(e.clientX, e.clientY);
    finishTaskPointerDrag(e);
  });

  moveList.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes(DND_TASK_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    highlightMoveTarget(e.clientX, e.clientY);
  });

  moveList.addEventListener('drop', (e) => {
    e.preventDefault();
    const taskId = String(e.dataTransfer.getData(DND_TASK_MIME) || draggingTaskId || '').trim();
    highlightMoveTarget(e.clientX, e.clientY);
    const targetProjectId = moveTargetProjectId;
    hideMoveOverlay();
    if (taskId && targetProjectId != null) void moveTask(taskId, targetProjectId);
  });

  void loadProjects();

  document.addEventListener('dashbird:mobile-nav', (e) => {
    const s = e.detail;
    if (!s || s.tab !== 'tasks') return;
    if (s.overlay === 'task-move') {
      hideMoveOverlay(true);
      return;
    }
    if (s.pane === 'list') {
      showList();
      showStatus('');
      return;
    }
    if (s.pane === 'project' && s.projectId != null) {
      const id = Number(s.projectId);
      if (Number.isFinite(id) && id > 0) void openProject(id, { fromHistory: true });
      else showList();
    }
  });
}
