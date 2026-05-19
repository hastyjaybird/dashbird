/**
 * @param {HTMLElement} root
 */
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

  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg;
    status.classList.toggle('today-todo__status--err', isErr);
  }

  /** @returns {Array<{ id: string, text: string, done: boolean }>} */
  function itemsForDisplay() {
    const active = state.filter((it) => !it.done);
    const done = state.filter((it) => it.done);
    return [...active, ...done];
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

  async function loadItems() {
    const r = await fetch('/api/todolist', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    state = Array.isArray(j.items)
      ? j.items
          .map((it) => ({
            id: String(it.id),
            text: String(it.text || '').trim(),
            done: Boolean(it.done),
          }))
          .filter((it) => it.id && it.text)
      : [];
    renderList();
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
    for (const item of itemsForDisplay()) {
      list.append(renderItem(item));
    }
  }

  /**
   * @param {string} id
   */
  async function markDone(id) {
    const index = state.findIndex((it) => it.id === id);
    if (index < 0 || state[index].done) return;

    state[index] = { ...state[index], done: true };
    syncRowDom(id, true);
    const li = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (li) list.append(li);

    try {
      const r = await fetch(`/api/todolist/${encodeURIComponent(id)}/done`, {
        method: 'PATCH',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      showStatus('');
    } catch {
      state[index] = { ...state[index], done: false };
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

    state[index] = { ...state[index], done: false };
    syncRowDom(id, false);
    const li = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (li) list.prepend(li);

    try {
      const r = await fetch(`/api/todolist/${encodeURIComponent(id)}/undo`, {
        method: 'PATCH',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      showStatus('');
    } catch {
      state[index] = { ...state[index], done: true };
      renderList();
      showStatus('Could not undo.', true);
    }
  }

  async function addItem(text) {
    const t = text.trim();
    if (!t) return;

    const r = await fetch('/api/todolist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false || !j.item) {
      showStatus('Could not add item.', true);
      return;
    }
    state.push({
      id: String(j.item.id),
      text: String(j.item.text).trim(),
      done: false,
    });
    showStatus('');
    renderList();
  }

  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = addInput.value;
    addInput.value = '';
    void addItem(t).then(() => addInput.focus());
  });

  loadItems().catch(() => {
    showStatus('Could not load to-do list.', true);
  });
}
