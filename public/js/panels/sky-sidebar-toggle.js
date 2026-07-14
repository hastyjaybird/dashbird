/**
 * Hide / show the main-page right (sky) sidebar. Preference: localStorage.
 */

const STORAGE_KEY = 'dashbird-sky-sidebar-hidden';

function readHidden() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHidden(hidden) {
  try {
    localStorage.setItem(STORAGE_KEY, hidden ? '1' : '0');
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * @param {boolean} hidden
 * @param {HTMLButtonElement | null} btn
 */
function applyHidden(hidden, btn) {
  document.documentElement.classList.toggle('sky-sidebar-hidden', hidden);
  if (!btn) return;
  btn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  const label = hidden ? 'Show side widgets' : 'Hide side widgets';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/**
 * @param {HTMLButtonElement | null} btn
 */
export function mountSkySidebarToggle(btn) {
  if (!btn) return;
  applyHidden(readHidden(), btn);
  btn.addEventListener('click', () => {
    const next = !document.documentElement.classList.contains('sky-sidebar-hidden');
    writeHidden(next);
    applyHidden(next, btn);
  });
}
