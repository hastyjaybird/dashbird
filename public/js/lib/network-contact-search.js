/**
 * Contact search helpers — prefix-match ranking for first-name fields.
 */

/**
 * First-name sort key (given name, not family name).
 * @param {object} contact
 * @returns {string}
 */
export function contactFirstNameSortKey(contact) {
  const first = String(contact?.firstName || '').trim();
  if (first) return first;
  const display = String(contact?.displayName || '').trim();
  if (display) {
    const token = display.replace(/\s+/g, ' ').split(' ').filter(Boolean)[0];
    if (token) return token;
  }
  return String(contact?.nickname || '').trim();
}

/**
 * First-name fields used when ranking contact search (prefix match).
 * @param {object} contact
 * @returns {string[]}
 */
export function contactFirstNameSearchTerms(contact) {
  const terms = [
    contact?.firstName,
    contact?.nickname,
    ...(Array.isArray(contact?.aliases) ? contact.aliases : []),
  ];
  if (!String(contact?.firstName || '').trim()) {
    const display = String(contact?.displayName || '').trim();
    if (display) {
      const token = display.replace(/\s+/g, ' ').split(' ').filter(Boolean)[0];
      if (token) terms.push(token);
    }
  }
  return terms
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when a first-name field starts with the query (case-insensitive).
 * @param {object} contact
 * @param {string} query
 * @returns {boolean}
 */
export function contactFirstNameStartsWithQuery(contact, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return false;
  return contactFirstNameSearchTerms(contact).some((name) => name.startsWith(q));
}

/**
 * Search sort tiebreaker: first-name prefix matches before others; then first name A→Z.
 * @param {object} a
 * @param {object} b
 * @param {string} query
 * @param {(c: object) => string} [nameOf]
 * @returns {number}
 */
export function compareContactSearchNameRank(a, b, query, nameOf = contactFirstNameSortKey) {
  const q = String(query || '').trim().toLowerCase();
  if (q) {
    const aPrefix = contactFirstNameStartsWithQuery(a, q);
    const bPrefix = contactFirstNameStartsWithQuery(b, q);
    if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
  }
  return nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' });
}
