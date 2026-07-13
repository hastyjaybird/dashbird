/**
 * Canonical scene / circle labels + a few known contact display renames.
 *
 * Applied on every contact/group normalize (load + save) and via a versioned
 * DB migration on open — so typos and renames stay fixed without one-off scripts.
 *
 * To teach the app a new rename: add it here and bump SCENE_ALIASES_MIGRATION.
 */

/** @type {Record<string, string>} lowercase token → canonical scene label */
export const SCENE_TOKEN_ALIASES = {
  alessandra: 'ali warehouse',
  'alessandra warehouse': 'ali warehouse',
  'alessandra wearehouse': 'ali warehouse',
  deralleurs: 'derailleurs',
};

/** @type {Record<string, string>} lowercase displayName → preferred display name */
export const CONTACT_DISPLAY_ALIASES = {
  alessandra: 'Ali Warehouse',
};

/**
 * Bump when SCENE_TOKEN_ALIASES / CONTACT_DISPLAY_ALIASES gain entries that
 * should rewrite rows already stored in SQLite.
 */
export const SCENE_ALIASES_MIGRATION = 'scene_aliases_v1';

/**
 * @param {string} token
 */
export function canonicalizeSceneToken(token) {
  const t = String(token || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  const mapped = SCENE_TOKEN_ALIASES[t.toLowerCase()];
  return mapped || t;
}

/**
 * Split comma/semicolon/pipe scene lists, canonicalize, dedupe.
 * @param {unknown} raw
 * @param {number} [maxLen]
 */
export function normalizeSceneCircles(raw, maxLen = 4000) {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const parts = s
    .split(/[,;|/]+/)
    .map((p) => canonicalizeSceneToken(p))
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join(', ').slice(0, maxLen);
}

/**
 * @param {unknown} raw
 * @param {(s: string) => string} [titleCase]
 */
export function normalizeContactDisplayName(raw, titleCase) {
  const cleaned = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  if (!cleaned) return '';
  const aliased = CONTACT_DISPLAY_ALIASES[cleaned.toLowerCase()];
  if (aliased) return aliased;
  return typeof titleCase === 'function' ? titleCase(cleaned) : cleaned;
}

/**
 * Group names that are scenes get the same alias map.
 * @param {unknown} raw
 * @param {number} [max]
 */
export function normalizeSceneGroupName(raw, max = 300) {
  const cleaned = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  if (!cleaned) return '';
  return canonicalizeSceneToken(cleaned).slice(0, max);
}
