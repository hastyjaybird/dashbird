import { openRandomTaskPicker, openProjectLocationsTable } from '../lib/task-random-ui.js';

/**
 * Main Tasks panel — browse Vikunja projects, add/complete tasks on Dashbird.
 * Projects list + task detail; rename/add projects; drag tasks onto projects.
 * @param {HTMLElement} root
 * @param {{ vikunjaPublicUrl?: string, vikunjaConfigured?: boolean }} [config]
 */
const PROJECT_LS_KEY = 'dashbird-tasks-project-id';
const DONE_HIDE_MS = 3000;
const DND_TASK_MIME = 'application/x-dashbird-task-id';
const DND_PROJECT_MIME = 'application/x-dashbird-project-id';

export function mountTasks(root, config = {}) {
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'tasks-panel';

  const header = document.createElement('div');
  header.className = 'tasks-panel__header';

  const headerActions = document.createElement('div');
  headerActions.className = 'tasks-panel__header-actions';

  const randomBtn = document.createElement('button');
  randomBtn.type = 'button';
  randomBtn.className = 'tasks-panel__header-btn';
  randomBtn.textContent = 'Do Random Task';

  const locationsBtn = document.createElement('button');
  locationsBtn.type = 'button';
  locationsBtn.className = 'tasks-panel__header-btn';
  locationsBtn.textContent = 'Project locations';

  const openLink = document.createElement('a');
  openLink.className = 'tasks-panel__open';
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  openLink.textContent = 'Open Vikunja';
  const publicUrl = String(config.vikunjaPublicUrl || '').trim();
  if (publicUrl) {
    openLink.href = publicUrl;
  } else {
    openLink.hidden = true;
  }
  headerActions.append(randomBtn, locationsBtn, openLink);
  header.append(headerActions);

  const vikunjaConfigured = config.vikunjaConfigured !== false;
  if (!vikunjaConfigured) {
    randomBtn.hidden = true;
    locationsBtn.hidden = true;
  }

  const split = document.createElement('div');
  split.className = 'tasks-panel__split';

  const projectsPane = document.createElement('nav');
  projectsPane.className = 'tasks-panel__projects';
  projectsPane.setAttribute('aria-label', 'Projects');

  const projectsList = document.createElement('ul');
  projectsList.className = 'tasks-panel__projects-list';
  projectsList.setAttribute('role', 'listbox');
  projectsList.setAttribute('aria-label', 'Vikunja projects');

  const addProjectForm = document.createElement('form');
  addProjectForm.className = 'tasks-panel__add-project';
  addProjectForm.setAttribute('aria-label', 'Add a project');

  const addProjectInput = document.createElement('input');
  addProjectInput.type = 'text';
  addProjectInput.className = 'tasks-panel__project-input';
  addProjectInput.placeholder = 'New project…';
  addProjectInput.maxLength = 120;
  addProjectInput.autocomplete = 'off';

  const addProjectBtn = document.createElement('button');
  addProjectBtn.type = 'submit';
  addProjectBtn.className = 'tasks-panel__project-add-btn';
  addProjectBtn.textContent = 'Add';

  addProjectForm.append(addProjectInput, addProjectBtn);
  projectsPane.append(projectsList, addProjectForm);

  const detail = document.createElement('div');
  detail.className = 'tasks-panel__detail';

  const detailTitle = document.createElement('h3');
  detailTitle.className = 'tasks-panel__detail-title';
  detailTitle.textContent = 'Select a project';

  const addForm = document.createElement('form');
  addForm.className = 'tasks-panel__add';
  addForm.setAttribute('aria-label', 'Add a task');

  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.className = 'tasks-panel__input';
  addInput.placeholder = 'Add a task…';
  addInput.autocomplete = 'off';
  addInput.maxLength = 280;
  addInput.disabled = true;

  addForm.append(addInput);

  const list = document.createElement('ul');
  list.className = 'tasks-panel__list';
  list.setAttribute('role', 'list');

  const empty = document.createElement('p');
  empty.className = 'tasks-panel__empty muted';
  empty.hidden = true;
  empty.textContent = 'No open tasks in this project.';

  detail.append(detailTitle, addForm, list, empty);
  split.append(projectsPane, detail);

  const status = document.createElement('p');
  status.className = 'tasks-panel__status';
  status.hidden = true;

  wrap.append(header, split, status);
  root.append(wrap);

  /** @type {Array<{ id: number, title: string, position?: number }>} */
  let projects = [];
  /** @type {Array<{ id: string, text: string, done: boolean }>} */
  let items = [];
  /** @type {Map<number, Array<{ id: string, text: string, done: boolean }>>} */
  const todosCache = new Map();
  /** @type {number | null} */
  let projectId = null;
  /** @type {number} */
  let loadToken = 0;
  let canWrite = false;
  /** @type {number | null} */
  let editingProjectId = null;
  /** @type {number | null} */
  let draggingProjectId = null;
  let projectDragMoved = false;

  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pendingDone = new Map();


  /** @type {string | null} */
  let highlightTaskId = null;

  /**
   * @param {{ id: string, projectId?: number | null }} task
   */
  function highlightTaskFromRandom(task) {
    highlightTaskId = String(task.id);
    const pid = task.projectId != null ? Number(task.projectId) : projectId;
    if (pid != null && pid !== projectId) {
      selectProject(pid);
    }
    requestAnimationFrame(() => {
      const el = list.querySelector(`.tasks-panel__item[data-id="${CSS.escape(highlightTaskId)}"]`);
      if (el) {
        el.classList.add('tasks-panel__item--random-pick');
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setTimeout(() => el.classList.remove('tasks-panel__item--random-pick'), 4000);
      }
    });
  }

  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg;
    status.classList.toggle('tasks-panel__status--err', Boolean(isErr));
  }

  function setWritable(on) {
    canWrite = on;
    addInput.disabled = !on;
    addForm.classList.toggle('tasks-panel__add--disabled', !on);
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

  function readSavedProjectId() {
    try {
      const raw = localStorage.getItem(PROJECT_LS_KEY);
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  function saveProjectId(id) {
    try {
      if (id != null) localStorage.setItem(PROJECT_LS_KEY, String(id));
    } catch {
      /* ignore */
    }
  }

  function currentProjectTitle() {
    const p = projects.find((x) => x.id === projectId);
    return p?.title || 'Select a project';
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
        '.tasks-panel__project-item--drop, .tasks-panel__project-item--reorder-before, .tasks-panel__project-item--reorder-after',
      )
      .forEach((el) => {
        el.classList.remove(
          'tasks-panel__project-item--drop',
          'tasks-panel__project-item--reorder-before',
          'tasks-panel__project-item--reorder-after',
        );
      });
  }

  /**
   * Midpoint position between neighbors (avoids rewriting every project).
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
   * Persist only the moved project’s position (fast). Full rewrite only if gaps collapse.
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
      // Rare: rewrite all positions in background without blocking UI again.
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
   * @param {number} id
   */
  function selectProject(id) {
    if (projectId === id) return;
    projectId = id;
    saveProjectId(projectId);
    editingProjectId = null;
    renderProjects();
    detailTitle.textContent = currentProjectTitle();

    const cached = todosCache.get(id);
    if (cached) {
      clearAllPending();
      items = cached.map((it) => ({ ...it }));
      setWritable(true);
      renderList();
      showStatus('');
    } else {
      // Keep the panel responsive: clear list but don't block clicks.
      clearAllPending();
      items = [];
      setWritable(false);
      renderList();
      empty.hidden = true;
      detail.classList.add('tasks-panel__detail--loading');
    }

    void loadTodos({ soft: Boolean(cached) }).catch(() => {
      if (!cached) showStatus('Could not load tasks.', true);
    });
  }

  /**
   * @param {number} id
   * @param {string} title
   */
  async function renameProject(id, title) {
    const idx = projects.findIndex((p) => p.id === id);
    const prevTitle = idx >= 0 ? projects[idx].title : '';
    // Optimistic: show the new name immediately.
    if (idx >= 0) projects[idx] = { ...projects[idx], title };
    editingProjectId = null;
    renderProjects();
    if (projectId === id) detailTitle.textContent = currentProjectTitle();

    try {
      const r = await fetch(`/api/vikunja/projects/${encodeURIComponent(String(id))}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false || !j.project) throw new Error(j.error || `HTTP ${r.status}`);
      const i = projects.findIndex((p) => p.id === id);
      if (i >= 0) {
        projects[i] = {
          id: j.project.id,
          title: j.project.title,
          position: Number(j.project.position) || projects[i].position || id,
        };
      }
      if (projectId === id) detailTitle.textContent = currentProjectTitle();
      showStatus('');
      return true;
    } catch {
      if (idx >= 0) projects[idx] = { ...projects[idx], title: prevTitle };
      renderProjects();
      if (projectId === id) detailTitle.textContent = currentProjectTitle();
      showStatus('Could not rename project.', true);
      return false;
    }
  }

  async function createProject(title) {
    const r = await fetch('/api/vikunja/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
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
    selectProject(j.project.id);
    showStatus('');
  }

  /**
   * @param {string} taskId
   * @param {number} targetProjectId
   */
  async function moveTask(taskId, targetProjectId) {
    if (targetProjectId === projectId) return;
    const prev = items.slice();
    const moved = prev.find((it) => it.id === taskId);
    items = items.filter((it) => it.id !== taskId);
    clearPending(taskId);
    if (projectId != null) todosCache.set(projectId, items.map((it) => ({ ...it })));
    if (moved) {
      const dest = todosCache.get(targetProjectId);
      if (dest) {
        todosCache.set(targetProjectId, [{ ...moved, done: false }, ...dest]);
      } else {
        todosCache.delete(targetProjectId);
      }
    }
    renderList();

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
      if (projectId != null) todosCache.set(projectId, items.map((it) => ({ ...it })));
      todosCache.delete(targetProjectId);
      renderList();
      showStatus('Could not move task.', true);
    }
  }

  function renderProjects() {
    projectsList.replaceChildren();
    if (!projects.length) {
      const li = document.createElement('li');
      li.className = 'tasks-panel__project-empty muted';
      li.textContent = 'No projects';
      projectsList.append(li);
      return;
    }

    for (const p of projects) {
      const li = document.createElement('li');
      li.className = 'tasks-panel__project-item';
      li.setAttribute('role', 'option');
      li.dataset.id = String(p.id);
      const selected = p.id === projectId;
      li.classList.toggle('tasks-panel__project-item--active', selected);
      li.setAttribute('aria-selected', selected ? 'true' : 'false');
      // Only the grip handle is draggable so double-click rename on the name still works.
      li.draggable = false;

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
            before
              ? 'tasks-panel__project-item--reorder-before'
              : 'tasks-panel__project-item--reorder-after',
          );
          return;
        }

        li.classList.add('tasks-panel__project-item--drop');
      });
      li.addEventListener('dragleave', () => {
        li.classList.remove(
          'tasks-panel__project-item--drop',
          'tasks-panel__project-item--reorder-before',
          'tasks-panel__project-item--reorder-after',
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
        void moveTask(taskId, p.id);
      });

      if (editingProjectId === p.id) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tasks-panel__project-rename';
        input.value = p.title;
        input.maxLength = 120;
        input.setAttribute('aria-label', `Rename ${p.title}`);

        let committed = false;
        const commit = () => {
          if (committed) return;
          committed = true;
          const next = input.value.trim();
          if (!next || next === p.title) {
            editingProjectId = null;
            renderProjects();
            return;
          }
          void renameProject(p.id, next);
        };

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            committed = true;
            editingProjectId = null;
            renderProjects();
          }
        });
        input.addEventListener('blur', () => commit());

        li.append(input);
        projectsList.append(li);
        queueMicrotask(() => {
          input.focus();
          input.select();
        });
        continue;
      }

      const row = document.createElement('div');
      row.className = 'tasks-panel__project-row';

      const handle = document.createElement('span');
      handle.className = 'tasks-panel__project-drag';
      handle.draggable = true;
      handle.setAttribute('aria-hidden', 'true');
      handle.title = 'Drag to reorder';
      const grip = document.createElement('span');
      grip.className = 'tasks-panel__grip';
      handle.append(grip);
      handle.addEventListener('dragstart', (e) => {
        draggingProjectId = p.id;
        projectDragMoved = false;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DND_PROJECT_MIME, String(p.id));
        e.dataTransfer.setData('text/plain', `project:${p.id}`);
        li.classList.add('tasks-panel__project-item--dragging');
      });
      handle.addEventListener('dragend', () => {
        draggingProjectId = null;
        li.classList.remove('tasks-panel__project-item--dragging');
        clearProjectDropIndicators();
      });

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tasks-panel__project-btn';
      btn.textContent = p.title;
      btn.title = `${p.title} — double-click to rename`;
      btn.draggable = false;
      btn.addEventListener('click', () => {
        if (projectDragMoved) {
          projectDragMoved = false;
          return;
        }
        selectProject(p.id);
      });
      btn.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        editingProjectId = p.id;
        renderProjects();
      });

      row.append(handle, btn);
      li.append(row);
      projectsList.append(li);
    }
  }

  function syncRowDom(id, done) {
    const li = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!li) return;
    li.classList.toggle('tasks-panel__item--done', done);
    li.classList.toggle('tasks-panel__item--pending-hide', pendingDone.has(id));
    const cb = li.querySelector('.tasks-panel__check');
    if (cb instanceof HTMLInputElement) cb.checked = done;
  }

  function renderList() {
    list.replaceChildren();
    for (const item of items) {
      list.append(renderItem(item));
    }
    empty.hidden = items.length > 0 || !canWrite || projectId == null;
  }

  /**
   * @param {{ id: string, text: string, done: boolean }} item
   */
  function renderItem(item) {
    const li = document.createElement('li');
    li.className = 'tasks-panel__item';
    li.dataset.id = item.id;
    li.draggable = !item.done && !pendingDone.has(item.id);
    if (item.done) li.classList.add('tasks-panel__item--done');
    if (pendingDone.has(item.id)) li.classList.add('tasks-panel__item--pending-hide');

    const row = document.createElement('div');
    row.className = 'tasks-panel__row';

    const handle = document.createElement('span');
    handle.className = 'tasks-panel__drag';
    handle.setAttribute('aria-hidden', 'true');
    handle.title = 'Drag to another project';
    const grip = document.createElement('span');
    grip.className = 'tasks-panel__grip';
    handle.append(grip);

    const label = document.createElement('label');
    label.className = 'tasks-panel__label';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'tasks-panel__check';
    cb.checked = item.done;

    const text = document.createElement('span');
    text.className = 'tasks-panel__text';
    text.textContent = item.text;

    label.append(cb, text);
    row.append(handle, label);
    li.append(row);

    cb.addEventListener('change', () => {
      if (cb.checked) scheduleDone(item.id);
      else cancelDone(item.id);
    });

    li.addEventListener('dragstart', (e) => {
      if (item.done || pendingDone.has(item.id)) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(DND_TASK_MIME, item.id);
      e.dataTransfer.setData('text/plain', item.id);
      li.classList.add('tasks-panel__item--dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('tasks-panel__item--dragging');
      projectsList
        .querySelectorAll('.tasks-panel__project-item--drop')
        .forEach((el) => el.classList.remove('tasks-panel__project-item--drop'));
    });

    return li;
  }

  /**
   * Keep checked/done visible for 3s, then persist + hide.
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
    syncRowDom(id, true);
    const li = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (li) li.draggable = false;
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
    syncRowDom(id, false);
    const li = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (li) li.draggable = true;
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
      if (projectId != null) todosCache.set(projectId, items.map((it) => ({ ...it })));
      renderList();
      showStatus('');
    } catch {
      clearPending(id);
      const i = items.findIndex((it) => it.id === id);
      if (i >= 0) items[i] = { ...prev, done: false };
      renderList();
      showStatus('Could not mark task done.', true);
    }
  }

  /**
   * @param {{ soft?: boolean }} [opts]
   */
  async function loadTodos(opts = {}) {
    if (projectId == null) {
      items = [];
      clearAllPending();
      setWritable(false);
      detailTitle.textContent = 'Select a project';
      detail.classList.remove('tasks-panel__detail--loading');
      renderList();
      empty.hidden = true;
      return;
    }

    const requestFor = projectId;
    const token = ++loadToken;
    detailTitle.textContent = currentProjectTitle();

    const r = await fetch(`/api/vikunja/todos?projectId=${encodeURIComponent(String(projectId))}`, {
      cache: 'no-store',
    });
    const j = await r.json().catch(() => ({}));
    if (token !== loadToken || projectId !== requestFor) return;

    detail.classList.remove('tasks-panel__detail--loading');

    if (
      r.status === 503 ||
      j.error === 'vikunja_not_configured' ||
      j.error === 'vikunja_project_required'
    ) {
      if (!opts.soft) {
        items = [];
        clearAllPending();
        setWritable(false);
        renderList();
      }
      showStatus(
        j.error === 'vikunja_project_required'
          ? 'Pick a project or set VIKUNJA_PROJECT_ID.'
          : 'Set VIKUNJA_BASE_URL and VIKUNJA_TOKEN in server env.',
        true,
      );
      return;
    }
    if (!r.ok || j.ok === false) throw new Error(j.detail || j.error || `HTTP ${r.status}`);

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
    todosCache.set(requestFor, items.map((it) => ({ ...it })));
    setWritable(true);
    renderList();
    showStatus('');
  }

  async function addItem(text) {
    const t = text.trim();
    if (!t || !canWrite || projectId == null) return;

    const r = await fetch('/api/vikunja/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t, projectId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false || !j.item) {
      showStatus('Could not add task.', true);
      return;
    }
    items.unshift({
      id: String(j.item.id),
      text: String(j.item.text).trim(),
      done: false,
    });
    todosCache.set(projectId, items.map((it) => ({ ...it })));
    renderList();
    showStatus('');
  }

  /**
   * @param {Array<{ id: number, title: string }>} rows
   * @param {number | null} preferredId
   */
  function fillProjects(rows, preferredId) {
    projects = Array.isArray(rows)
      ? rows.map((p) => ({
          id: Number(p.id),
          title: String(p.title || ''),
          position: Number(p.position) || Number(p.id),
        }))
      : [];
    sortProjectsInPlace();
    if (!projects.length) {
      projectId = null;
      renderProjects();
      return;
    }
    const saved = preferredId ?? readSavedProjectId();
    const match = projects.find((p) => p.id === saved) || projects[0];
    projectId = match.id;
    saveProjectId(projectId);
    renderProjects();
  }

  async function bootstrap() {
    const r = await fetch('/api/vikunja/projects', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 503 || j.error === 'vikunja_not_configured') {
      setWritable(false);
      addProjectInput.disabled = true;
      addProjectBtn.disabled = true;
      showStatus('Set VIKUNJA_BASE_URL and VIKUNJA_TOKEN in server env.', true);
      return;
    }
    if (!r.ok || j.ok === false) throw new Error(j.detail || j.error || `HTTP ${r.status}`);

    const preferred =
      readSavedProjectId() ??
      (j.defaultProjectId != null ? Number(j.defaultProjectId) : null);
    fillProjects(j.projects, preferred);
    await loadTodos();
  }

  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (addInput.disabled) return;
    const t = addInput.value;
    addInput.value = '';
    void addItem(t).then(() => addInput.focus());
  });

  addProjectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = addProjectInput.value;
    addProjectInput.value = '';
    void createProject(t).then(() => addProjectInput.focus());
  });


  randomBtn.addEventListener('click', () => {
    openRandomTaskPicker({
      root: wrap,
      projects,
      onHighlightTask: highlightTaskFromRandom,
      onDone: async (id) => {
        await commitDone(id);
      },
    });
  });

  locationsBtn.addEventListener('click', () => {
    void openProjectLocationsTable({ root: wrap, projects });
  });

  void bootstrap().catch(() => {
    setWritable(false);
    showStatus('Could not load Vikunja projects.', true);
  });
}

/** @deprecated Use mountTasks — kept for older imports. */
export function mountNotes(root, config = {}) {
  mountTasks(root, config);
}
