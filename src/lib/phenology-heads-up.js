import { addDaysToYmd, ymdInRangeInclusive } from './usanpn-wcs-point.js';

export const PHENOLOGY_HEADS_UP_DAYS = 21;

/**
 * @param {string} wallYmd
 * @param {string} milestoneYmd
 * @param {string} [phaseEndYmd] inclusive end of in-phase window (defaults to milestone)
 * @param {number} [leadDays]
 */
export function isPhenologyPhaseActive(wallYmd, milestoneYmd, phaseEndYmd, leadDays = PHENOLOGY_HEADS_UP_DAYS) {
  if (!wallYmd || !milestoneYmd) return false;
  const headsStart = addDaysToYmd(milestoneYmd, -leadDays);
  const phaseEnd = phaseEndYmd || milestoneYmd;
  if (ymdInRangeInclusive(wallYmd, headsStart, milestoneYmd)) return true;
  if (ymdInRangeInclusive(wallYmd, milestoneYmd, phaseEnd)) return true;
  return false;
}

/**
 * @param {string} wallYmd
 * @param {string} milestoneYmd
 * @param {number} [leadDays]
 */
export function isPhenologyHeadsUpOnly(wallYmd, milestoneYmd, leadDays = PHENOLOGY_HEADS_UP_DAYS) {
  if (!wallYmd || !milestoneYmd) return false;
  const headsStart = addDaysToYmd(milestoneYmd, -leadDays);
  return ymdInRangeInclusive(wallYmd, headsStart, addDaysToYmd(milestoneYmd, -1));
}

/**
 * @param {string} ymd YYYY-MM-DD
 */
export function formatMdShort(ymd) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  return `${Number.parseInt(m[2], 10)}/${Number.parseInt(m[3], 10)}`;
}
