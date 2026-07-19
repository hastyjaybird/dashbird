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
  compose.setAttribute('role', 'search');

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

  const composeActions = document.createElement('div');
  composeActions.className = 'keep-notes__compose-actions';
  composeActions.hidden = true;

  const composeClose = document.createElement('button');
  composeClose.type = 'button';
  composeClose.className = 'keep-notes__btn keep-notes__btn--ghost';
  composeClose.textContent = 'Close';

  const composeSave = document.createElement('button');
  composeSave.type = 'button';
  composeSave.className = 'keep-notes__btn keep-notes__btn--primary';
  composeSave.textContent = 'Add';

  composeActions.append(composeClose, composeSave);
  composeTitle.hidden = true;
  compose.append(composeTitle, composeBody, composeActions);

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

  const status = document.createElement('p');
  status.className = 'keep-notes__status';
  status.hidden = true;
  status.setAttribute('aria-live', 'polite');

  shell.append(compose, scroll, status);
  root.append(shell);

  /** @type {Array<object>} */
  let notes = [];
  /** @type {object | null} */
  let editingNote = null;
  /** @type {MediaRecorder | null} */
  let recorder = null;
  /** @type {Blob[]} */
  let recordChunks = [];

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

    const titleEl = card.querySelector('.keep-notes__card-title');
    const bodyEl = card.querySelector('.keep-notes__card-body');
    const mediaEl = card.querySelector('.keep-notes__card-media');
    const pinBtn = card.querySelector('.keep-notes__card-pin');

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

    card.append(pinBtn, titleEl, bodyEl, mediaEl);

    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void togglePin(card.dataset.id);
    });
    card.addEventListener('click', () => openEditor(card.dataset.id));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEditor(card.dataset.id);
      }
    });

    return card;
  }

  function renderNotes() {
    pinnedGrid.replaceChildren();
    othersGrid.replaceChildren();
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
      notes.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return String(b.updatedAt).localeCompare(String(a.updatedAt));
      });
      renderNotes();
    } catch (e) {
      showStatus(String(e?.message || e), true);
    }
  }

  function expandCompose(on) {
    compose.classList.toggle('keep-notes__compose--expanded', on);
    composeActions.hidden = !on;
    composeTitle.hidden = !on;
    if (on) composeTitle.focus();
  }

  composeBody.addEventListener('focus', () => expandCompose(true));
  composeClose.addEventListener('click', (e) => {
    e.stopPropagation();
    composeTitle.value = '';
    composeBody.value = '';
    composeBody.blur();
    expandCompose(false);
  });

  composeSave.addEventListener('click', async () => {
    const title = composeTitle.value.trim();
    const body = composeBody.value.trim();
    if (!title && !body) return;
    composeSave.disabled = true;
    try {
      const r = await fetch('/api/keep-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'create failed');
      notes.unshift(data.note);
      renderNotes();
      composeTitle.value = '';
      composeBody.value = '';
      expandCompose(false);
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
    editorTitle.focus();
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
      notes.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return String(b.updatedAt).localeCompare(String(a.updatedAt));
      });
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
    if (e.key !== 'Escape' || overlay.hidden) return;
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

  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!editingNote) return;
    const noteId = editingNote.id;
    if (!window.confirm('Delete this note?')) return;
    try {
      const r = await fetch(`/api/keep-notes/${encodeURIComponent(noteId)}`, {
        method: 'DELETE',
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'delete failed');
      notes = notes.filter((n) => n.id !== noteId);
      renderNotes();
      closeEditor();
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
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

  void loadNotes();
}
