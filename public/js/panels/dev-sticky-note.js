/**
 * Floating DEV REQUEST panel — structured change requests for Cursor agents.
 * Saves to data/dev-requests/<folder>/ with optional screenshots.
 */
import { loadDevSticky, saveDevSticky } from '../lib/dev-sticky-storage.js';
import { buildDevRequestForm } from '../lib/dev-request-form.js';

const PANEL_WIDTH = 280;
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
  return clampPosition(window.innerWidth - PANEL_WIDTH - 24, 96);
}

/**
 * @param {number} x
 * @param {number} y
 */
function clampPosition(x, y) {
  const maxX = Math.max(8, window.innerWidth - PANEL_WIDTH - 8);
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
  if (collapsed) {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
  }
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
}

/**
 * Mount once on document.body (fixed overlay).
 */
export function mountDevStickyNote() {
  if (document.getElementById('dashbird-dev-sticky')) return;

  let pageId = currentPageId();
  /** @type {import('../lib/dev-sticky-storage.js').DevStickyState} */
  let state = loadSticky(pageId);
  /** @type {ReturnType<typeof setTimeout> | null} */
  let toastTimer = null;

  /** @type {{ pointerId: number, startX: number, startY: number, origX: number, origY: number } | null} */
  let drag = null;

  const root = document.createElement('div');
  root.id = 'dashbird-dev-sticky';
  root.className = 'dev-sticky-note dev-sticky-note--requests';
  root.setAttribute('role', 'complementary');
  root.setAttribute('aria-label', 'Dev requests');
  document.body.append(root);

  const header = document.createElement('div');
  header.className = 'dev-sticky-note__header';

  const dragHandle = document.createElement('div');
  dragHandle.className = 'dev-sticky-note__drag';
  const title = document.createElement('span');
  title.className = 'dev-sticky-note__title';
  title.textContent = 'DEV REQUEST';
  dragHandle.append(title);

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'dev-sticky-note__collapse';

  header.append(dragHandle, collapseBtn);

  const body = document.createElement('div');
  body.className = 'dev-sticky-note__body';

  const hint = document.createElement('p');
  hint.className = 'dev-sticky-note__hint';
  hint.textContent = 'Saved to data/dev-requests/ for Cursor agents.';

  const form = buildDevRequestForm({
    platform: 'desktop',
    onSubmit: (result) => {
      if (result?.ok === false) {
        showToast(result.error || 'Submit failed', false);
        return;
      }
      showToast('Saved to dev-requests inbox', true);
    },
  });

  const toastEl = document.createElement('div');
  toastEl.className = 'dev-sticky-note__toast';
  toastEl.hidden = true;

  body.append(hint, form);
  root.append(header, body, toastEl);

  function persist() {
    saveSticky(pageId, state);
  }

  function applyLayout() {
    root.style.left = `${state.x}px`;
    root.style.top = `${state.y}px`;
    root.style.width = `${PANEL_WIDTH}px`;
    root.classList.toggle('dev-sticky-note--collapsed', state.collapsed);
    body.hidden = state.collapsed;
    header.classList.toggle('dev-sticky-note__header--collapsed', state.collapsed);
    collapseBtn.setAttribute('aria-label', state.collapsed ? 'Expand dev request' : 'Collapse dev request');
    collapseBtn.innerHTML = chevronSvg(state.collapsed);
  }

  /**
   * @param {string} msg
   * @param {boolean} ok
   */
  function showToast(msg, ok) {
    toastEl.hidden = false;
    toastEl.textContent = msg;
    toastEl.classList.toggle('dev-sticky-note__toast--ok', ok);
    toastEl.classList.toggle('dev-sticky-note__toast--err', !ok);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 4000);
  }

  function switchPage(nextId) {
    if (nextId === pageId) return;
    saveSticky(pageId, state);
    pageId = nextId;
    state = loadSticky(pageId);
    applyLayout();
  }

  applyLayout();

  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state = { ...state, collapsed: !state.collapsed };
    persist();
    applyLayout();
  });

  collapseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

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

  window.addEventListener('pagehide', () => saveSticky(pageId, state));
  window.addEventListener('resize', () => {
    state = { ...state, ...clampPosition(state.x, state.y) };
    persist();
    applyLayout();
  });

  window.addEventListener('storage', (e) => {
    if (e.key === LS_PAGE_KEY && e.newValue) switchPage(currentPageId());
  });
  document.addEventListener('dashbird:page', (e) => {
    const next = e?.detail?.page;
    if (typeof next === 'string') switchPage(next);
  });
}
