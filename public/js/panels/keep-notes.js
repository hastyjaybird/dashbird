/**
 * Google Keep-style scratch notes — pinned cards, scrollable grid, image + voice attachments.
 * @param {HTMLElement | null} root
 */
export function mountKeepNotes(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('keep-notes');

  const shell = document.createElement('div');
  shell.className = 'keep-notes__shell';

  const compose = document.createElement('div');
  compose.className = 'keep-notes__compose';

  const composeTitle = document.createElement('input');
  composeTitle.type = 'text';
  composeTitle.className = 'keep-notes__compose-title';
  composeTitle.placeholder = 'Title';
  composeTitle.maxLength = 200;
  composeTitle.autocomplete = 'off';

  const composeBody = document.createElement('textarea');
  composeBody.className = 'keep-notes__compose-body';
  composeBody.placeholder = 'Take a note…';
  composeBody.rows = 1;
  composeBody.maxLength = 20000;

  const PIN_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H8c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1.03-1 1.03 1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';
  const IMAGE_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>';
  const VOICE_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';

  const composeActions = document.createElement('div');
  composeActions.className = 'keep-notes__compose-actions';
  composeActions.hidden = true;

  const composePinBtn = document.createElement('button');
  composePinBtn.type = 'button';
  composePinBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  composePinBtn.title = 'Pin';
  composePinBtn.setAttribute('aria-label', 'Pin');
  composePinBtn.setAttribute('aria-pressed', 'false');
  composePinBtn.innerHTML = PIN_ICON;

  const composeImageInput = document.createElement('input');
  composeImageInput.type = 'file';
  composeImageInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
  composeImageInput.hidden = true;

  const composeImageBtn = document.createElement('button');
  composeImageBtn.type = 'button';
  composeImageBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  composeImageBtn.title = 'Add image';
  composeImageBtn.setAttribute('aria-label', 'Add image');
  composeImageBtn.innerHTML = IMAGE_ICON;

  const composeVoiceBtn = document.createElement('button');
  composeVoiceBtn.type = 'button';
  composeVoiceBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  composeVoiceBtn.title = 'Record voice note';
  composeVoiceBtn.setAttribute('aria-label', 'Record voice note');
  composeVoiceBtn.innerHTML = VOICE_ICON;

  const composeClose = document.createElement('button');
  composeClose.type = 'button';
  composeClose.className = 'keep-notes__btn keep-notes__btn--ghost';
  composeClose.textContent = 'Cancel';

  const composeSave = document.createElement('button');
  composeSave.type = 'button';
  composeSave.className = 'keep-notes__btn keep-notes__btn--primary';
  composeSave.textContent = 'Add';

  composeActions.append(composePinBtn, composeImageBtn, composeVoiceBtn, composeClose, composeSave);
  compose.append(composeTitle, composeBody, composeActions);
  document.body.append(composeImageInput);

  const scroll = document.createElement('div');
  scroll.className = 'keep-notes__scroll';

  const pinnedSection = document.createElement('section');
  pinnedSection.className = 'keep-notes__section keep-notes__section--pinned';
  pinnedSection.hidden = true;

  const pinnedLabel = document.createElement('h3');
  pinnedLabel.className = 'keep-notes__section-label';
  pinnedLabel.textContent = 'Pinned';

  const pinnedGrid = document.createElement('div');
  pinnedGrid.className = 'keep-notes__grid';
  pinnedSection.append(pinnedLabel, pinnedGrid);

  const othersSection = document.createElement('section');
  othersSection.className = 'keep-notes__section';

  const othersGrid = document.createElement('div');
  othersGrid.className = 'keep-notes__grid';
  othersSection.append(othersGrid);

  const empty = document.createElement('p');
  empty.className = 'keep-notes__empty muted';
  empty.hidden = true;
  empty.textContent = 'No notes yet — jot something above.';

  scroll.append(pinnedSection, othersSection, empty);

  const selectBar = document.createElement('div');
  selectBar.className = 'keep-notes__select-bar';
  selectBar.hidden = true;

  const selectCount = document.createElement('span');
  selectCount.className = 'keep-notes__select-count';

  const archiveSelectedBtn = document.createElement('button');
  archiveSelectedBtn.type = 'button';
  archiveSelectedBtn.className = 'keep-notes__btn keep-notes__btn--ghost';
  archiveSelectedBtn.textContent = 'Archive';

  const deleteSelectedBtn = document.createElement('button');
  deleteSelectedBtn.type = 'button';
  deleteSelectedBtn.className = 'keep-notes__btn keep-notes__btn--danger-text';
  deleteSelectedBtn.textContent = 'Delete';

  const cancelSelectBtn = document.createElement('button');
  cancelSelectBtn.type = 'button';
  cancelSelectBtn.className = 'keep-notes__btn keep-notes__btn--ghost';
  cancelSelectBtn.textContent = 'Cancel';

  selectBar.append(selectCount, archiveSelectedBtn, deleteSelectedBtn, cancelSelectBtn);

  const status = document.createElement('p');
  status.className = 'keep-notes__status';
  status.hidden = true;
  status.setAttribute('aria-live', 'polite');

  shell.append(compose, selectBar, scroll, status);
  root.append(shell);

  /** @type {Array<object>} */
  let notes = [];
  /** @type {object | null} */
  let editingNote = null;
  /** @type {MediaRecorder | null} */
  let recorder = null;
  /** @type {Blob[]} */
  let recordChunks = [];
  /** @type {boolean} */
  let composePinned = false;
  /** @type {MediaRecorder | null} */
  let composeRecorder = null;
  /** @type {Blob[]} */
  let composeRecordChunks = [];
  /** @type {boolean} */
  let selectMode = false;
  /** @type {Set<string>} */
  const selectedIds = new Set();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let cardClickTimer = null;
  /** @type {boolean} */
  let noteDragActive = false;
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pendingDeletes = new Map();

  /**
   * @param {object} a
   * @param {object} b
   */
  function compareNotes(a, b) {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ao = typeof a.sortOrder === 'number' ? a.sortOrder : null;
    const bo = typeof b.sortOrder === 'number' ? b.sortOrder : null;
    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return -1;
    if (ao === null && bo !== null) return 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  }

  function sortNotes() {
    notes.sort(compareNotes);
  }

  /**
   * @param {HTMLElement} grid
   * @param {number} clientX
   * @param {number} clientY
   */
  function dragInsertBefore(grid, clientX, clientY) {
    const cards = [...grid.querySelectorAll('.keep-notes__card:not(.keep-notes__card--dragging)')];
    if (!cards.length) return null;

    let closest = null;
    let closestDist = Infinity;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = (clientX - cx) ** 2 + (clientY - cy) ** 2;
      if (dist < closestDist) {
        closestDist = dist;
        closest = { card, rect, cx, cy };
      }
    }
    if (!closest) return null;

    const { card, rect, cx, cy } = closest;
    const onSameRow = clientY >= rect.top && clientY <= rect.bottom;
    const insertBefore = onSameRow ? clientX < cx : clientY < cy;
    return insertBefore ? card : card.nextElementSibling;
  }

  /**
   * @param {HTMLElement} grid
   */
  function wireGridDragDrop(grid) {
    grid.addEventListener('dragover', (e) => {
      if (selectMode) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const dragging = grid.querySelector('.keep-notes__card--dragging');
      if (!dragging) return;
      const before = dragInsertBefore(grid, e.clientX, e.clientY);
      if (before) grid.insertBefore(dragging, before);
      else grid.append(dragging);
    });
    grid.addEventListener('drop', (e) => {
      if (selectMode) return;
      e.preventDefault();
    });
  }

  async function persistNoteOrder() {
    const pinnedIds = [...pinnedGrid.querySelectorAll('.keep-notes__card')].map((c) => c.dataset.id).filter(Boolean);
    const othersIds = [...othersGrid.querySelectorAll('.keep-notes__card')].map((c) => c.dataset.id).filter(Boolean);
    const expectedPinned = notes.filter((n) => n.pinned).sort(compareNotes).map((n) => n.id);
    const expectedOthers = notes.filter((n) => !n.pinned).sort(compareNotes).map((n) => n.id);
    if (pinnedIds.join('|') === expectedPinned.join('|') && othersIds.join('|') === expectedOthers.join('|')) {
      renderNotes();
      return;
    }
    pinnedIds.forEach((id, i) => {
      const note = notes.find((n) => n.id === id);
      if (note) note.sortOrder = i;
    });
    othersIds.forEach((id, i) => {
      const note = notes.find((n) => n.id === id);
      if (note) note.sortOrder = i;
    });
    sortNotes();
    try {
      const r = await fetch('/api/keep-notes/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: pinnedIds, others: othersIds }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'reorder failed');
      notes = Array.isArray(data.notes) ? data.notes : notes;
      renderNotes();
    } catch (e) {
      showStatus(String(e?.message || e), true);
      void loadNotes();
    }
  }

  function syncCardDraggables() {
    root.querySelectorAll('.keep-notes__card-drag').forEach((handle) => {
      handle.draggable = !selectMode;
    });
  }

  /**
   * @param {string} id
   */
  function setCardSelected(id, on) {
    if (on) selectedIds.add(id);
    else selectedIds.delete(id);
    const card = root.querySelector(`.keep-notes__card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.toggle('keep-notes__card--selected', on);
    const check = card.querySelector('.keep-notes__card-check');
    if (check) check.checked = on;
  }

  function syncSelectBar() {
    const n = selectedIds.size;
    selectBar.hidden = !selectMode;
    root.classList.toggle('keep-notes--select-mode', selectMode);
    selectCount.textContent = n === 1 ? '1 selected' : `${n} selected`;
    archiveSelectedBtn.disabled = n === 0;
    deleteSelectedBtn.disabled = n === 0;
    syncCardDraggables();
  }

  /**
   * @param {string} id
   */
  function enterSelectMode(id) {
    if (!selectMode) {
      selectMode = true;
      closeEditor();
    }
    setCardSelected(id, true);
    syncSelectBar();
  }

  function exitSelectMode() {
    selectMode = false;
    for (const id of [...selectedIds]) setCardSelected(id, false);
    selectedIds.clear();
    syncSelectBar();
  }

  /**
   * @param {string} id
   */
  function toggleSelected(id) {
    setCardSelected(id, !selectedIds.has(id));
    syncSelectBar();
    if (selectedIds.size === 0) selectMode = false;
  }

  async function bulkAction(action) {
    const ids = [...selectedIds];
    if (!ids.length) return;
    if (action === 'delete') {
      const label = ids.length === 1 ? 'Delete this note?' : `Delete ${ids.length} notes?`;
      if (!window.confirm(label)) return;
    }
    archiveSelectedBtn.disabled = true;
    deleteSelectedBtn.disabled = true;
    try {
      const r = await fetch('/api/keep-notes/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || `${action} failed`);
      const affected = new Set(Array.isArray(data.affected) ? data.affected : []);
      if (action === 'delete') {
        notes = notes.filter((n) => !affected.has(n.id));
      } else {
        notes = notes.filter((n) => !affected.has(n.id));
      }
      exitSelectMode();
      renderNotes();
      const n = affected.size;
      showStatus(action === 'delete' ? `Deleted ${n} note${n === 1 ? '' : 's'}` : `Archived ${n} note${n === 1 ? '' : 's'}`);
    } catch (e) {
      showStatus(String(e?.message || e), true);
    } finally {
      syncSelectBar();
    }
  }

  cancelSelectBtn.addEventListener('click', () => exitSelectMode());
  archiveSelectedBtn.addEventListener('click', () => void bulkAction('archive'));
  deleteSelectedBtn.addEventListener('click', () => void bulkAction('delete'));

  /**
   * @param {string} msg
   * @param {boolean} [err]
   */
  function showStatus(msg, err = false) {
    status.textContent = msg;
    status.hidden = !msg;
    status.classList.toggle('keep-notes__status--err', err);
  }

  /**
   * @param {object} note
   */
  function attachmentUrl(note) {
    if (!note?.attachment?.filename) return '';
    return `/api/keep-notes/${encodeURIComponent(note.id)}/attachment/${encodeURIComponent(note.attachment.filename)}`;
  }

  /**
   * @param {HTMLElement} card
   * @param {object} note
   */
  function fillCard(card, note) {
    card.dataset.id = note.id;
    card.classList.toggle('keep-notes__card--pinned', Boolean(note.pinned));
    card.classList.toggle('keep-notes__card--selected', selectedIds.has(note.id));

    const checkEl = card.querySelector('.keep-notes__card-check');
    const dragHandle = card.querySelector('.keep-notes__card-drag');
    const titleEl = card.querySelector('.keep-notes__card-title');
    const bodyEl = card.querySelector('.keep-notes__card-body');
    const mediaEl = card.querySelector('.keep-notes__card-media');
    const pinBtn = card.querySelector('.keep-notes__card-pin');

    if (checkEl) checkEl.checked = selectedIds.has(note.id);
    if (dragHandle) dragHandle.draggable = !selectMode;

    const title = String(note.title || '').trim();
    const body = String(note.body || '').trim();
    if (titleEl) {
      titleEl.textContent = title;
      titleEl.hidden = !title;
    }
    if (bodyEl) {
      bodyEl.textContent = body;
      bodyEl.hidden = !body;
    }
    if (pinBtn) {
      pinBtn.setAttribute('aria-pressed', note.pinned ? 'true' : 'false');
      pinBtn.title = note.pinned ? 'Unpin' : 'Pin';
    }
    if (mediaEl) {
      mediaEl.replaceChildren();
      mediaEl.hidden = !note.attachment;
      if (note.attachment?.type === 'image') {
        const img = document.createElement('img');
        img.className = 'keep-notes__card-img';
        img.alt = title || 'Note image';
        img.loading = 'lazy';
        img.src = attachmentUrl(note);
        mediaEl.append(img);
      } else if (note.attachment?.type === 'voice') {
        const audio = document.createElement('audio');
        audio.className = 'keep-notes__card-audio';
        audio.controls = true;
        audio.preload = 'none';
        audio.src = attachmentUrl(note);
        mediaEl.append(audio);
      }
    }
  }

  function createCard() {
    const card = document.createElement('article');
    card.className = 'keep-notes__card';
    card.tabIndex = 0;

    const checkEl = document.createElement('input');
    checkEl.type = 'checkbox';
    checkEl.className = 'keep-notes__card-check';
    checkEl.setAttribute('aria-label', 'Select note');
    checkEl.addEventListener('click', (e) => e.stopPropagation());
    checkEl.addEventListener('change', () => {
      if (!selectMode) enterSelectMode(card.dataset.id);
      else setCardSelected(card.dataset.id, checkEl.checked);
      syncSelectBar();
      if (selectedIds.size === 0) selectMode = false;
    });

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'keep-notes__card-pin';
    pinBtn.setAttribute('aria-label', 'Pin note');
    pinBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H8c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1.03-1 1.03 1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';

    const titleEl = document.createElement('h4');
    titleEl.className = 'keep-notes__card-title';

    const bodyEl = document.createElement('p');
    bodyEl.className = 'keep-notes__card-body';

    const mediaEl = document.createElement('div');
    mediaEl.className = 'keep-notes__card-media';
    mediaEl.hidden = true;

    const dragHandle = document.createElement('span');
    dragHandle.className = 'keep-notes__card-drag';
    dragHandle.draggable = true;
    dragHandle.title = 'Drag to reorder';
    dragHandle.setAttribute('aria-label', 'Drag to reorder');
    const grip = document.createElement('span');
    grip.className = 'keep-notes__card-grip';
    grip.setAttribute('aria-hidden', 'true');
    dragHandle.append(grip);

    card.append(checkEl, dragHandle, pinBtn, titleEl, bodyEl, mediaEl);

    dragHandle.addEventListener('dragstart', (e) => {
      if (selectMode) {
        e.preventDefault();
        return;
      }
      e.stopPropagation();
      noteDragActive = true;
      if (cardClickTimer) {
        clearTimeout(cardClickTimer);
        cardClickTimer = null;
      }
      card.classList.add('keep-notes__card--dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.id || '');
    });
    dragHandle.addEventListener('dragend', (e) => {
      e.stopPropagation();
      noteDragActive = false;
      card.classList.remove('keep-notes__card--dragging');
      if (!selectMode) void persistNoteOrder();
    });
    dragHandle.addEventListener('mousedown', (e) => e.stopPropagation());
    dragHandle.addEventListener('click', (e) => e.stopPropagation());

    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void togglePin(card.dataset.id);
    });
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      if (noteDragActive) return;
      if (pendingDeletes.has(id)) return;
      if (selectMode) {
        toggleSelected(id);
        return;
      }
      if (cardClickTimer) clearTimeout(cardClickTimer);
      cardClickTimer = setTimeout(() => {
        cardClickTimer = null;
        openEditor(id);
      }, 220);
    });
    card.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (cardClickTimer) {
        clearTimeout(cardClickTimer);
        cardClickTimer = null;
      }
      enterSelectMode(card.dataset.id);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (selectMode) toggleSelected(card.dataset.id);
        else openEditor(card.dataset.id);
      }
    });

    return card;
  }

  function renderNotes() {
    pinnedGrid.replaceChildren();
    othersGrid.replaceChildren();
    sortNotes();
    const pinned = notes.filter((n) => n.pinned);
    const others = notes.filter((n) => !n.pinned);
    pinnedSection.hidden = pinned.length === 0;
    empty.hidden = notes.length > 0;

    for (const note of pinned) {
      const card = createCard();
      fillCard(card, note);
      pinnedGrid.append(card);
    }
    for (const note of others) {
      const card = createCard();
      fillCard(card, note);
      othersGrid.append(card);
    }
    for (const id of pendingDeletes.keys()) markCardPendingDelete(id);
    syncSelectBar();
  }

  /**
   * @param {string} id
   */
  function markCardPendingDelete(id) {
    const card = root.querySelector(`.keep-notes__card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add('keep-notes__card--pending-delete');
    if (card.querySelector('.keep-notes__card-undo')) return;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'keep-notes__btn keep-notes__card-undo';
    undo.textContent = 'Undo';
    undo.setAttribute('aria-label', 'Undo delete');
    undo.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelPendingDelete(id);
    });
    card.append(undo);
  }

  /**
   * @param {string} id
   */
  function beginPendingDelete(id) {
    if (pendingDeletes.has(id)) return;
    const timer = setTimeout(() => {
      void performDelete(id);
    }, 3000);
    pendingDeletes.set(id, timer);
    markCardPendingDelete(id);
  }

  /**
   * @param {string} id
   */
  function cancelPendingDelete(id) {
    const timer = pendingDeletes.get(id);
    if (timer) clearTimeout(timer);
    pendingDeletes.delete(id);
    const card = root.querySelector(`.keep-notes__card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.remove('keep-notes__card--pending-delete');
    card.querySelector('.keep-notes__card-undo')?.remove();
  }

  /**
   * @param {string} id
   */
  async function performDelete(id) {
    if (!pendingDeletes.has(id)) return;
    pendingDeletes.delete(id);
    try {
      const r = await fetch(`/api/keep-notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'delete failed');
      notes = notes.filter((n) => n.id !== id);
      renderNotes();
    } catch (err) {
      showStatus(String(err?.message || err), true);
      cancelPendingDelete(id);
    }
  }

  async function loadNotes() {
    try {
      const r = await fetch('/api/keep-notes', { cache: 'no-store' });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'load failed');
      notes = Array.isArray(data.notes) ? data.notes : [];
      renderNotes();
    } catch (e) {
      showStatus(String(e?.message || e), true);
    }
  }

  /**
   * @param {string} id
   */
  async function togglePin(id) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    try {
      const r = await fetch(`/api/keep-notes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !note.pinned }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'pin failed');
      notes = notes.map((n) => (n.id === id ? data.note : n));
      sortNotes();
      renderNotes();
    } catch (e) {
      showStatus(String(e?.message || e), true);
    }
  }

  /**
   * @param {Blob} file
   * @returns {Promise<string>}
   */
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(/** @type {string} */ (reader.result));
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * @param {{ title?: string, body?: string, pinned?: boolean }} fields
   * @returns {Promise<object>}
   */
  async function createNote(fields) {
    const r = await fetch('/api/keep-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'create failed');
    notes.push(data.note);
    sortNotes();
    return data.note;
  }

  /**
   * @param {string} noteId
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async function uploadAttachment(noteId, payload) {
    const r = await fetch(`/api/keep-notes/${encodeURIComponent(noteId)}/attachment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'upload failed');
    notes = notes.map((n) => (n.id === data.note.id ? data.note : n));
    if (editingNote?.id === noteId) {
      editingNote = data.note;
      renderEditorMedia(data.note);
    }
    return data.note;
  }

  function resetCompose() {
    composeTitle.value = '';
    composeBody.value = '';
    composePinned = false;
    composePinBtn.setAttribute('aria-pressed', 'false');
    composePinBtn.title = 'Pin';
    composePinBtn.setAttribute('aria-label', 'Pin');
    composeVoiceBtn.classList.remove('keep-notes__btn--recording');
    composeVoiceBtn.title = 'Record voice note';
    expandCompose(false);
  }

  function expandCompose(on) {
    compose.classList.toggle('keep-notes__compose--expanded', on);
    composeActions.hidden = !on;
  }

  composeBody.addEventListener('focus', () => {
    expandCompose(true);
    queueMicrotask(() => {
      if (document.activeElement !== composeBody) composeBody.focus();
    });
  });
  composeTitle.addEventListener('focus', () => expandCompose(true));
  composeClose.addEventListener('click', (e) => {
    e.stopPropagation();
    if (composeRecorder && composeRecorder.state !== 'inactive') composeRecorder.stop();
    composeBody.blur();
    resetCompose();
  });

  composePinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    composePinned = !composePinned;
    composePinBtn.setAttribute('aria-pressed', composePinned ? 'true' : 'false');
    composePinBtn.title = composePinned ? 'Unpin' : 'Pin';
    composePinBtn.setAttribute('aria-label', composePinned ? 'Unpin' : 'Pin');
  });

  composeImageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    expandCompose(true);
    composeImageInput.click();
  });

  composeImageInput.addEventListener('change', async () => {
    const file = composeImageInput.files?.[0];
    composeImageInput.value = '';
    if (!file) return;
    if (file.size > 8_000_000) {
      showStatus('Image too large (max 8 MB)', true);
      return;
    }
    composeImageBtn.disabled = true;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const note = await createNote({
        title: composeTitle.value.trim(),
        body: composeBody.value.trim(),
        pinned: composePinned,
      });
      await uploadAttachment(note.id, {
        kind: 'image',
        dataUrl,
        mimeType: file.type,
        filename: file.name,
      });
      renderNotes();
      resetCompose();
      showStatus('');
    } catch (e) {
      showStatus(String(e?.message || e), true);
    } finally {
      composeImageBtn.disabled = false;
    }
  });

  composeVoiceBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (composeRecorder && composeRecorder.state === 'recording') {
      composeRecorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      showStatus('Microphone not available in this browser', true);
      return;
    }
    expandCompose(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      composeRecordChunks = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      composeRecorder = new MediaRecorder(stream, { mimeType });
      composeRecorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) composeRecordChunks.push(ev.data);
      };
      composeRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        composeVoiceBtn.classList.remove('keep-notes__btn--recording');
        composeVoiceBtn.title = 'Record voice note';
        const blob = new Blob(composeRecordChunks, { type: composeRecorder?.mimeType || 'audio/webm' });
        composeRecorder = null;
        if (blob.size === 0) return;
        try {
          const dataUrl = await readFileAsDataUrl(blob);
          const note = await createNote({
            title: composeTitle.value.trim(),
            body: composeBody.value.trim(),
            pinned: composePinned,
          });
          await uploadAttachment(note.id, {
            kind: 'voice',
            dataUrl,
            mimeType: blob.type || 'audio/webm',
          });
          renderNotes();
          resetCompose();
          showStatus('Voice note saved');
        } catch (err) {
          showStatus(String(err?.message || err), true);
        }
      };
      composeRecorder.start();
      composeVoiceBtn.classList.add('keep-notes__btn--recording');
      composeVoiceBtn.title = 'Stop recording';
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  composeSave.addEventListener('click', async () => {
    const title = composeTitle.value.trim();
    const body = composeBody.value.trim();
    if (!title && !body) return;
    composeSave.disabled = true;
    try {
      await createNote({ title, body, pinned: composePinned });
      renderNotes();
      resetCompose();
      showStatus('');
    } catch (e) {
      showStatus(String(e?.message || e), true);
    } finally {
      composeSave.disabled = false;
    }
  });

  /** Editor overlay — portaled to body so fixed positioning isn't clipped. */
  const overlay = document.createElement('div');
  overlay.className = 'keep-notes__overlay';
  overlay.hidden = true;

  const editor = document.createElement('div');
  editor.className = 'keep-notes__editor';
  editor.setAttribute('role', 'dialog');
  editor.setAttribute('aria-modal', 'true');
  editor.setAttribute('aria-label', 'Edit note');

  const editorTitle = document.createElement('input');
  editorTitle.type = 'text';
  editorTitle.className = 'keep-notes__editor-title';
  editorTitle.placeholder = 'Title';
  editorTitle.maxLength = 200;

  const editorBody = document.createElement('textarea');
  editorBody.className = 'keep-notes__editor-body';
  editorBody.placeholder = 'Note';
  editorBody.maxLength = 20000;

  const editorMedia = document.createElement('div');
  editorMedia.className = 'keep-notes__editor-media';
  editorMedia.hidden = true;

  const editorToolbar = document.createElement('div');
  editorToolbar.className = 'keep-notes__editor-toolbar';

  const pinEditorBtn = document.createElement('button');
  pinEditorBtn.type = 'button';
  pinEditorBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  pinEditorBtn.title = 'Pin';
  pinEditorBtn.setAttribute('aria-label', 'Pin');
  pinEditorBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H8c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1.03-1 1.03 1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';

  const imageInput = document.createElement('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
  imageInput.hidden = true;

  const imageBtn = document.createElement('button');
  imageBtn.type = 'button';
  imageBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  imageBtn.title = 'Add image';
  imageBtn.setAttribute('aria-label', 'Add image');
  imageBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>';

  const voiceBtn = document.createElement('button');
  voiceBtn.type = 'button';
  voiceBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  voiceBtn.title = 'Record voice note';
  voiceBtn.setAttribute('aria-label', 'Record voice note');
  voiceBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';

  const removeAttBtn = document.createElement('button');
  removeAttBtn.type = 'button';
  removeAttBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  removeAttBtn.title = 'Remove attachment';
  removeAttBtn.setAttribute('aria-label', 'Remove attachment');
  removeAttBtn.hidden = true;
  removeAttBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'keep-notes__btn keep-notes__btn--icon keep-notes__btn--danger';
  deleteBtn.title = 'Delete';
  deleteBtn.setAttribute('aria-label', 'Delete note');
  deleteBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

  const closeEditorBtn = document.createElement('button');
  closeEditorBtn.type = 'button';
  closeEditorBtn.className = 'keep-notes__btn keep-notes__btn--ghost';
  closeEditorBtn.textContent = 'Close';

  editorToolbar.append(pinEditorBtn, imageBtn, voiceBtn, removeAttBtn, deleteBtn, closeEditorBtn);
  editor.append(editorTitle, editorBody, editorMedia, editorToolbar);
  overlay.append(editor);
  document.body.append(overlay);
  document.body.append(imageInput);

  editor.addEventListener('click', (e) => e.stopPropagation());

  /**
   * @param {{ pinned?: boolean } | null | undefined} note
   */
  function syncPinEditorBtn(note) {
    const pinned = Boolean(note?.pinned);
    pinEditorBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    pinEditorBtn.title = pinned ? 'Unpin' : 'Pin';
    pinEditorBtn.setAttribute('aria-label', pinned ? 'Unpin' : 'Pin');
  }

  /**
   * @param {object | null} note
   */
  function renderEditorMedia(note) {
    editorMedia.replaceChildren();
    editorMedia.hidden = !note?.attachment;
    removeAttBtn.hidden = !note?.attachment;
    if (!note?.attachment) return;
    if (note.attachment.type === 'image') {
      const img = document.createElement('img');
      img.className = 'keep-notes__editor-img';
      img.alt = note.title || 'Attachment';
      img.src = attachmentUrl(note);
      editorMedia.append(img);
    } else {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.className = 'keep-notes__editor-audio';
      audio.src = attachmentUrl(note);
      editorMedia.append(audio);
    }
  }

  /**
   * @param {string} id
   */
  function openEditor(id) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    editingNote = note;
    editorTitle.value = note.title || '';
    editorBody.value = note.body || '';
    syncPinEditorBtn(note);
    renderEditorMedia(note);
    overlay.hidden = false;
    editorBody.focus();
  }

  function closeEditor() {
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    voiceBtn.classList.remove('keep-notes__btn--recording');
    editingNote = null;
    overlay.hidden = true;
  }

  /**
   * @param {string} id
   * @param {string} title
   * @param {string} body
   */
  async function persistNote(id, title, body) {
    try {
      const r = await fetch(`/api/keep-notes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'save failed');
      notes = notes.map((n) => (n.id === id ? data.note : n));
      sortNotes();
      renderNotes();
      return data.note;
    } catch (e) {
      showStatus(String(e?.message || e), true);
      return null;
    }
  }

  function dismissEditor() {
    if (!editingNote) return;
    const { id } = editingNote;
    const title = editorTitle.value.trim();
    const body = editorBody.value;
    closeEditor();
    void persistNote(id, title, body);
  }

  closeEditorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissEditor();
  });

  overlay.addEventListener('click', () => {
    dismissEditor();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (selectMode) {
      e.preventDefault();
      exitSelectMode();
      return;
    }
    if (overlay.hidden) return;
    e.preventDefault();
    dismissEditor();
  });

  /**
   * @returns {Promise<object | null>}
   */
  async function saveEditor() {
    if (!editingNote) return null;
    const id = editingNote.id;
    const title = editorTitle.value.trim();
    const body = editorBody.value;
    const saved = await persistNote(id, title, body);
    if (saved) editingNote = saved;
    return saved;
  }

  pinEditorBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!editingNote) return;
    const noteId = editingNote.id;
    await saveEditor();
    await togglePin(noteId);
    const refreshed = notes.find((n) => n.id === noteId);
    if (refreshed && editingNote?.id === noteId) {
      editingNote = refreshed;
    }
    syncPinEditorBtn(refreshed);
  });

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!editingNote) return;
    const noteId = editingNote.id;
    closeEditor();
    beginPendingDelete(noteId);
  });

  imageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    imageInput.click();
  });

  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    imageInput.value = '';
    if (!file || !editingNote) return;
    const noteId = editingNote.id;
    if (file.size > 8_000_000) {
      showStatus('Image too large (max 8 MB)', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await persistNote(noteId, editorTitle.value.trim(), editorBody.value);
        const r = await fetch(`/api/keep-notes/${encodeURIComponent(noteId)}/attachment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'image',
            dataUrl: reader.result,
            mimeType: file.type,
            filename: file.name,
          }),
        });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || 'upload failed');
        notes = notes.map((n) => (n.id === data.note.id ? data.note : n));
        if (editingNote?.id === noteId) {
          editingNote = data.note;
          renderEditorMedia(data.note);
        }
        renderNotes();
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    };
    reader.readAsDataURL(file);
  });

  removeAttBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!editingNote?.attachment) return;
    const noteId = editingNote.id;
    try {
      const r = await fetch(`/api/keep-notes/${encodeURIComponent(noteId)}/attachment`, {
        method: 'DELETE',
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'remove failed');
      notes = notes.map((n) => (n.id === data.note.id ? data.note : n));
      if (editingNote?.id === noteId) {
        editingNote = data.note;
        renderEditorMedia(data.note);
      }
      renderNotes();
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  /**
   * @param {Blob} blob
   * @param {string} noteId
   */
  async function uploadVoice(blob, noteId) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await persistNote(noteId, editorTitle.value.trim(), editorBody.value);
        const r = await fetch(`/api/keep-notes/${encodeURIComponent(noteId)}/attachment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'voice',
            dataUrl: reader.result,
            mimeType: blob.type || 'audio/webm',
          }),
        });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || 'voice upload failed');
        notes = notes.map((n) => (n.id === data.note.id ? data.note : n));
        if (editingNote?.id === noteId) {
          editingNote = data.note;
          renderEditorMedia(data.note);
        }
        renderNotes();
        showStatus('Voice note saved');
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    };
    reader.readAsDataURL(blob);
  }

  voiceBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!editingNote) return;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      showStatus('Microphone not available in this browser', true);
      return;
    }
    const noteId = editingNote.id;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordChunks = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordChunks.push(ev.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        voiceBtn.classList.remove('keep-notes__btn--recording');
        voiceBtn.title = 'Record voice note';
        const blob = new Blob(recordChunks, { type: recorder?.mimeType || 'audio/webm' });
        if (blob.size > 0) void uploadVoice(blob, noteId);
        recorder = null;
      };
      recorder.start();
      voiceBtn.classList.add('keep-notes__btn--recording');
      voiceBtn.title = 'Stop recording';
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  wireGridDragDrop(pinnedGrid);
  wireGridDragDrop(othersGrid);

  void loadNotes();
}
