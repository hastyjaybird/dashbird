/**
 * Fall leaf-color season at secondary-watch ZIP (USA-NPN MODIS LSP Mid Greendown Median).
 * @see https://www.usanpn.org/data/maps/land_surface_phenology
 */
import { formatMdShort, isPhenologyPhaseActive, PHENOLOGY_HEADS_UP_DAYS } from './phenology-heads-up.js';
import { labelWithSecondaryZip, secondaryZipSuffix } from './secondary-watch-label.js';
import { addDaysToYmd, isLikelyUsanpnSixExtent, npnWcsGetPointValue, wallYmdInTimeZone, ymdForYearDoy } from './usanpn-wcs-point.js';

const REF_URL = 'https://www.usanpn.org/data/maps/land_surface_phenology';

const GREENDOWN_COVERAGE_IDS = [
  'inca:midgdwn_median_nad83_02deg',
  'inca:midgdown_median_nad83_02deg',
  'inca:midgreendown_median_nad83_02deg',
];

const PEAK_WINDOW_DAYS = 7;
const SEASON_SPAN_DAYS = 14;

/**
 * @param {number} lat
 * @param {number} lon
 * @param {string} [baseUrl]
 */
async function fetchMidGreendownDoy(lat, lon, baseUrl) {
  for (const coverageId of GREENDOWN_COVERAGE_IDS) {
    const r = await npnWcsGetPointValue({ baseUrl, lat, lon, coverageId });
    if (r.ok && Number.isFinite(r.value) && r.value > 0 && r.value < 400) {
      return { doy: Math.round(r.value), coverageId };
    }
  }
  return null;
}

/**
 * @param {object} p
 * @param {number} p.lat
 * @param {number} p.lon
 * @param {string} p.timeZone
 * @param {Date} [p.now]
 * @param {string} [p.baseUrl]
 * @param {string} [p.zip] Secondary-watch ZIP (shown as `@ ZIP` on labels).
 */
export async function buildFallFoliageSeasonStatus(p) {
  const now = p.now instanceof Date ? p.now : new Date();
  const tz = (p.timeZone || '').trim() || 'America/New_York';
  const wallYmd = wallYmdInTimeZone(now, tz);
  const year = Number.parseInt(wallYmd.slice(0, 4), 10);

  if (!isLikelyUsanpnSixExtent(p.lat, p.lon)) {
    return {
      ok: true,
      active: false,
      value: 'Outside CONUS LSP coverage',
      items: [],
    };
  }

  const sample = await fetchMidGreendownDoy(p.lat, p.lon, p.baseUrl);
  if (!sample) {
    return {
      ok: true,
      active: false,
      value: 'Could not load greendown timing (USA-NPN LSP)',
      items: [],
    };
  }

  const peakYmd = ymdForYearDoy(year, sample.doy);
  const startYmd = addDaysToYmd(peakYmd, -SEASON_SPAN_DAYS);
  const endYmd = addDaysToYmd(peakYmd, SEASON_SPAN_DAYS);
  const peakStartYmd = addDaysToYmd(peakYmd, -PEAK_WINDOW_DAYS);
  const peakEndYmd = addDaysToYmd(peakYmd, PEAK_WINDOW_DAYS);

  const schedule = `Start ~${formatMdShort(startYmd)} · Peak ~${formatMdShort(peakStartYmd)}–${formatMdShort(peakEndYmd)} · End ~${formatMdShort(endYmd)}`;
  const sourceNote = `USA-NPN Mid Greendown median DOY ${sample.doy} (2001–2017 MODIS LSP)`;

  const phases = [
    {
      key: 'start',
      label: 'color start',
      milestoneYmd: startYmd,
      phaseEndYmd: peakStartYmd,
    },
    {
      key: 'peak',
      label: 'peak color',
      milestoneYmd: peakStartYmd,
      phaseEndYmd: peakEndYmd,
    },
    {
      key: 'end',
      label: 'season end',
      milestoneYmd: endYmd,
      phaseEndYmd: endYmd,
    },
  ];

  /** @type {Array<object>} */
  const activePhases = [];
  for (const ph of phases) {
    if (isPhenologyPhaseActive(wallYmd, ph.milestoneYmd, ph.phaseEndYmd)) {
      activePhases.push(ph);
    }
  }

  const value = `${schedule}${secondaryZipSuffix(p.zip)} · ${sourceNote}`;

  if (!activePhases.length) {
    return { ok: true, active: false, value, items: [], schedule, greendownDoy: sample.doy };
  }

  const detailParts = activePhases.map((ph) => {
    const approaching = wallYmd < ph.milestoneYmd;
    if (approaching) {
      return `${ph.label} expected ~${formatMdShort(ph.milestoneYmd)} (within ${PHENOLOGY_HEADS_UP_DAYS}d heads-up)`;
    }
    if (ph.key === 'peak') {
      return `Peak color ~${formatMdShort(peakStartYmd)}–${formatMdShort(peakEndYmd)}`;
    }
    return `${ph.label} window (expected ~${formatMdShort(ph.milestoneYmd)})`;
  });

  const item = {
    earthType: 'fall_foliage_season',
    label: labelWithSecondaryZip('Fall foliage', p.zip),
    detailLine: `${detailParts.join(' · ')} · ${schedule}`,
    forecastUrl: REF_URL,
    fallFoliage: { schedule, greendownDoy: sample.doy, activePhases: activePhases.map((x) => x.key) },
  };

  return { ok: true, active: true, value, items: [item], schedule, greendownDoy: sample.doy };
}
