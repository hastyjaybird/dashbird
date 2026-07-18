/**
 * Dashbird areas for dev / feature change requests (desktop + mobile).
 */

/** @typedef {'desktop' | 'mobile'} DevRequestPlatform */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 * }} DevRequestAreaDef
 */

/** @type {Record<string, string>} */
export const DEV_REQUEST_AREA_ALIASES = {
  main: 'events',
  'house-hunter': 'settings',
  other: 'events',
};

/** @type {Record<DevRequestPlatform, DevRequestAreaDef[]>} */
export const DEV_REQUEST_AREAS = {
  desktop: [
    { id: 'events', label: 'Events' },
    { id: 'news', label: 'News' },
    { id: 'weather', label: 'Weather' },
    { id: 'bookmarks', label: 'Bookmarks' },
    { id: 'tools', label: 'Tools' },
    { id: 'gmail', label: 'Gmail' },
    { id: 'world-status', label: 'World status bar (right)' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'notes', label: 'Notes' },
    { id: 'network', label: 'Network' },
    { id: 'settings', label: 'Settings' },
    { id: 'telegram', label: 'Telegram' },
  ],
  mobile: [
    { id: 'notes', label: 'Notes' },
    { id: 'events', label: 'Events' },
    { id: 'gmail', label: 'Mail' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'network', label: 'Contacts' },
    { id: 'groups', label: 'Groups' },
    { id: 'settings', label: 'Settings' },
  ],
};

/** @type {Record<number, { id: number, label: string, short: string }>} */
export const DEV_REQUEST_PRIORITIES = {
  1: { id: 1, label: 'High', short: 'high' },
  2: { id: 2, label: 'Med', short: 'med' },
  3: { id: 3, label: 'Low', short: 'low' },
};

/**
 * @param {unknown} raw
 * @returns {DevRequestPlatform}
 */
export function normalizePlatform(raw) {
  const p = String(raw || '').trim().toLowerCase();
  return p === 'mobile' ? 'mobile' : 'desktop';
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizePriority(raw) {
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1 && n <= 3) return Math.floor(n);
  if (Number.isFinite(n) && n >= 4) return 3;
  return 2;
}

/**
 * @param {string} areaId
 * @returns {string}
 */
export function resolveAreaId(areaId) {
  const id = String(areaId || '').trim();
  return DEV_REQUEST_AREA_ALIASES[id] || id;
}

/**
 * @param {DevRequestPlatform} platform
 * @param {string} areaId
 * @returns {DevRequestAreaDef | null}
 */
export function findArea(platform, areaId) {
  const list = DEV_REQUEST_AREAS[platform] || [];
  const id = resolveAreaId(areaId);
  return list.find((a) => a.id === id) || null;
}

/**
 * @param {DevRequestPlatform} platform
 * @param {string} areaId
 * @returns {string}
 */
export function areaLabel(platform, areaId) {
  return findArea(platform, areaId)?.label || String(areaId || 'events');
}
