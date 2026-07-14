/**
 * Client helpers for Network Scene (`networkCircles`) tokens.
 */

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function splitSceneTokens(raw) {
  return String(raw ?? '')
    .split(/[,;|/]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Deduped, sorted scene labels from contacts (and optional extras).
 * @param {object[]} contacts
 * @param {unknown[]} [extraTokens]
 * @returns {string[]}
 */
export function collectSceneOptions(contacts, extraTokens = []) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  /**
   * @param {unknown} raw
   */
  function add(raw) {
    for (const part of splitSceneTokens(raw)) {
      const key = part.toLowerCase();
      if (!seen.has(key)) seen.set(key, part);
    }
  }
  for (const c of Array.isArray(contacts) ? contacts : []) {
    add(c?.networkCircles);
  }
  for (const t of Array.isArray(extraTokens) ? extraTokens : []) {
    add(t);
  }
  return [...seen.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
}

/**
 * @param {string[]} tokens
 * @returns {string}
 */
export function joinSceneTokens(tokens) {
  const seen = new Map();
  for (const t of tokens || []) {
    const part = String(t || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!part) continue;
    const key = part.toLowerCase();
    if (!seen.has(key)) seen.set(key, part);
  }
  return [...seen.values()].join(', ');
}
