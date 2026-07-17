/**
 * Shared newline taste-list helpers (Look for / grey skip / blacklist).
 */

/**
 * @param {string} block
 * @returns {string[]}
 */
export function tasteLinesFromBlock(block) {
  return String(block || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line && !line.startsWith('//'));
}

/**
 * Remove exact lines (case-insensitive) from a taste block; preserve comments/blanks.
 * @param {string} block
 * @param {string[]} linesToRemove
 * @returns {string}
 */
export function removeTasteLines(block, linesToRemove) {
  const remove = new Set(
    (Array.isArray(linesToRemove) ? linesToRemove : [])
      .map((l) => String(l || '').replace(/#.*$/, '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (!remove.size) return String(block || '');
  const kept = String(block || '').split(/\r?\n/).filter((line) => {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (!trimmed || trimmed.startsWith('//')) return true;
    return !remove.has(trimmed.toLowerCase());
  });
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join('\n');
}

/**
 * @param {unknown} raw
 * @returns {string[] | undefined}
 */
export function normalizeTasteLineArray(raw) {
  if (!Array.isArray(raw)) return undefined;
  const lines = raw
    .map((l) => String(l || '').replace(/#.*$/, '').trim())
    .filter((l) => l && !l.startsWith('//'))
    .slice(0, 24);
  return lines.length ? lines : undefined;
}

/**
 * @param {object | null | undefined} rec
 * @returns {{ lookFor: string[], grey: string[], black: string[] }}
 */
export function tasteContextFromSkipRecord(rec) {
  return {
    lookFor: normalizeTasteLineArray(rec?.tasteLookFor) || [],
    grey: normalizeTasteLineArray(rec?.tasteGrey) || [],
    black: normalizeTasteLineArray(rec?.tasteBlack) || [],
  };
}

/**
 * @param {object[]} records
 * @returns {{ lookFor: string[], grey: string[], black: string[] }}
 */
export function collectTasteLinesFromSkipRecords(records) {
  /** @type {string[]} */
  const lookFor = [];
  /** @type {string[]} */
  const grey = [];
  /** @type {string[]} */
  const black = [];
  for (const rec of Array.isArray(records) ? records : []) {
    const ctx = tasteContextFromSkipRecord(rec);
    lookFor.push(...ctx.lookFor);
    grey.push(...ctx.grey);
    black.push(...ctx.black);
  }
  return { lookFor, grey, black };
}
