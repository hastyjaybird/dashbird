/**
 * Client-side helpers for a contact's Scene (`networkCircles`) token list.
 *
 * Scene groups mirror a contact's Scene tag, so adding / removing scene-group
 * membership on mobile is done by editing the contact's `networkCircles` string
 * (PUT /api/network/contacts/:id) — the server canonicalizes tokens and re-syncs
 * community groups. These helpers only do light splitting/joining; the backend
 * (`network-scene-normalize.js`) owns canonical spelling.
 */

/**
 * @param {unknown} circles
 * @returns {string[]}
 */
export function splitSceneTokens(circles) {
  return String(circles ?? '')
    .split(/[,;|/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Add a scene token (case-insensitive, no duplicates).
 * @param {unknown} circles
 * @param {string} name
 * @returns {string}
 */
export function addSceneToken(circles, name) {
  const token = String(name || '').trim();
  const list = splitSceneTokens(circles);
  if (!token) return list.join(', ');
  if (list.some((t) => t.toLowerCase() === token.toLowerCase())) return list.join(', ');
  list.push(token);
  return list.join(', ');
}

/**
 * Remove a scene token (case-insensitive).
 * @param {unknown} circles
 * @param {string} name
 * @returns {string}
 */
export function removeSceneToken(circles, name) {
  const token = String(name || '').trim().toLowerCase();
  const list = splitSceneTokens(circles).filter((t) => t.toLowerCase() !== token);
  return list.join(', ');
}
