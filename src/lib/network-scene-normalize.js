/**
 * Canonical scene / circle labels + a few known contact display renames.
 *
 * Applied on every contact/group normalize (load + save) and via a versioned
 * DB migration on open — so typos and renames stay fixed without one-off scripts.
 *
 * To teach the app a new rename: add it here and bump SCENE_ALIASES_MIGRATION.
 */

export const SCENE_APL_GROUPIE = 'APL Groupie';
export const SCENE_APL_EMPLOYEE = 'APL Employee';
export const SCENE_OLD_SHIPYARD = 'Old Shipyard';

/** Words that stay ALL CAPS inside scene labels (matched case-insensitively). */
export const SCENE_WORD_ACRONYMS = {
  apl: 'APL',
  wuyc: 'WUYC',
  sf: 'SF',
};

/** @type {Record<string, string>} lowercase token → canonical scene label */
export const SCENE_TOKEN_ALIASES = {
  alessandra: 'Ali Warehouse',
  'alessandra warehouse': 'Ali Warehouse',
  'alessandra wearehouse': 'Ali Warehouse',
  apl: SCENE_APL_GROUPIE,
  'apl groupie': SCENE_APL_GROUPIE,
  'apl groupies': SCENE_APL_GROUPIE,
  'apl employee': SCENE_APL_EMPLOYEE,
  shipyard: SCENE_OLD_SHIPYARD,
  'shipyard old school': SCENE_OLD_SHIPYARD,
  'old shipyard': SCENE_OLD_SHIPYARD,
  deralleurs: 'Derailleurs',
  gui: 'Gui/Aviary',
  aviary: 'Gui/Aviary',
  'gui/aviary': 'Gui/Aviary',
  'gui aviary': 'Gui/Aviary',
  'big string': 'T3 Art Collective',
  swarm: 'T3 Art Collective',
  lds: 'T3 Art Collective',
  't3 art collective': 'T3 Art Collective',
  art: 'T3',
  idaete: 'Ideate',
  idate: 'Ideate',
  flg: SCENE_OLD_SHIPYARD,
  miles: 'SF Polycule',
};

/** @type {Record<string, string>} lowercase displayName → preferred display name */
export const CONTACT_DISPLAY_ALIASES = {
  alessandra: 'Ali Warehouse',
};

/** Misplaced as a Scene tag / group — belongs in contact.location instead. */
export const OUT_OF_TOWN_LOCATION = 'Out of town';

/**
 * Bump when SCENE_TOKEN_ALIASES / CONTACT_DISPLAY_ALIASES gain entries that
 * should rewrite rows already stored in SQLite.
 */
export const SCENE_ALIASES_MIGRATION = 'scene_aliases_v14';

/**
 * @param {unknown} token
 */
function sceneTokenKey(token) {
  return String(token || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Event-only labels that must not live on contact Scene / community groups.
 * @param {unknown} token
 */
export function isPolidayToken(token) {
  return sceneTokenKey(token) === 'poliday';
}

/**
 * Legacy apl / shipyard family → role used when collapsing to one of the three buckets.
 * @param {string} key lowercase token (raw or aliased)
 * @returns {'employee' | 'groupie' | 'shipyard' | null}
 */
function aplShipyardFamilyRole(key) {
  const k = sceneTokenKey(key);
  if (k === 'apl employee') return 'employee';
  if (k === 'apl' || k === 'apl groupie' || k === 'apl groupies') return 'groupie';
  if (k === 'shipyard' || k === 'shipyard old school' || k === 'old shipyard') return 'shipyard';
  return null;
}

/**
 * Best-guess: name ends with / contains "Apl", or business without friend.
 * @param {{ id?: unknown, displayName?: unknown, kinds?: unknown }} [contact]
 */
export function isLikelyAplEmployee(contact = {}) {
  const name = String(contact.displayName || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\bapl\b/i.test(name) && !/^apl$/i.test(name)) return true;
  const kinds = Array.isArray(contact.kinds)
    ? contact.kinds.map((k) => String(k || '').toLowerCase())
    : [];
  if (kinds.includes('business') && !kinds.includes('friend')) return true;
  return false;
}

/**
 * Collapse legacy apl / shipyard / shipyard old school (and the three new labels)
 * into exactly one of: APL Employee, Old Shipyard, APL Groupie. Other scenes kept.
 *
 * Priority: likely employee → Old Shipyard (if any shipyard tag) → APL Groupie.
 *
 * @param {unknown} raw
 * @param {{ id?: unknown, displayName?: unknown, kinds?: unknown }} [contact]
 * @param {number} [maxLen]
 */
export function remapAplShipyardCircles(raw, contact = {}, maxLen = 4000) {
  const rawParts = String(raw ?? '')
    .split(/[,;|/]+/)
    .map((p) => String(p || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let sawApl = false;
  let sawShipyard = false;
  let sawEmployeeTag = false;
  const other = [];
  for (const part of rawParts) {
    const key = sceneTokenKey(part);
    const aliasedKey = sceneTokenKey(SCENE_TOKEN_ALIASES[key] || part);
    const role = aplShipyardFamilyRole(key) || aplShipyardFamilyRole(aliasedKey);
    if (role === 'employee') {
      sawEmployeeTag = true;
      sawApl = true;
      continue;
    }
    if (role === 'groupie') {
      sawApl = true;
      continue;
    }
    if (role === 'shipyard') {
      sawShipyard = true;
      continue;
    }
    other.push(part);
  }
  if (!sawApl && !sawShipyard && !sawEmployeeTag) {
    return normalizeSceneCircles(raw, maxLen);
  }
  let bucket = SCENE_APL_GROUPIE;
  if (sawEmployeeTag || isLikelyAplEmployee(contact)) bucket = SCENE_APL_EMPLOYEE;
  else if (sawShipyard) bucket = SCENE_OLD_SHIPYARD;
  return normalizeSceneCircles([...other, bucket].join(', '), maxLen);
}

/**
 * @param {unknown} token
 */
export function isOutOfTownToken(token) {
  const t = sceneTokenKey(token);
  return t === 'out of town';
}

/**
 * Title-case each whitespace- or slash-separated word (first letter up, rest lower).
 * Known acronyms (APL, WUYC, SF, …) stay ALL CAPS.
 * @param {string} token
 */
export function titleCaseSceneToken(token) {
  return String(token || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(\s+|\/)/)
    .map((part) => {
      if (!part || /^\s+$/.test(part) || part === '/') return part;
      const acronym = SCENE_WORD_ACRONYMS[part.toLowerCase()];
      if (acronym) return acronym;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('');
}

/**
 * @param {string} token
 */
export function canonicalizeSceneToken(token) {
  const t = String(token || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  if (isOutOfTownToken(t)) return '';
  if (isPolidayToken(t)) return '';
  const mapped = SCENE_TOKEN_ALIASES[t.toLowerCase()];
  return titleCaseSceneToken(mapped || t);
}

/**
 * Split comma/semicolon/pipe scene lists, canonicalize, dedupe.
 * Strips "Out of town" (that belongs in location — see relocateOutOfTownFromScenes).
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
 * If "Out of town" appears in Scene tags, remove it and fill empty location.
 * @param {unknown} networkCirclesRaw
 * @param {unknown} locationRaw
 * @param {number} [circlesMax]
 * @param {number} [locationMax]
 * @returns {{ networkCircles: string, location: string, relocated: boolean }}
 */
export function relocateOutOfTownFromScenes(
  networkCirclesRaw,
  locationRaw,
  circlesMax = 4000,
  locationMax = 300,
) {
  const rawCircles = String(networkCirclesRaw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const hadInScenes = rawCircles
    .split(/[,;|/]+/)
    .some((p) => isOutOfTownToken(p));
  const networkCircles = normalizeSceneCircles(rawCircles, circlesMax);
  let location = String(locationRaw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, locationMax);
  let relocated = false;
  if (hadInScenes) {
    relocated = true;
    if (!location) location = OUT_OF_TOWN_LOCATION.slice(0, locationMax);
  }
  return { networkCircles, location, relocated };
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

/**
 * Append a scene token to a contact's networkCircles string.
 * @param {unknown} networkCircles
 * @param {unknown} token
 * @param {number} [maxLen]
 */
export function addSceneToken(networkCircles, token, maxLen = 4000) {
  const t = canonicalizeSceneToken(token);
  if (!t) return normalizeSceneCircles(networkCircles, maxLen);
  return normalizeSceneCircles([String(networkCircles || ''), t].filter(Boolean).join(', '), maxLen);
}

/**
 * Remove a scene token (and its aliases) from a contact's networkCircles string.
 * @param {unknown} networkCircles
 * @param {unknown} token
 * @param {number} [maxLen]
 */
export function removeSceneToken(networkCircles, token, maxLen = 4000) {
  const dropCanonical = canonicalizeSceneToken(token).toLowerCase();
  const dropRaw = String(token || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!dropCanonical && !dropRaw) return normalizeSceneCircles(networkCircles, maxLen);
  const kept = String(networkCircles ?? '')
    .split(/[,;|/]+/)
    .map((p) => String(p || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((p) => {
      const key = p.toLowerCase();
      const canon = canonicalizeSceneToken(p).toLowerCase();
      if (dropCanonical && (key === dropCanonical || canon === dropCanonical)) return false;
      if (dropRaw && (key === dropRaw || canon === dropRaw)) return false;
      return true;
    });
  return normalizeSceneCircles(kept.join(', '), maxLen);
}

/**
 * Replace one scene token with another on a contact's networkCircles string.
 * @param {unknown} networkCircles
 * @param {unknown} oldToken
 * @param {unknown} newToken
 * @param {number} [maxLen]
 */
export function replaceSceneToken(networkCircles, oldToken, newToken, maxLen = 4000) {
  return addSceneToken(removeSceneToken(networkCircles, oldToken, maxLen), newToken, maxLen);
}
