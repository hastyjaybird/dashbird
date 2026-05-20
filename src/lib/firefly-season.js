/**
 * Lightning-bug (firefly) season at secondary-watch ZIP (latitude table).
 * @see src/data/firefly-season-us.json
 */
import table from '../data/firefly-season-us.json' with { type: 'json' };
import { formatMdShort } from './phenology-heads-up.js';
import { interpolateMmddFields, mmddToYmd } from './latitude-phenology-table.js';
import { addDaysToYmd, wallYmdInTimeZone, ymdInRangeInclusive } from './usanpn-wcs-point.js';
import { labelWithSecondaryZip, secondaryZipSuffix } from './secondary-watch-label.js';

const REF_URL = 'https://www.farmersalmanac.com/fireflies-weather';
const FIELDS = ['seasonStart', 'peakStart', 'peakEnd', 'seasonEnd'];
/** Main-page strip: start date appears only in the 7 days before season start. */
export const FIREFLY_START_LEAD_DAYS = 7;

/**
 * @param {string} wallYmd
 * @param {string} startYmd
 * @param {string} endYmd
 */
export function isFireflyStripVisible(wallYmd, startYmd, endYmd) {
  if (!wallYmd || !startYmd || !endYmd) return false;
  const headsStart = addDaysToYmd(startYmd, -FIREFLY_START_LEAD_DAYS);
  return ymdInRangeInclusive(wallYmd, headsStart, endYmd);
}

/**
 * @param {string} wallYmd
 * @param {{ startYmd: string, peakStartYmd: string, peakEndYmd: string, endYmd: string }} d
 */
export function buildFireflyStripDetailLine(wallYmd, d) {
  const peakStr = `Peak ~${formatMdShort(d.peakStartYmd)}–${formatMdShort(d.peakEndYmd)}`;
  if (wallYmd < d.startYmd) {
    return `Start ~${formatMdShort(d.startYmd)} · ${peakStr}`;
  }
  return `${peakStr} · until ~${formatMdShort(d.endYmd)}`;
}

/**
 * @param {object} p
 * @param {number} p.lat
 * @param {string} p.timeZone
 * @param {Date} [p.now]
 * @param {string} [p.zip] Secondary-watch ZIP (shown as `@ ZIP` on labels).
 */
export function buildFireflySeasonStatus(p) {
  const now = p.now instanceof Date ? p.now : new Date();
  const tz = (p.timeZone || '').trim() || 'America/New_York';
  const wallYmd = wallYmdInTimeZone(now, tz);
  const year = Number.parseInt(wallYmd.slice(0, 4), 10);

  const interpolated = interpolateMmddFields(table.rows || [], p.lat, FIELDS);
  if (!interpolated) {
    return { ok: true, active: false, value: 'No model for this latitude', items: [] };
  }

  const startYmd = mmddToYmd(interpolated.seasonStart, year);
  const peakStartYmd = mmddToYmd(interpolated.peakStart, year);
  const peakEndYmd = mmddToYmd(interpolated.peakEnd, year);
  const endYmd = mmddToYmd(interpolated.seasonEnd, year);

  const schedule = `Start ~${formatMdShort(startYmd)} · Peak ~${formatMdShort(peakStartYmd)}–${formatMdShort(peakEndYmd)} · End ~${formatMdShort(endYmd)}`;
  const value = `${schedule}${secondaryZipSuffix(p.zip)}`;
  const seasonDates = { startYmd, peakStartYmd, peakEndYmd, endYmd };

  if (!isFireflyStripVisible(wallYmd, startYmd, endYmd)) {
    return { ok: true, active: false, value, items: [], schedule };
  }

  const item = {
    earthType: 'firefly_season',
    label: labelWithSecondaryZip('Lightning bugs', p.zip),
    detailLine: buildFireflyStripDetailLine(wallYmd, seasonDates),
    forecastUrl: REF_URL,
    fireflySeason: {
      schedule,
      stripPhase: wallYmd < startYmd ? 'before_start' : 'in_season',
    },
  };

  return { ok: true, active: true, value, items: [item], schedule };
}
