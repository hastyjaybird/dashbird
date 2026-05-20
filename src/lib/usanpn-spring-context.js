import {
  addDaysToYmd,
  isLikelyUsanpnSixExtent,
  npnTimeIsoFromWallYmd,
  npnWcsGetPointValue,
  parseWcsTimeRangeFromException,
  wallYmdInTimeZone,
  ymdForYearDoy,
  ymdFromNpnTimeIso,
  ymdInRangeInclusive,
} from './usanpn-wcs-point.js';

const REF_URL = 'https://www.usanpn.org/data/maps/spring';

/**
 * @param {number} lat
 * @param {number} lon
 * @param {string} wallYmd
 * @param {string} [baseUrl]
 * @returns {Promise<string | null>} YYYY-MM-DD slice to use, or null
 */
async function resolveDataWallYmd(lat, lon, wallYmd, baseUrl) {
  const wantIso = npnTimeIsoFromWallYmd(wallYmd);
  const first = await npnWcsGetPointValue({
    baseUrl,
    lat,
    lon,
    coverageId: 'si-x:average_leaf_ncep',
    timeIso: wantIso,
  });
  if (first.ok) return wallYmd;

  const range = parseWcsTimeRangeFromException(first.body);
  const endYmd = range?.end ? ymdFromNpnTimeIso(range.end) : null;
  if (endYmd) {
    const clamped = wallYmd > endYmd ? endYmd : wallYmd;
    const retryIso = npnTimeIsoFromWallYmd(clamped);
    const second = await npnWcsGetPointValue({
      baseUrl,
      lat,
      lon,
      coverageId: 'si-x:average_leaf_ncep',
      timeIso: retryIso,
    });
    if (second.ok) return clamped;
  }
  return null;
}

/**
 * @param {number} v
 */
function isValidNpnScalar(v) {
  return Number.isFinite(v) && v > -9000 && v < 9000;
}

/**
 * @param {number} daysEarlyLate negative = ahead of average (early)
 */
function formatEarlyLateLine(daysEarlyLate) {
  const a = Math.abs(Math.round(daysEarlyLate * 10) / 10);
  const rounded = Math.round(a) === a ? String(Math.round(a)) : String(a);
  const n = Math.round(a);
  const dayWord = n === 1 ? 'day' : 'days';
  if (daysEarlyLate < 0) {
    return `Modeled first leaf is about ${rounded} ${dayWord} ahead of the 1981–2010 average (USA-NPN SI-x, NCEP).`;
  }
  if (daysEarlyLate > 0) {
    return `Modeled first leaf is about ${rounded} ${dayWord} behind the 1981–2010 average (USA-NPN SI-x, NCEP).`;
  }
  return `Modeled first leaf is near the 1981–2010 average timing (USA-NPN SI-x, NCEP).`;
}

/**
 * @param {object} p
 * @param {number} p.lat
 * @param {number} p.lon
 * @param {string} p.timeZone
 * @param {Date} [p.now]
 * @param {string} [p.baseUrl]
 * @returns {Promise<{ ok: true, items: any[] } | { ok: false, items: [], error?: string }>}
 */
export async function buildUsaNpnSpringEarthItems(p) {
  const now = p.now instanceof Date ? p.now : new Date();
  const tz = (p.timeZone || '').trim() || 'America/Los_Angeles';
  const { lat, lon } = p;

  if (!isLikelyUsanpnSixExtent(lat, lon)) {
    return { ok: true, items: [] };
  }

  const wallYmd = wallYmdInTimeZone(now, tz);
  const wallYear = Number.parseInt(wallYmd.slice(0, 4), 10);

  const dataYmd = await resolveDataWallYmd(lat, lon, wallYmd, p.baseUrl);
  if (!dataYmd) {
    return { ok: true, items: [] };
  }

  const dataIso = npnTimeIsoFromWallYmd(dataYmd);

  const [avgLeafDoyR, leafAnomR, leafIdxR] = await Promise.all([
    npnWcsGetPointValue({
      baseUrl: p.baseUrl,
      lat,
      lon,
      coverageId: 'si-x:30yr_avg_4k_leaf',
    }),
    npnWcsGetPointValue({
      baseUrl: p.baseUrl,
      lat,
      lon,
      coverageId: 'si-x:leaf_anomaly',
      timeIso: dataIso,
    }),
    npnWcsGetPointValue({
      baseUrl: p.baseUrl,
      lat,
      lon,
      coverageId: 'si-x:average_leaf_ncep',
      timeIso: dataIso,
    }),
  ]);

  const avgLeafDoy = avgLeafDoyR.ok ? avgLeafDoyR.value : null;
  const leafAnom = leafAnomR.ok ? leafAnomR.value : null;
  const leafIdx = leafIdxR.ok ? leafIdxR.value : null;

  if (!isValidNpnScalar(avgLeafDoy)) {
    return { ok: true, items: [] };
  }

  const triggerDoy = Math.max(1, Math.min(366, Math.round(avgLeafDoy)));
  const triggerYmd = ymdForYearDoy(wallYear, triggerDoy);
  const endYmd = addDaysToYmd(triggerYmd, 13);

  const active = ymdInRangeInclusive(wallYmd, triggerYmd, endYmd);
  if (!active) {
    return { ok: true, items: [] };
  }

  const dayIndex = Math.max(
    0,
    Math.min(
      13,
      Math.round((Date.parse(`${wallYmd}T12:00:00Z`) - Date.parse(`${triggerYmd}T12:00:00Z`)) / 86_400_000),
    ),
  );
  const progress01 = Math.min(1, (dayIndex + 1) / 14);

  let detail = `Day ${dayIndex + 1} of 14 after average first-leaf timing for this location.`;
  if (isValidNpnScalar(leafAnom)) {
    detail = `${detail} ${formatEarlyLateLine(leafAnom)}`;
  } else if (isValidNpnScalar(leafIdx)) {
    detail = `${detail} (Current SI-x first-leaf index ${Math.round(leafIdx * 10) / 10}; anomaly unavailable.)`;
  }

  const item = {
    earthType: 'usa_npn_spring',
    label: 'Spring (first leaf)',
    detailLine: detail,
    forecastUrl: REF_URL,
    npnSpring: {
      progress01,
      daysEarlyLate: isValidNpnScalar(leafAnom) ? leafAnom : null,
      triggerYmd,
      endYmd,
      wallYmd,
      dataYmd,
    },
  };

  return { ok: true, items: [item] };
}
