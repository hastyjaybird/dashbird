/**
 * Persist panel payloads so repeat loads paint instantly, then refresh in the background.
 * Uses localStorage so data survives tab closes ("previous sessions").
 */

const PREFIX = 'dashbird-panel-v1:';

/**
 * @param {string} key
 * @param {number} [maxAgeMs]
 * @returns {unknown | null}
 */
export function readPanelCache(key, maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || j.at == null || !('payload' in j)) return null;
    if (Date.now() - Number(j.at) > maxAgeMs) return null;
    return j.payload;
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {unknown} payload
 */
export function writePanelCache(key, payload) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), payload }));
  } catch {
    /* quota / private mode */
  }
}

/**
 * @param {string} key
 */
export function clearPanelCache(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}
