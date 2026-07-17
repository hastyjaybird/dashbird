/**
 * Local News taste — Look for / grey (skip) / blacklist over title, summary, source, category.
 * Grey list (`skip`) hides only when no Look for line also matches.
 * Blacklist hides regardless of Look for matches.
 * Mirrors src/lib/events-finder-taste.js (kept standalone rather than shared, same as
 * that file's own note about self-containment).
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
 * @param {object} article
 * @returns {string}
 */
function articleHaystack(article) {
  const parts = [
    article?.title,
    article?.summary,
    article?.feedTitle,
    article?.category,
    article?.link,
  ];
  return foldTasteText(parts.map((p) => String(p || '')).join(' \n '));
}

/**
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

  const quoted = original.match(/^"([^"]+)"$/);
  if (quoted) {
    const q = foldTasteText(quoted[1]);
    return Boolean(q) && hay.includes(q);
  }

  const folded = foldTasteText(original);
  if (!folded) return false;

  if (hay.includes(folded)) return true;

  const compactLine = folded.replace(/\s+/g, '');
  const compactHay = hay.replace(/\s+/g, '');
  if (compactLine.length >= 4 && compactHay.includes(compactLine)) return true;

  const tokens = folded.split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return hay.includes(folded);
  return tokens.every((t) => hay.includes(t));
}

/**
 * @param {object} article
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
export function scoreArticleTaste(article, criteria = {}) {
  const hay = articleHaystack(article);
  const lookFor = parseTasteLines(criteria.lookFor);
  const skip = parseTasteLines(criteria.skip);
  const blacklist = parseTasteLines(criteria.blacklist);

  const matchedLookFor = lookFor.filter((line) => lineMatches(hay, line));
  const matchedSkip = skip.filter((line) => lineMatches(hay, line));
  const matchedBlacklist = blacklist.filter((line) => lineMatches(hay, line));

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

  // Grey list (skip): when Look for is empty, only deprioritize so more headlines stay
  // visible; once Look for has lines, grey hides articles with no Look for overlap.
  if (matchedSkip.length && !matchedLookFor.length) {
    if (!lookFor.length) {
      return {
        ok: true,
        score: -1000,
        matchedLookFor,
        matchedSkip,
        matchedBlacklist,
      };
    }
    return {
      ok: false,
      reason: 'skip',
      score: -1000,
      matchedLookFor,
      matchedSkip,
      matchedBlacklist,
    };
  }

  return {
    ok: true,
    score: matchedLookFor.length,
    matchedLookFor,
    matchedSkip,
    matchedBlacklist,
  };
}

/**
 * Sort: higher human-experience importance first (when scored), then taste, then tieBreak.
 * Feed re-sorts as importance scores arrive from background relevance generation.
 * @param {(a: object, b: object) => number} [tieBreak]
 * @returns {(a: object, b: object) => number}
 */
export function compareArticlesByImportanceThenTaste(tieBreak) {
  return (a, b) => {
    const ia = Number(a?.importance);
    const ib = Number(b?.importance);
    const aHas = Number.isFinite(ia) && ia > 0;
    const bHas = Number.isFinite(ib) && ib > 0;
    if (aHas && bHas && ib !== ia) return ib - ia;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    const sa = Number(a?.tasteScore) || 0;
    const sb = Number(b?.tasteScore) || 0;
    if (sb !== sa) return sb - sa;
    return typeof tieBreak === 'function' ? tieBreak(a, b) : 0;
  };
}

/**
 * Sort: higher taste score first, then existing comparator.
 * @param {(a: object, b: object) => number} [tieBreak]
 * @returns {(a: object, b: object) => number}
 */
export function compareArticlesByTasteThen(tieBreak) {
  return (a, b) => {
    const sa = Number(a?.tasteScore) || 0;
    const sb = Number(b?.tasteScore) || 0;
    if (sb !== sa) return sb - sa;
    return typeof tieBreak === 'function' ? tieBreak(a, b) : 0;
  };
}
