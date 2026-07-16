/**
 * Mobile Vikunja Tasks: project list → task detail (add / complete).
 * @param {HTMLElement | null} root
 * @param {{ vikunjaPublicUrl?: string, vikunjaConfigured?: boolean }} [config]
 */
const PROJECT_LS_KEY = 'dashbird-tasks-project-id';
const DONE_HIDE_MS = 3000;

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
  const openLink = document.createElement('a');
  openLink.className = 'mobile-tasks__open';
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  openLink.textContent = 'Vikunja';
  const publicUrl = String(config.vikunjaPublicUrl || '').trim();
  if (publicUrl) openLink.href = publicUrl;
  else openLink.hidden = true;
  listHead.append(listTitle, openLink);

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

  function showList() {
    view = 'list';
    projectId = null;
    clearAllPending();
    items = [];
    detailPane.hidden = true;
    detailPane.replaceChildren();
    listPane.hidden = false;
    renderProjects();
  }

  /**
   * @param {number} id
   */
  async function openProject(id) {
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
    await loadTodos();
  }

  /**
   * @param {string} [emptyMsg]
   */
  function renderDetailShell(emptyMsg) {
    detailPane.replaceChildren();

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mobile-tasks__back';
    back.textContent = '← Projects';
    back.addEventListener('click', () => {
      showList();
      showStatus('');
    });

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

    detailPane.append(back, head, addForm, list, empty);

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
    li.append(label);

    cb.addEventListener('change', () => {
      if (cb.checked) scheduleDone(item.id);
      else cancelDone(item.id);
    });

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
      const name = document.createElement('div');
      name.className = 'mobile-tasks__project-name';
      name.textContent = p.title;
      const chevron = document.createElement('span');
      chevron.className = 'mobile-tasks__chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '›';
      li.append(name, chevron);
      li.addEventListener('click', () => void openProject(p.id));
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

  void loadProjects();
}
