/** Shared view-mode helpers (desktop | mobile). */

export const VIEW_MODE_KEY = 'dashbirdView';

/**
 * Best-effort phone / tablet detection for first visit (before an explicit pick).
 * @returns {boolean}
 */
export function detectMobileDevice() {
  try {
    if (typeof navigator !== 'undefined') {
      const ua = String(navigator.userAgent || '');
      if (/Android|iPhone|iPod|iPad|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
        return true;
      }
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      if (window.matchMedia('(max-width: 820px)').matches) return true;
      if (window.matchMedia('(pointer: coarse) and (max-width: 1024px)').matches) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Explicit icon pick wins; otherwise auto-pick mobile on phones.
 * @returns {'mobile' | 'desktop'}
 */
export function readViewMode() {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if (v === 'mobile' || v === 'desktop') return v;
  } catch {
    /* ignore */
  }
  return detectMobileDevice() ? 'mobile' : 'desktop';
}

/**
 * @param {'mobile' | 'desktop'} mode
 */
export function writeViewMode(mode) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode === 'mobile' ? 'mobile' : 'desktop');
  } catch {
    /* ignore */
  }
}

export function isMobileView() {
  return readViewMode() === 'mobile';
}
