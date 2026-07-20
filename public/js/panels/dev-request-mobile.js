/**
 * Mobile dev request — FAB + bottom sheet (same store as desktop).
 */
import { buildDevRequestForm } from '../lib/dev-request-form.js';

/**
 * Mount floating dev request entry on mobile shell.
 */
export function mountDevRequestMobile() {
  if (document.getElementById('dashbird-dev-request-mobile')) return;

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.id = 'dashbird-dev-request-mobile';
  fab.className = 'dev-request-mobile-fab';
  fab.setAttribute('aria-label', 'Submit dev request');
  fab.textContent = 'Dev';

  const backdrop = document.createElement('div');
  backdrop.className = 'dev-request-mobile-backdrop';
  backdrop.hidden = true;

  const sheet = document.createElement('div');
  sheet.className = 'dev-request-mobile-sheet';
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Dev request');

  const sheetHeader = document.createElement('div');
  sheetHeader.className = 'dev-request-mobile-sheet__header';

  const sheetTitle = document.createElement('h2');
  sheetTitle.className = 'dev-request-mobile-sheet__title';
  sheetTitle.textContent = 'Dev request';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dev-request-mobile-sheet__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';

  sheetHeader.append(sheetTitle, closeBtn);

  const sheetHint = document.createElement('p');
  sheetHint.className = 'dev-request-mobile-sheet__hint';
  sheetHint.textContent = 'Saved to data/dev-requests/ with screenshots for Cursor.';

  const toastEl = document.createElement('div');
  toastEl.className = 'dev-request-mobile-sheet__toast';
  toastEl.hidden = true;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let toastTimer = null;

  /**
   * @param {string} msg
   * @param {boolean} ok
   */
  function showToast(msg, ok = true) {
    toastEl.hidden = false;
    toastEl.textContent = msg;
    toastEl.classList.toggle('dev-request-mobile-sheet__toast--ok', ok);
    toastEl.classList.toggle('dev-request-mobile-sheet__toast--err', !ok);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 3500);
  }

  const form = buildDevRequestForm({
    platform: 'mobile',
    compact: true,
    onSubmit: (result) => {
      if (result?.ok === false) {
        showToast(result.error || 'Submit failed', false);
        return;
      }
      showToast('Saved to dev-requests inbox');
      setTimeout(closeSheet, 800);
    },
  });

  // Enlarge the consolidated description box on mobile — the default is cramped.
  const bodyInput = form.querySelector('.dev-request-form__textarea');
  if (bodyInput instanceof HTMLTextAreaElement) {
    bodyInput.rows = Math.max(bodyInput.rows, 6);
  }

  sheet.append(sheetHeader, sheetHint, form, toastEl);
  document.body.append(fab, backdrop, sheet);

  function openSheet() {
    backdrop.hidden = false;
    sheet.hidden = false;
    document.body.classList.add('dev-request-mobile-open');
  }

  function closeSheet() {
    backdrop.hidden = true;
    sheet.hidden = true;
    document.body.classList.remove('dev-request-mobile-open');
  }

  fab.addEventListener('click', openSheet);
  closeBtn.addEventListener('click', closeSheet);
  backdrop.addEventListener('click', closeSheet);
}
