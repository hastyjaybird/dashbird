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
  flg: 'FLG',
  dpw: 'DPW',
  pdx: 'PDX',
  t3: 'T3',
};

/**
 * lowercase token → canonical scene label.
 * Keep aliases specific — short tokens that steal real scene names (e.g. former
 * `flg → Old Shipyard`) cause chips to “disappear” on save.
 *
 * @type {Record<string, string>}
 */
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
  // FLG is its own scene — never fold into Old Shipyard again.
  flg: 'FLG',
  deralleurs: 'Derailleurs',
  derailleurs: 'Derailleurs',
  gui: 'Gui/Aviary',
  aviary: 'Gui/Aviary',
  'gui/aviary': 'Gui/Aviary',
  'gui aviary': 'Gui/Aviary',
  'big string': 'T3 Art Collective',
  swarm: 'T3 Art Collective',
  lds: 'T3 Art Collective',
  't3 art collective': 'T3 Art Collective',
  // Legacy lone "art" tag (not "SF Art" / "Underground Art").
  art: 'T3',
  idaete: 'Ideate',
  idate: 'Ideate',
  // Was briefly "SF Polycule" — too explicit for list subtitles.
  miles: 'Miles House',
  'miles house': 'Miles House',
  'sf polycule': 'Miles House',
  polycule: 'Miles House',
  finn: 'Finn House',
  'finn house': 'Finn House',
  'fenn house': 'Finn House',
  'flava pack': 'Flava Packet',
  'flava packet': 'Flava Packet',
  // Spelling / casing cleanup (shows under names in the people list).
  burningman: 'Burning Man',
  'burning man': 'Burning Man',
  highschool: 'High School',
  'high school': 'High School',
  stonybrook: 'Stony Brook',
  'stony brook': 'Stony Brook',
  'old pdx': 'Old PDX',
  'dpw power': 'DPW Power',
  dpw: 'DPW Power',
  'prof. conference circuit': 'Professional Network',
  'prof conference circuit': 'Professional Network',
  'conference circuit': 'Professional Network',
  client: 'Professional Network',
  'professional network': 'Professional Network',
  techie: 'Nerd Crew',
  tech: 'Nerd Crew',
  'nerd crew': 'Nerd Crew',
  'makerfarm 1.0': 'Makerfarm 1.0',
  'makerfarm1.0': 'Makerfarm 1.0',
};

/** @type {Record<string, string>} lowercase displayName → preferred display name */
export const CONTACT_DISPLAY_ALIASES = {
  alessandra: 'Ali Warehouse',
};

/** Misplaced as a Scene tag / group — belongs in contact.location instead. */
export const OUT_OF_TOWN_LOCATION = 'Out of town';
export const DELTA_LOCATION = 'Delta';

/**
 * Scene tokens that are really locations (lowercase key → location label).
 * @type {Readonly<Record<string, string>>}
 */
export const SCENE_LOCATION_LABELS = {
  'out of town': OUT_OF_TOWN_LOCATION,
  delta: DELTA_LOCATION,
};

/**
 * Scene labels to strip entirely (not renamed). Deleted from contacts + groups
 * on normalize / migration.
 * Vague one-off tags that aren't a real crew/place — they only clutter list subtitles.
 * @type {ReadonlySet<string>}
 */
export const DROPPED_SCENE_TOKENS = new Set([
  'jake',
  'jake crew',
  'virginia',
  'rando',
]);

/**
 * Bump when SCENE_TOKEN_ALIASES / CONTACT_DISPLAY_ALIASES / DROPPED_SCENE_TOKENS
 * / SCENE_LOCATION_LABELS / SCENE_KIND_LABELS gain entries that should rewrite rows already stored in SQLite.
 */
export const SCENE_ALIASES_MIGRATION = 'scene_aliases_v25';

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
 * Scenes Jay has retired — strip from contacts and delete matching groups.
 * @param {unknown} token
 */
export function isDroppedSceneToken(token) {
  return DROPPED_SCENE_TOKENS.has(sceneTokenKey(token));
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
 * Location label if this scene token is really a location (else '').
 * @param {unknown} token
 */
export function locationLabelForMisplacedScene(token) {
  return SCENE_LOCATION_LABELS[sceneTokenKey(token)] || '';
}

/**
 * Scene tags that belong in contact.location (Out of town, Delta, …).
 * @param {unknown} token
 */
export function isMisplacedLocationSceneToken(token) {
  return Boolean(locationLabelForMisplacedScene(token));
}

/**
 * Scene tokens that are really contact Type / kinds (lowercase key → kind id).
 * @type {Readonly<Record<string, string>>}
 */
export const SCENE_KIND_LABELS = {
  family: 'family',
};

/**
 * Kind id if this scene token is really a Type (else '').
 * @param {unknown} token
 */
export function kindForMisplacedScene(token) {
  return SCENE_KIND_LABELS[sceneTokenKey(token)] || '';
}

/**
 * Scene tags that belong in contact.kinds (Family, …).
 * @param {unknown} token
 */
export function isMisplacedKindSceneToken(token) {
  return Boolean(kindForMisplacedScene(token));
}

/**
 * Collect Type ids that were wrongly stored as Scene tags.
 * @param {unknown} networkCirclesRaw
 * @returns {string[]}
 */
export function kindsFromMisplacedScenes(networkCirclesRaw) {
  const out = [];
  const seen = new Set();
  for (const part of String(networkCirclesRaw ?? '').split(/[,;|/]+/)) {
    const kind = kindForMisplacedScene(part);
    if (!kind || seen.has(kind)) continue;
    seen.add(kind);
    out.push(kind);
  }
  return out;
}

/**
 * Merge kind ids into an existing kinds list (dedupe, stable order).
 * @param {string[]} kinds
 * @param {string[]} extra
 * @param {string[]} [order]
 */
export function mergeKinds(kinds, extra, order = ['friend', 'organizer', 'business', 'family']) {
  const set = new Set(
    [...(Array.isArray(kinds) ? kinds : []), ...(Array.isArray(extra) ? extra : [])]
      .map((k) => String(k || '').toLowerCase().trim())
      .filter(Boolean),
  );
  const out = [];
  for (const k of order) {
    if (set.has(k)) out.push(k);
  }
  for (const k of set) {
    if (!out.includes(k)) out.push(k);
  }
  return out.length ? out : ['friend'];
}

/**
 * Strip kind-as-scene tags from Scene and return kinds to merge onto the contact.
 * @param {unknown} networkCirclesRaw
 * @param {unknown} kindsRaw
 * @param {number} [circlesMax]
 * @returns {{ networkCircles: string, kinds: string[], relocated: boolean }}
 */
export function relocateFamilyFromScenes(networkCirclesRaw, kindsRaw, circlesMax = 4000) {
  const fromScene = kindsFromMisplacedScenes(networkCirclesRaw);
  const networkCircles = normalizeSceneCircles(networkCirclesRaw, circlesMax);
  /** @type {string[]} */
  let baseKinds = [];
  if (Array.isArray(kindsRaw)) {
    baseKinds = kindsRaw.map((k) => String(k || '').toLowerCase().trim()).filter(Boolean);
  }
  const kinds = mergeKinds(baseKinds, fromScene);
  return { networkCircles, kinds, relocated: fromScene.length > 0 };
}

/**
 * @param {unknown} token
 */
export function isOutOfTownToken(token) {
  return sceneTokenKey(token) === 'out of town';
}

/**
 * @param {unknown} token
 */
export function isDeltaToken(token) {
  return sceneTokenKey(token) === 'delta';
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
  if (isMisplacedLocationSceneToken(t)) return '';
  if (isMisplacedKindSceneToken(t)) return '';
  if (isPolidayToken(t)) return '';
  if (isDroppedSceneToken(t)) return '';
  const mapped = SCENE_TOKEN_ALIASES[t.toLowerCase()];
  return titleCaseSceneToken(mapped || t);
}

/**
 * Split comma/semicolon/pipe scene lists, canonicalize, dedupe.
 * Strips misplaced location tags (Out of town, Delta) and Type tags (Family).
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
 * If a location-as-scene tag (Out of town, Delta, …) appears in Scene, remove it
 * and fill empty location with that label.
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
  /** @type {string[]} */
  const fromScene = [];
  const seenFromScene = new Set();
  for (const part of rawCircles.split(/[,;|/]+/)) {
    const label = locationLabelForMisplacedScene(part);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seenFromScene.has(key)) continue;
    seenFromScene.add(key);
    fromScene.push(label);
  }
  const networkCircles = normalizeSceneCircles(rawCircles, circlesMax);
  let location = String(locationRaw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, locationMax);
  const relocated = fromScene.length > 0;
  if (relocated && !location) {
    location = fromScene[0].slice(0, locationMax);
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
