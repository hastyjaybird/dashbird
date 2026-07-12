/**
 * Events finder taste — Look for / grey (skip) / blacklist over title, venue, description.
 * Grey list (`skip`) hides only when no Look for line also matches.
 * Blacklist hides regardless of Look for matches.
 * Hyphens, apostrophes, and similar characters in preference lines are kept for matching
 * (e.g. "hands-on" matches "hands-on", "hands on", and "handson").
 */
/**
 * @param {string} block
 * @returns {string[]}
 */
export function parseTasteLines(block) {
  return String(block || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line && !line.startsWith('//'));
}

/**
 * Fold text for matching: lowercase, strip accents, keep letters/numbers as tokens.
 * Punctuation (including hyphens) becomes spaces so "hands-on" ↔ "hands on".
 * @param {unknown} value
 * @returns {string}
 */
export function foldTasteText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[''`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * @param {object} event
 * @returns {string}
 */
function eventHaystack(event) {
  const parts = [
    event?.title,
    event?.venue,
    event?.location,
    event?.city,
    event?.description,
    event?.url,
  ];
  return foldTasteText(parts.map((p) => String(p || '')).join(' \n '));
}

/**
 * Soft phrase match: hyphenated / punctuated words stay meaningful.
 * @param {string} hay already folded
 * @param {string} line
 * @returns {boolean}
 */
function lineMatches(hay, line) {
  const original = String(line || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!original) return false;

  // Quoted phrase → substring on folded text
  const quoted = original.match(/^"([^"]+)"$/);
  if (quoted) {
    const q = foldTasteText(quoted[1]);
    return Boolean(q) && hay.includes(q);
  }

  const folded = foldTasteText(original);
  if (!folded) return false;

  // Whole phrase (hyphens already normalized to spaces)
  if (hay.includes(folded)) return true;

  // Compact form: "hands-on" / "hands on" → "handson"
  const compactLine = folded.replace(/\s+/g, '');
  const compactHay = hay.replace(/\s+/g, '');
  if (compactLine.length >= 4 && compactHay.includes(compactLine)) return true;

  // Multi-word: every token length ≥ 2 must appear (order-free)
  const tokens = folded.split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return hay.includes(folded);
  return tokens.every((t) => hay.includes(t));
}

/**
 * @param {object} event
 * @param {{ lookFor?: string, skip?: string, blacklist?: string }} criteria
 * @returns {{
 *   ok: boolean,
 *   reason?: 'skip' | 'blacklist',
 *   score: number,
 *   matchedLookFor: string[],
 *   matchedSkip: string[],
 *   matchedBlacklist: string[],
 * }}
 */
export function scoreEventTaste(event, criteria = {}) {
  const hay = eventHaystack(event);
  const lookFor = parseTasteLines(criteria.lookFor);
  const skip = parseTasteLines(criteria.skip);
  const blacklist = parseTasteLines(criteria.blacklist);

  const matchedLookFor = lookFor.filter((line) => lineMatches(hay, line));
  const matchedSkip = skip.filter((line) => lineMatches(hay, line));
  const matchedBlacklist = blacklist.filter((line) => lineMatches(hay, line));

  // Blacklist always hides, even when Look for also matches.
  if (matchedBlacklist.length) {
    return {
      ok: false,
      reason: 'blacklist',
      score: -2000,
      matchedLookFor,
      matchedSkip,
      matchedBlacklist,
    };
  }

  // Grey list (skip) only hides when nothing on Look for also matches.
  if (matchedSkip.length && !matchedLookFor.length) {
    return {
      ok: false,
      reason: 'skip',
      score: -1000,
      matchedLookFor,
      matchedSkip,
      matchedBlacklist,
    };
  }

  // Rank: more look-for hits first; events with no hits stay in feed (score 0).
  const score = matchedLookFor.length;

  return {
    ok: true,
    score,
    matchedLookFor,
    matchedSkip,
    matchedBlacklist,
  };
}

/**
 * Sort: higher taste score first, then existing comparator.
 * @param {(a: object, b: object) => number} [tieBreak]
 * @returns {(a: object, b: object) => number}
 */
export function compareEventsByTasteThen(tieBreak) {
  return (a, b) => {
    const sa = Number(a?.tasteScore) || 0;
    const sb = Number(b?.tasteScore) || 0;
    if (sb !== sa) return sb - sa;
    return typeof tieBreak === 'function' ? tieBreak(a, b) : 0;
  };
}
