/**
 * Today's To Do — Vikunja-backed via same-origin /api/vikunja/todos.
 * @param {HTMLElement} root
 */
import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

const TODO_CACHE_KEY = 'today-todo';
const TODO_CACHE_MAX_MS = 12 * 60 * 60 * 1000;

export function mountTodayTodo(root) {
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'today-todo';

  const addForm = document.createElement('form');
  addForm.className = 'today-todo__add';
  addForm.setAttribute('aria-label', 'Add a to-do item');

  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.className = 'today-todo__input';
  addInput.placeholder = 'Add an item…';
  addInput.autocomplete = 'off';
  addInput.maxLength = 280;

  addForm.append(addInput);

  const list = document.createElement('ul');
  list.className = 'today-todo__list';
  list.setAttribute('role', 'list');

  const status = document.createElement('p');
  status.className = 'today-todo__status';
  status.hidden = true;

  wrap.append(addForm, list, status);
  root.append(wrap);

  /** @type {Array<{ id: string, text: string, done: boolean }>} */
  let state = [];
  let canWrite = false;

  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg;
    status.classList.toggle('today-todo__status--err', isErr);
  }

  function setFormEnabled(on) {
    canWrite = on;
    addInput.disabled = !on;
    addForm.classList.toggle('today-todo__add--disabled', !on);
  }

  /**
   * @param {string} id
   * @param {boolean} done
   */
  function syncRowDom(id, done) {
    const li = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!li) return;
    li.classList.toggle('today-todo__item--done', done);
    const cb = li.querySelector('.today-todo__check');
    if (cb instanceof HTMLInputElement) cb.checked = done;
  }

  function applyItems(items, { writable = true } = {}) {
    state = Array.isArray(items)
      ? items
          .map((it) => ({
            id: String(it.id),
            text: String(it.text || '').trim(),
            done: Boolean(it.done),
          }))
          .filter((it) => it.id && it.text)
      : [];
    setFormEnabled(writable);
    renderList();
  }

  async function loadItems() {
    const r = await fetch('/api/vikunja/todos', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));

    if (
      r.status === 503 ||
      j.error === 'vikunja_not_configured' ||
      j.error === 'vikunja_project_required'
    ) {
      state = [];
      renderList();
      setFormEnabled(false);
      showStatus(
        j.error === 'vikunja_project_required'
          ? 'Set VIKUNJA_PROJECT_ID in server env.'
          : 'Set VIKUNJA_BASE_URL, VIKUNJA_TOKEN, and VIKUNJA_PROJECT_ID in server env.',
        true,
      );
      return;
    }

    if (!r.ok || j.ok === false) {
      throw new Error(j.detail || j.error || `HTTP ${r.status}`);
    }

    const items = Array.isArray(j.items) ? j.items : [];
    applyItems(items, { writable: true });
    writePanelCache(TODO_CACHE_KEY, { items });
    showStatus('');
  }

  /**
   * @param {{ id: string, text: string, done: boolean }} item
   */
  function renderItem(item) {
    const li = document.createElement('li');
    li.className = 'today-todo__item';
    li.dataset.id = item.id;
    if (item.done) li.classList.add('today-todo__item--done');

    const row = document.createElement('label');
    row.className = 'today-todo__row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'today-todo__check';
    cb.checked = item.done;

    const text = document.createElement('span');
    text.className = 'today-todo__text';
    text.textContent = item.text;

    row.append(cb, text);
    li.append(row);

    cb.addEventListener('change', () => {
      if (cb.checked) void markDone(item.id);
      else void markUndone(item.id);
    });

    return li;
  }

  function renderList() {
    list.replaceChildren();
    for (const item of state) {
      list.append(renderItem(item));
    }
  }

  /**
   * @param {string} id
   */
  async function markDone(id) {
    const index = state.findIndex((it) => it.id === id);
    if (index < 0 || state[index].done) return;

    const prev = state[index];
    state[index] = { ...prev, done: true };
    syncRowDom(id, true);

    try {
      const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(id)}/done`, {
        method: 'PATCH',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      // Open-only list: drop completed tasks from the panel.
      state = state.filter((it) => it.id !== id);
      writePanelCache(TODO_CACHE_KEY, { items: state });
      renderList();
      showStatus('');
    } catch {
      state[index] = { ...prev, done: false };
      renderList();
      showStatus('Could not save done state.', true);
    }
  }

  /**
   * @param {string} id
   */
  async function markUndone(id) {
    const index = state.findIndex((it) => it.id === id);
    if (index < 0 || !state[index].done) return;

    const prev = state[index];
    state[index] = { ...prev, done: false };
    syncRowDom(id, false);

    try {
      const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(id)}/undo`, {
        method: 'PATCH',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      writePanelCache(TODO_CACHE_KEY, { items: state });
      showStatus('');
    } catch {
      state[index] = { ...prev, done: true };
      renderList();
      showStatus('Could not undo.', true);
    }
  }

  async function addItem(text) {
    const t = text.trim();
    if (!t || !canWrite) return;

    const r = await fetch('/api/vikunja/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false || !j.item) {
      showStatus(
        j.error === 'vikunja_project_required'
          ? 'Set VIKUNJA_PROJECT_ID to create tasks.'
          : 'Could not add item.',
        true,
      );
      return;
    }
    state.unshift({
      id: String(j.item.id),
      text: String(j.item.text).trim(),
      done: false,
    });
    writePanelCache(TODO_CACHE_KEY, { items: state });
    showStatus('');
    renderList();
  }

  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (addInput.disabled) return;
    const t = addInput.value;
    addInput.value = '';
    void addItem(t).then(() => addInput.focus());
  });

  const cached = readPanelCache(TODO_CACHE_KEY, TODO_CACHE_MAX_MS);
  if (cached && typeof cached === 'object' && Array.isArray(cached.items)) {
    applyItems(cached.items, { writable: true });
    showStatus('');
  } else {
    setFormEnabled(false);
  }

  loadItems().catch(() => {
    if (!state.length) {
      setFormEnabled(false);
      showStatus('Could not load Vikunja to-do list.', true);
    }
  });
}
