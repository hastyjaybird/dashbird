/**
 * Floating DEV NOTES sticky — same behavior as climate-dash DevStickyNote.
 * Per-page localStorage; Export appends tasks to data/dev-notes.md for Cursor agents.
 */
import { loadDevSticky, saveDevSticky } from '../lib/dev-sticky-storage.js';

const NOTE_WIDTH = 240;
const HEADER_HEIGHT = 28;
const LS_PAGE_KEY = 'dashbirdPage';

/** @returns {string} */
function currentPageId() {
  try {
    const p = localStorage.getItem(LS_PAGE_KEY);
    if (p === 'settings' || p === 'house-hunter' || p === 'network' || p === 'nrm') {
      return p === 'nrm' ? 'network' : p;
    }
  } catch {
    // ignore
  }
  return 'main';
}

function defaultPosition() {
  return clampPosition(window.innerWidth - NOTE_WIDTH - 24, 96);
}

/**
 * @param {number} x
 * @param {number} y
 */
function clampPosition(x, y) {
  const maxX = Math.max(8, window.innerWidth - NOTE_WIDTH - 8);
  const maxY = Math.max(56, window.innerHeight - HEADER_HEIGHT - 48);
  return {
    x: Math.max(8, Math.min(x, maxX)),
    y: Math.max(56, Math.min(y, maxY)),
  };
}

/**
 * @param {string} pageId
 */
function loadSticky(pageId) {
  return loadDevSticky(pageId, defaultPosition, clampPosition);
}

/**
 * @param {string} pageId
 * @param {import('../lib/dev-sticky-storage.js').DevStickyState} state
 */
function saveSticky(pageId, state) {
  saveDevSticky(pageId, state);
}

function chevronSvg(collapsed) {
  // climate-dash: ChevronRight when collapsed, ChevronDown when open
  if (collapsed) {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
  }
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
}

function uploadSvg() {
  return `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>`;
}

/**
 * Mount once on document.body (fixed overlay).
 */
export function mountDevStickyNote() {
  if (document.getElementById('dashbird-dev-sticky')) return;

  let pageId = currentPageId();
  /** @type {import('../lib/dev-sticky-storage.js').DevStickyState} */
  let state = loadSticky(pageId);
  let exporting = false;
  /** @type {string | null} */
  let toast = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let toastTimer = null;

  /** @type {{ pointerId: number, startX: number, startY: number, origX: number, origY: number } | null} */
  let drag = null;

  const root = document.createElement('div');
  root.id = 'dashbird-dev-sticky';
  root.className = 'dev-sticky-note';
  root.setAttribute('role', 'complementary');
  root.setAttribute('aria-label', 'Dev notes');
  document.body.append(root);

  const header = document.createElement('div');
  header.className = 'dev-sticky-note__header';

  const dragHandle = document.createElement('div');
  dragHandle.className = 'dev-sticky-note__drag';
  const title = document.createElement('span');
  title.className = 'dev-sticky-note__title';
  title.textContent = 'DEV NOTES';
  dragHandle.append(title);

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'dev-sticky-note__collapse';

  header.append(dragHandle, collapseBtn);

  const body = document.createElement('div');
  body.className = 'dev-sticky-note__body';

  const textarea = document.createElement('textarea');
  textarea.className = 'dev-sticky-note__textarea';
  textarea.placeholder = 'Changes & ideas for this page…';
  textarea.spellcheck = true;

  const footer = document.createElement('div');
  footer.className = 'dev-sticky-note__footer';

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'dev-sticky-note__export';
  exportBtn.innerHTML = `${uploadSvg()}<span>Export</span>`;

  footer.append(exportBtn);
  body.append(textarea, footer);

  const toastEl = document.createElement('div');
  toastEl.className = 'dev-sticky-note__toast';
  toastEl.hidden = true;

  root.append(header, body, toastEl);

  function flushSave(id = pageId) {
    saveSticky(id, state);
  }

  function persist() {
    saveSticky(pageId, state);
  }

  function applyLayout() {
    root.style.left = `${state.x}px`;
    root.style.top = `${state.y}px`;
    root.classList.toggle('dev-sticky-note--collapsed', state.collapsed);
    body.hidden = state.collapsed;
    header.classList.toggle('dev-sticky-note__header--collapsed', state.collapsed);
    collapseBtn.setAttribute('aria-label', state.collapsed ? 'Expand notes' : 'Collapse notes');
    collapseBtn.innerHTML = chevronSvg(state.collapsed);
  }

  function applyContent() {
    if (textarea.value !== state.content) textarea.value = state.content;
    const empty = !state.content.trim();
    exportBtn.disabled = exporting || empty;
    exportBtn.classList.toggle('dev-sticky-note__export--busy', exporting);
    const label = exportBtn.querySelector('span');
    if (label) label.textContent = exporting ? 'Exporting…' : 'Export';
  }

  function showToast(msg) {
    toast = msg;
    toastEl.hidden = false;
    toastEl.textContent = msg;
    toastEl.classList.toggle('dev-sticky-note__toast--ok', msg.startsWith('Exported'));
    toastEl.classList.toggle('dev-sticky-note__toast--err', !msg.startsWith('Exported'));
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast = null;
      toastEl.hidden = true;
    }, 4000);
  }

  function switchPage(nextId) {
    if (nextId === pageId) return;
    flushSave(pageId);
    pageId = nextId;
    state = loadSticky(pageId);
    applyLayout();
    applyContent();
  }

  applyLayout();
  applyContent();

  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state = { ...state, collapsed: !state.collapsed };
    persist();
    applyLayout();
  });

  textarea.addEventListener('input', () => {
    state = { ...state, content: textarea.value };
    persist();
    applyContent();
  });

  exportBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  collapseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

  exportBtn.addEventListener('click', async () => {
    if (exporting || !state.content.trim()) return;
    exporting = true;
    applyContent();
    try {
      const r = await fetch('/api/dev-notes/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId, content: state.content }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        showToast(data.error || 'Export failed');
        return;
      }
      state = { ...state, content: '' };
      persist();
      applyContent();
      showToast(`Exported to ${data.title || 'dev notes'}`);
    } catch (e) {
      showToast(String(e?.message || e || 'Export failed'));
    } finally {
      exporting = false;
      applyContent();
    }
  });

  dragHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: state.x,
      origY: state.y,
    };
    dragHandle.setPointerCapture(e.pointerId);
  });

  dragHandle.addEventListener('pointermove', (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const pos = clampPosition(drag.origX + (e.clientX - drag.startX), drag.origY + (e.clientY - drag.startY));
    state = { ...state, ...pos };
    applyLayout();
  });

  function endDrag(e) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag = null;
    try {
      dragHandle.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    persist();
  }

  dragHandle.addEventListener('pointerup', endDrag);
  dragHandle.addEventListener('pointercancel', endDrag);

  window.addEventListener('pagehide', () => flushSave());
  window.addEventListener('resize', () => {
    state = { ...state, ...clampPosition(state.x, state.y) };
    persist();
    applyLayout();
  });

  // Follow dashbird page tabs.
  window.addEventListener('storage', (e) => {
    if (e.key === LS_PAGE_KEY && e.newValue) switchPage(currentPageId());
  });
  document.addEventListener('dashbird:page', (e) => {
    const next = e?.detail?.page;
    if (typeof next === 'string') switchPage(next);
  });
}
