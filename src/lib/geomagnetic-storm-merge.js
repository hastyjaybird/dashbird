/**
 * Sky strip geomagnetic (“solar storm” / Dst-related) visibility from NOAA G-scale +
 * planetary K threshold (G2+).
 *
 * @see https://www.swpc.noaa.gov/products/noaa-scales (G geomagnetic storms)
 * @see https://services.swpc.noaa.gov/products/noaa-scales.json
 * @see https://services.swpc.noaa.gov/json/planetary_k_index_1m.json
 * @see https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json
 *
 * G2 Moderate NOAA pair: planar K reaches **Kp 6−** onward (≈ G2 tier). Threshold uses
 * Kp-coded floor **17 / 3** so “6−” counts as ≥G2.
 *
 * NOAA `noaa-scales.json` keys `"0"`…`"3"` are checked: any block whose **UTC calendar day**
 * overlaps the hero time window and reports **G ≥ 2** counts as active (the `"0"` row can sit
 * at G0 while `"1"` already carries the same-day **forecast** G2+ — reading only `"0"` hid that).
 *
 * Displayed Kp is the **peak** 3-hour planetary K on the storm day (forecast product), not the
 * latest 1-minute sample — a calm minute during a G2 day previously showed “Kp 0.00”.
 */

import { isSkyDebugGeomagneticActive } from './sky-debug.js';

const NOAA_SCALES_URL = 'https://services.swpc.noaa.gov/products/noaa-scales.json';
const PLANETARY_KP_1M_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
const PLANETARY_KP_FORECAST_URL =
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';

/** Show geomagnetic panels / strip only at G2+ (above G1 minor). */
export const GEOMAGNETIC_STORM_G_MIN = 2;
const ACTIVE_G_MIN = GEOMAGNETIC_STORM_G_MIN;

/**
 * @param {{ active?: boolean, g?: number, meetsG2Threshold?: boolean }} storm
 */
export function geomagneticStormMeetsG2Threshold(storm) {
  if (!storm) return false;
  if (storm.meetsG2Threshold === true) return true;
  if (storm.meetsG2Threshold === false) return false;
  if (storm.active === true) return true;
  const g = Number(storm.g);
  return Number.isFinite(g) && g >= GEOMAGNETIC_STORM_G_MIN;
}

/** NOAA geomagnetic G-scale category names (G0 … G5). */
const G_SCALE_CATEGORY = {
  0: 'Calm',
  1: 'Minor',
  2: 'Moderate',
  3: 'Strong',
  4: 'Severe',
  5: 'Extreme',
};

/** Kp-coded value for NOAA “**6−**” first tertile (planetary moderate-storm onset ≈ **G2**). */
export const KP_NUMERIC_G2_FLOOR = 17 / 3;

/**
 * @param {unknown} v
 */
function parseNoaaGsScaleDigits(v) {
  if (v == null || v === '') return 0;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? Math.min(99, Math.max(0, n)) : 0;
}

function formatKp(est) {
  if (typeof est !== 'number' || !Number.isFinite(est)) return '—';
  return est >= 9 ? est.toFixed(0) : est >= 1 ? est.toFixed(1) : est.toFixed(2);
}

/**
 * SWPC `time_tag` values are UTC; many omit the trailing `Z`. Parse as UTC.
 * @param {unknown} timeTag
 */
export function parseSwpcUtcMs(timeTag) {
  if (typeof timeTag !== 'string' || !timeTag.trim()) return NaN;
  const s = timeTag.trim();
  const iso = /Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`;
  return new Date(iso).getTime();
}

/**
 * @param {unknown} row
 * @returns {number | null}
 */
function readKpNumber(row) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [
    /** @type {{ estimated_kp?: unknown, kp?: unknown, Kp?: unknown, kp_index?: unknown }} */ (row)
      .estimated_kp,
    /** @type {{ kp?: unknown }} */ (row).kp,
    /** @type {{ Kp?: unknown }} */ (row).Kp,
    /** @type {{ kp_index?: unknown }} */ (row).kp_index,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string' && c.trim() !== '') {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * When NOAA’s daily “0” G block is still below G2 but Kp already qualifies, map planetary K → G level
 * (NOAA pairing: storm K=6 → G2 … K=9 → G5).
 * @returns {number | null}
 */
function inferredGFromPlanetaryKp(kp) {
  const k = typeof kp === 'number' && Number.isFinite(kp) ? kp : NaN;
  if (!Number.isFinite(k) || k < KP_NUMERIC_G2_FLOOR) return null;
  if (k < 7) return 2;
  if (k < 8) return 3;
  if (k < 9) return 4;
  return 5;
}

/**
 * Prefer NOAA `G.Text` on the daily “0” block; otherwise map from G ordinal.
 */
function geomagneticCategoryWord(noaaTxt, gNum) {
  const raw = typeof noaaTxt === 'string' ? noaaTxt.trim() : '';
  const low = raw.toLowerCase();
  if (raw && low !== 'none') {
    return raw[0].toUpperCase() + raw.slice(1);
  }
  if (typeof gNum === 'number' && Number.isFinite(gNum) && gNum in G_SCALE_CATEGORY) {
    return G_SCALE_CATEGORY[gNum];
  }
  return 'Elevated';
}

/**
 * @returns {Promise<{ scales: unknown, kpRows: unknown[] | null, kpForecastRows: unknown[] | null }>}
 */
async function fetchNoaaGAndKpRows(signal = AbortSignal.timeout(14_000)) {
  const [scRes, kp1mRes, kpFcRes] = await Promise.all([
    fetch(NOAA_SCALES_URL, { signal }),
    fetch(PLANETARY_KP_1M_URL, { signal }),
    fetch(PLANETARY_KP_FORECAST_URL, { signal }),
  ]);
  let scalesJson = null;
  if (!scRes.ok) throw new Error(`noaa_scales_http_${scRes.status}`);
  scalesJson = await scRes.json();

  let kpRows = null;
  if (!kp1mRes.ok) {
    console.warn('[geomagnetic-merge] planar K 1m HTTP', kp1mRes.status);
  } else {
    kpRows = await kp1mRes.json();
    if (!Array.isArray(kpRows) || kpRows.length === 0) kpRows = null;
  }

  let kpForecastRows = null;
  if (!kpFcRes.ok) {
    console.warn('[geomagnetic-merge] planetary K forecast HTTP', kpFcRes.status);
  } else {
    kpForecastRows = await kpFcRes.json();
    if (!Array.isArray(kpForecastRows) || kpForecastRows.length === 0) kpForecastRows = null;
  }

  return { scales: scalesJson, kpRows, kpForecastRows };
}

/**
 * @param {unknown} scalesJson
 * @returns {{ g: number, text: string, dateStamp: string | null, timeStamp: string | null }}
 */
function readCurrentNoaaG(scalesJson) {
  const block =
    scalesJson &&
    typeof scalesJson === 'object' &&
    '0' in scalesJson &&
    typeof scalesJson['0'] === 'object'
      ? scalesJson['0']
      : null;
  const gBlock = block && typeof block.G === 'object' ? block.G : null;
  const g = parseNoaaGsScaleDigits(gBlock?.Scale);
  const txt = typeof gBlock?.Text === 'string' && gBlock.Text.trim() !== '' ? gBlock.Text.trim() : 'none';
  const ds = typeof block.DateStamp === 'string' ? block.DateStamp : null;
  const ts = typeof block.TimeStamp === 'string' ? block.TimeStamp : null;
  return { g, text: txt, dateStamp: ds, timeStamp: ts };
}

/**
 * Storm-relevant Kp: peak 3-hour planetary K on the NOAA G-scale day (or recent hero window),
 * falling back to peak 1-minute estimated Kp over the last 3 hours — never the lone latest
 * 1-minute sample when a better peak exists.
 *
 * @param {unknown[] | null} kpForecastRows
 * @param {unknown[] | null} kp1mRows
 * @param {string | null | undefined} stormDateStamp YYYY-MM-DD from noaa-scales when G≥2
 * @param {Date} now
 * @param {number} windowMs
 * @returns {{ kp: number | null, time_tag: string | null }}
 */
export function resolveStormKp(kpForecastRows, kp1mRows, stormDateStamp, now, windowMs) {
  /** @type {{ kp: number | null, time_tag: string | null }} */
  let best = { kp: null, time_tag: null };

  const consider = (kp, time_tag) => {
    if (typeof kp !== 'number' || !Number.isFinite(kp)) return;
    if (best.kp == null || kp > best.kp) {
      best = {
        kp,
        time_tag: typeof time_tag === 'string' && time_tag.trim() !== '' ? time_tag.trim() : null,
      };
    }
  };

  const t0 = now.getTime();
  const t1 = t0 + windowMs;
  const recentFloor = t0 - 24 * 60 * 60 * 1000;
  const day =
    typeof stormDateStamp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stormDateStamp.trim())
      ? stormDateStamp.trim()
      : null;

  if (Array.isArray(kpForecastRows)) {
    for (const row of kpForecastRows) {
      const kp = readKpNumber(row);
      if (kp == null) continue;
      const tag =
        row && typeof row === 'object' && typeof /** @type {{ time_tag?: unknown }} */ (row).time_tag === 'string'
          ? /** @type {{ time_tag: string }} */ (row).time_tag.trim()
          : '';
      const t = parseSwpcUtcMs(tag);
      if (Number.isNaN(t)) continue;

      const onStormDay = day != null && tag.startsWith(day);
      const inHeroOrRecent = t >= recentFloor && t < t1;
      if (onStormDay || inHeroOrRecent) consider(kp, tag);
    }
  }

  if (Array.isArray(kp1mRows)) {
    const cut = t0 - 3 * 60 * 60 * 1000;
    for (const row of kp1mRows) {
      if (!row || typeof row !== 'object') continue;
      const kp = readKpNumber(row);
      if (kp == null) continue;
      const tag =
        typeof /** @type {{ time_tag?: unknown }} */ (row).time_tag === 'string'
          ? /** @type {{ time_tag: string }} */ (row).time_tag.trim()
          : '';
      const t = parseSwpcUtcMs(tag);
      if (!Number.isNaN(t) && t < cut) continue;
      consider(kp, tag || null);
    }
  }

  return best;
}

/**
 * Latest 1-minute estimated Kp (live reading for calm / settings snapshot).
 * @param {unknown[] | null} kp1mRows
 * @returns {{ kp: number | null, time_tag: string | null }}
 */
function latestEstimatedKp1m(kp1mRows) {
  if (!Array.isArray(kp1mRows) || kp1mRows.length === 0) return { kp: null, time_tag: null };
  const last = kp1mRows[kp1mRows.length - 1];
  const kp = readKpNumber(last);
  const time_tag =
    last &&
    typeof last === 'object' &&
    typeof /** @type {{ time_tag?: unknown }} */ (last).time_tag === 'string' &&
    /** @type {{ time_tag: string }} */ (last).time_tag.trim() !== ''
      ? /** @type {{ time_tag: string }} */ (last).time_tag.trim()
      : null;
  return { kp: kp != null && Number.isFinite(kp) ? kp : null, time_tag };
}

/**
 * Kp to show next to a G-scale label. Suppress calm values when scales already report G2+
 * so we never render “G2 · Kp 0.00”.
 * @param {number | null} kp
 * @param {boolean} gOk
 */
function kpForStormLabel(kp, gOk) {
  if (kp == null || !Number.isFinite(kp)) return null;
  if (gOk && kp < 1) return null;
  return kp;
}

function combineNoaaUtcStart(dateStamp, timeStamp, kpIso) {
  if (kpIso) {
    const ms = parseSwpcUtcMs(kpIso);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  if (dateStamp && timeStamp && /^\d{4}-\d{2}-\d{2}$/.test(dateStamp.trim())) {
    const t = timeStamp.trim();
    const guess = `${dateStamp.trim()}T${t}Z`;
    const d = new Date(guess);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** NOAA uses `YYYY-MM-DD` on each scale block; treat that UTC day as overlapping the hero window. */
function noaaDateStampOverlapsWindow(dateStamp, now, windowMs) {
  if (typeof dateStamp !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStamp.trim())) return false;
  const dayStart = new Date(`${dateStamp.trim()}T00:00:00.000Z`).getTime();
  if (Number.isNaN(dayStart)) return false;
  const dayEnd = dayStart + 86400000;
  const t0 = now.getTime();
  const t1 = t0 + windowMs;
  return dayStart < t1 && dayEnd > t0;
}

/** Strongest qualifying G≥2 among SWPC `"0"`…`"3"` blocks whose day overlaps `[now, now+windowMs]`. */
function pickStrongestNoaaGInHeroWindow(scalesJson, now, windowMs) {
  const keys = /** @type {const} */ (['0', '1', '2', '3']);
  /** @type {{ g: number, text: string, dateStamp: string | null, timeStamp: string | null }} */
  let best = { g: 0, text: 'none', dateStamp: null, timeStamp: null };

  for (const key of keys) {
    const block =
      scalesJson &&
      typeof scalesJson === 'object' &&
      key in scalesJson &&
      typeof scalesJson[key] === 'object'
        ? scalesJson[key]
        : null;
    const dsRaw = typeof block?.DateStamp === 'string' ? block.DateStamp : '';
    const ds = dsRaw.trim();
    if (!ds || !noaaDateStampOverlapsWindow(ds, now, windowMs)) continue;

    const g = parseNoaaGsScaleDigits(block?.G?.Scale);
    if (g < ACTIVE_G_MIN) continue;
    const txtRaw = typeof block?.G?.Text === 'string' ? block.G.Text.trim() : '';
    const txt = txtRaw !== '' ? txtRaw : 'none';
    const tsRaw = typeof block?.TimeStamp === 'string' ? block.TimeStamp.trim() : '';
    const ts = tsRaw !== '' ? tsRaw : '00:00:00';

    if (g > best.g) {
      best = {
        g,
        text: txt,
        dateStamp: ds,
        timeStamp: ts,
      };
    }
  }

  return best;
}

/** @param {Date} now
 * @param {number} windowMs */
function geomagneticStripDebugSynthetic(now, windowMs) {
  return {
    id: 'sky-debug-geomagnetic',
    type: 'geomagnetic',
    title: 'Geomagnetic storm · DEBUG (forced row)',
    startsAt: now.toISOString(),
    endsAt: new Date(now.getTime() + windowMs).toISOString(),
    peakAt: null,
    detailLine:
      'DEBUG: unset SKY_DEBUG_GEOMAGNETIC_ACTIVE. Normal visibility: NOAA G≥2 on overlapping days (blocks 0–3) / planar estimated Kp ≥ G2-tier (see README).',
    source: 'Forced by SKY_DEBUG_GEOMAGNETIC_ACTIVE in .env (testing only).',
    forecastUrl: 'https://www.swpc.noaa.gov/products/noaa-scales',
  };
}

/**
 * Drops calendar `geomagnetic` rows when live merge runs. Inserts one row when NOAA **G≥2**
 * appears on any overlapping calendar day (`"0"`–`"3"` in `noaa-scales.json`) **or** planar Kp reaches the G2 tier.
 *
 * @param {unknown[]} events Already time-filtered calendar events
 * @param {Date} now
 * @param {number} windowMs Hero sky window length
 */
export async function mergeGeomagneticStormGScale(events, now, windowMs) {
  const list = Array.isArray(events) ? events : [];
  const withoutGeom = list.filter((e) => e && e.type !== 'geomagnetic');

  if (isSkyDebugGeomagneticActive()) {
    const merged = [geomagneticStripDebugSynthetic(now, windowMs), ...withoutGeom];
    merged.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    return merged;
  }

  let scales;
  let kpRows;
  let kpForecastRows;
  try {
    ({ scales, kpRows, kpForecastRows } = await fetchNoaaGAndKpRows());
  } catch (err) {
    console.warn('[geomagnetic-merge] NOAA scales/Kp fetch failed:', err?.message || err);
    return withoutGeom;
  }

  const pick = pickStrongestNoaaGInHeroWindow(scales, now, windowMs);
  const zero = readCurrentNoaaG(scales);
  const gOk = pick.g >= ACTIVE_G_MIN;
  const { kp: peakKp, time_tag: kpTag } = resolveStormKp(
    kpForecastRows,
    kpRows,
    gOk ? pick.dateStamp : null,
    now,
    windowMs,
  );
  const kpOk = peakKp != null && peakKp >= KP_NUMERIC_G2_FLOOR;
  if (!gOk && !kpOk) return withoutGeom;

  const kp = kpForStormLabel(peakKp, gOk);
  const kpStr = formatKp(kp ?? NaN);

  const noaaTxtForMerge = pick.text;
  const gScaleNum = gOk ? pick.g : inferredGFromPlanetaryKp(peakKp);
  const category =
    gScaleNum != null ? geomagneticCategoryWord(gOk ? noaaTxtForMerge : '', gScaleNum) : 'Elevated';

  /** G level, then Kp (when present), then NOAA category word (e.g. Moderate). */
  const lineParts = [];
  if (gScaleNum != null) lineParts.push(`G${gScaleNum}`);
  if (kp != null) lineParts.push(`Kp ${kpStr}`);
  if (gScaleNum != null) lineParts.push(category);

  const detailLine = lineParts.length > 0 ? lineParts.join(' · ') : 'Active';
  const titleLabel =
    lineParts.length > 0 ? `Geomagnetic storm · ${lineParts.join(' · ')}` : 'Geomagnetic storm';

  const dateStamp = gOk ? pick.dateStamp : zero.dateStamp;
  const timeStamp = gOk ? pick.timeStamp : zero.timeStamp;
  const tStart = combineNoaaUtcStart(dateStamp, timeStamp, kpTag ?? null) ?? now.toISOString();
  const tEnd = new Date(now.getTime() + windowMs).toISOString();

  const synthetic = {
    id: 'swpc-geomagnetic-g2plus',
    type: 'geomagnetic',
    title: titleLabel,
    startsAt: tStart,
    endsAt: tEnd,
    peakAt: null,
    detailLine,
    source:
      'NOAA SWPC noaa-scales.json (G on overlapping days via blocks 0–3) + planetary K peak from noaa-planetary-k-index-forecast.json (1m estimated as fallback).',
    forecastUrl: 'https://www.swpc.noaa.gov/products/noaa-scales',
  };

  const merged = [synthetic, ...withoutGeom];
  merged.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return merged;
}

/**
 * NOAA geomagnetic storm active (G≥2 on overlapping day or Kp at G2 tier). Shared by sky strip + geoelectric panel.
 *
 * @param {Date} [now]
 * @param {number} [windowMs]
 * @returns {Promise<{ active: boolean, g?: number, kp?: number | null, category?: string, label?: string, debug?: boolean, error?: string }>}
 */
export async function assessGeomagneticStormActivity(
  now = new Date(),
  windowMs = 24 * 60 * 60 * 1000,
) {
  try {
    const { scales, kpRows, kpForecastRows } = await fetchNoaaGAndKpRows();
    const pick = pickStrongestNoaaGInHeroWindow(scales, now, windowMs);
    const zero = readCurrentNoaaG(scales);
    const gOk = pick.g >= ACTIVE_G_MIN;
    const { kp: peakKp } = resolveStormKp(
      kpForecastRows,
      kpRows,
      gOk ? pick.dateStamp : null,
      now,
      windowMs,
    );
    const { kp: liveKp } = latestEstimatedKp1m(kpRows);
    const kpOk = peakKp != null && peakKp >= KP_NUMERIC_G2_FLOOR;
    const meetsG2Threshold = gOk || kpOk;
    const gNum = meetsG2Threshold
      ? gOk
        ? pick.g
        : (inferredGFromPlanetaryKp(peakKp) ?? pick.g)
      : zero.g;
    const category = geomagneticCategoryWord(
      meetsG2Threshold ? (gOk ? pick.text : '') : zero.text,
      gNum,
    );
    // Storm label uses peak K on the G-scale day; calm/settings uses live 1-minute Kp.
    const kp = meetsG2Threshold ? kpForStormLabel(peakKp, gOk) : liveKp;
    const lineParts = [];
    if (gNum != null) lineParts.push(`G${gNum}`);
    if (kp != null) lineParts.push(`Kp ${formatKp(kp)}`);
    if (category) lineParts.push(category);
    return {
      active: meetsG2Threshold,
      meetsG2Threshold,
      g: gNum,
      kp,
      category,
      label: lineParts.join(' · '),
    };
  } catch (err) {
    return { active: false, error: String(err?.message || err) };
  }
}

/**
 * Live NOAA G/Kp reading for settings (always returned, even below strip threshold).
 * @param {Date} now
 * @param {number} windowMs
 */
export async function snapshotGeomagneticLive(now = new Date(), windowMs = 24 * 60 * 60 * 1000) {
  const a = await assessGeomagneticStormActivity(now, windowMs);
  if (a.error) {
    return {
      stripActive: false,
      value: `Unavailable (${a.error})`,
      dataSource:
        'NOAA SWPC noaa-scales.json + planetary K forecast/1m (fetch failed).',
    };
  }
  const parts = [];
  if (a.g != null) parts.push(`G${a.g}`);
  parts.push(`Kp ${a.kp != null ? formatKp(a.kp) : '—'}`);
  if (a.category) parts.push(a.category);
  return {
    stripActive: a.active,
    value: parts.join(' · '),
    dataSource:
      'NOAA SWPC noaa-scales.json (blocks 0–3) + peak planetary K from noaa-planetary-k-index-forecast.json (1m estimated fallback). Strip active when G≥2 on an overlapping UTC day or peak Kp ≥ G2 tier.',
  };
}
