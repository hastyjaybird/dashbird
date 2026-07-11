/** localStorage helpers for the floating DEV NOTES sticky (climate-dash parity). */

export const DEV_STICKY_STORAGE_PREFIX = 'dashbird-dev-sticky:';

/**
 * @typedef {{ content: string, x: number, y: number, collapsed: boolean }} DevStickyState
 */

/**
 * @param {string} pageId
 * @returns {string}
 */
export function devStickyStorageKey(pageId) {
  return `${DEV_STICKY_STORAGE_PREFIX}${pageId}`;
}

/**
 * @param {string} pageId
 * @param {() => Pick<DevStickyState, 'x' | 'y'>} defaultPosition
 * @param {(x: number, y: number) => Pick<DevStickyState, 'x' | 'y'>} clampPosition
 * @returns {DevStickyState}
 */
export function loadDevSticky(pageId, defaultPosition, clampPosition) {
  try {
    const raw = localStorage.getItem(devStickyStorageKey(pageId));
    if (raw) {
      const parsed = JSON.parse(raw);
      const pos = clampPosition(
        Number.isFinite(parsed?.x) ? parsed.x : defaultPosition().x,
        Number.isFinite(parsed?.y) ? parsed.y : defaultPosition().y,
      );
      return {
        content: typeof parsed?.content === 'string' ? parsed.content : '',
        collapsed: Boolean(parsed?.collapsed),
        ...pos,
      };
    }
  } catch {
    // ignore corrupt storage
  }
  return { content: '', collapsed: false, ...defaultPosition() };
}

/**
 * @param {string} pageId
 * @param {DevStickyState} state
 */
export function saveDevSticky(pageId, state) {
  try {
    localStorage.setItem(devStickyStorageKey(pageId), JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}
