/**
 * NOAA SWPC public JSON — Ovation aurora probability grid + planetary Kp.
 * Grid is geographic [longitude 0–360°E, latitude −90…90°, Aurora 0–100].
 * @see https://services.swpc.noaa.gov/json/ovation_aurora_latest.json
 * @see https://services.swpc.noaa.gov/json/planetary_k_index_1m.json
 *
 * Recommended source for a simple “likelihood” band: **NOAA SWPC** (same feeds).
 * Consumer sites rarely expose a stable JSON for GPS %; we map SWPC metrics to
 * Low / Medium / High / Very high for the hero strip.
 *
 * Oakland (94608) is far equatorward of the typical auroral oval; Ovation values
 * are usually ~0% with only extreme storms raising them. Clouds/moon not modeled.
 */

const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';

/** Geographic longitude in 0–360° (east), same convention as Ovation file. */
export function geographicLonToOvation360(lon) {
  let x = lon % 360;
  if (x < 0) x += 360;
  return x;
}

function clampLat(lat) {
  return Math.min(90, Math.max(-90, lat));
}

/** @param {number[][]} coordinates [lon, lat, aurora][] */
export function buildOvationLookupMap(coordinates) {
  const map = new Map();
  for (const row of coordinates) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const [lon, lat, aur] = row;
    if (
      typeof lon !== 'number' ||
      typeof lat !== 'number' ||
      typeof aur !== 'number' ||
      !Number.isFinite(aur)
    ) {
      continue;
    }
    map.set(`${lon}|${lat}`, aur);
  }
  return map;
}

function sampleBilinear(map, lon360, lat) {
  const latC = clampLat(lat);
  const lonC = geographicLonToOvation360(lon360);
  const lon0 = Math.floor(lonC) % 360;
  const lon1 = (lon0 + 1) % 360;
  const lat0 = Math.floor(latC);
  const lat1 = Math.min(90, lat0 + 1);
  const fx = lonC - lon0;
  const fy = latC - lat0;

  const v = (lo, la) => map.get(`${lo}|${la}`) ?? 0;

  const q00 = v(lon0, lat0);
  const q10 = v(lon1, lat0);
  const q01 = v(lon0, lat1);
  const q11 = v(lon1, lat1);
  const top = q00 * (1 - fx) + q10 * fx;
  const bot = q01 * (1 - fx) + q11 * fx;
  return top * (1 - fy) + bot * fy;
}

/**
 * @param {Date} now
 * @param {string} timeZone IANA zone (hero uses America/Los_Angeles)
 * @returns {Date}
 */
export function startOfZonedCalendarDay(now = new Date(), timeZone = 'America/Los_Angeles') {
  const ymd = now.toLocaleDateString('en-CA', { timeZone });
  const [y, m, d] = ymd.split('-').map(Number);
  const anchor = Date.UTC(y, m - 1, d, 12, 0, 0);
  for (let delta = -20 * 3600000; delta <= 20 * 3600000; delta += 900000) {
    const inst = new Date(anchor + delta);
    if (inst.toLocaleDateString('en-CA', { timeZone }) !== ymd) continue;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    }).formatToParts(inst);
    const hh = Number(parts.find((p) => p.type === 'hour').value);
    const mm = Number(parts.find((p) => p.type === 'minute').value);
    const ss = Number(parts.find((p) => p.type === 'second')?.value ?? 0);
    if (hh === 0 && mm === 0 && ss === 0) return inst;
  }
  return new Date(anchor);
}

/**
 * Last instant still inside the same local calendar day as `now` in `timeZone`.
 */
export function endOfZonedCalendarDay(now = new Date(), timeZone = 'America/Los_Angeles') {
  const sod = startOfZonedCalendarDay(now, timeZone);
  const sodMs = sod.getTime();
  for (let delta = 22 * 3600000; delta <= 27 * 3600000; delta += 60000) {
    const inst = new Date(sodMs + delta);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    }).formatToParts(inst);
    const hh = Number(parts.find((p) => p.type === 'hour').value);
    const mm = Number(parts.find((p) => p.type === 'minute').value);
    const ss = Number(parts.find((p) => p.type === 'second')?.value ?? 0);
    if (hh === 0 && mm === 0 && ss === 0 && inst.getTime() > sodMs + 20 * 3600000) {
      return new Date(inst.getTime() - 1000);
    }
  }
  return new Date(sodMs + 24 * 3600000 - 1000);
}

/**
 * Four-band “likelihood” from SWPC Ovation (local %) + planetary Kp, latitude-aware.
 * Sub-45°N needs stronger Kp before tiers rise (Oakland-class mid-latitudes).
 * @returns {{ tier: number, key: string, label: string }}
 */
export function computeAuroraLikelihood(ovationPct, kp, lat) {
  const absLat = Math.abs(typeof lat === 'number' && Number.isFinite(lat) ? lat : 0);
  const o = Math.min(100, Math.max(0, typeof ovationPct === 'number' ? ovationPct : 0));
  const k = typeof kp === 'number' && Number.isFinite(kp) ? kp : 0;

  let kpT = 0;
  if (absLat < 45) {
    if (k >= 8.5) kpT = 3;
    else if (k >= 7) kpT = 2;
    else if (k >= 5) kpT = 1;
    else kpT = 0;
  } else if (absLat < 58) {
    if (k >= 8) kpT = 3;
    else if (k >= 6) kpT = 2;
    else if (k >= 4) kpT = 1;
    else kpT = 0;
  } else {
    if (k >= 7) kpT = 3;
    else if (k >= 5) kpT = 2;
    else if (k >= 3) kpT = 1;
    else kpT = 0;
  }

  let ovT = 0;
  if (o >= 45) ovT = 3;
  else if (o >= 20) ovT = 2;
  else if (o >= 6) ovT = 1;
  else ovT = 0;

  const idx = Math.min(3, Math.max(kpT, ovT));
  const keys = ['low', 'medium', 'high', 'very_high'];
  const labels = ['Low', 'Medium', 'High', 'Very high'];
  return { tier: idx, key: keys[idx], label: labels[idx] };
}

export async function fetchOvationAndKp(options = {}) {
  const signal = options.signal ?? AbortSignal.timeout(14_000);
  const [ovRes, kpRes] = await Promise.all([
    fetch(OVATION_URL, { signal }),
    fetch(KP_URL, { signal }),
  ]);
  if (!ovRes.ok) throw new Error(`Ovation HTTP ${ovRes.status}`);
  if (!kpRes.ok) throw new Error(`Kp HTTP ${kpRes.status}`);
  const ovation = await ovRes.json();
  const kpRows = await kpRes.json();
  if (!Array.isArray(ovation.coordinates)) throw new Error('Ovation: missing coordinates');
  if (!Array.isArray(kpRows) || kpRows.length === 0) throw new Error('Kp: empty');

  const map = buildOvationLookupMap(ovation.coordinates);
  const lastKp = kpRows[kpRows.length - 1];
  const estimatedKp =
    typeof lastKp.estimated_kp === 'number' && Number.isFinite(lastKp.estimated_kp)
      ? lastKp.estimated_kp
      : Number(lastKp.kp_index ?? 0);

  return {
    ovationPct: sampleBilinear(map, options.lon, options.lat),
    observationTime: ovation['Observation Time'] ?? null,
    forecastTime: ovation['Forecast Time'] ?? null,
    kp: estimatedKp,
    kpTimeTag: lastKp.time_tag ?? null,
  };
}

/**
 * Replaces calendar `aurora` rows with one synthetic row for “today” in `timeZone`,
 * sampled at (lat, lon) — use hero / Open-Meteo coordinates (94608 defaults in `.env`).
 */
export async function mergeAuroraWithSwpc(
  events,
  lat,
  lon,
  now,
  windowMs,
  timeZone = 'America/Los_Angeles',
  locationLabel = 'Oakland, CA · 94608',
) {
  const list = Array.isArray(events) ? events : [];
  const without = list.filter((e) => e && e.type !== 'aurora');

  let snap;
  try {
    snap = await fetchOvationAndKp({ lat, lon });
  } catch (err) {
    console.warn('[sky-events] SWPC aurora/Kp fetch failed:', err?.message || err);
    return without;
  }

  const pct = Math.round(Math.min(100, Math.max(0, snap.ovationPct)));
  const kpStr =
    snap.kp >= 9 ? snap.kp.toFixed(0) : snap.kp >= 1 ? snap.kp.toFixed(1) : snap.kp.toFixed(2);

  const likelihood = computeAuroraLikelihood(snap.ovationPct, snap.kp, lat);
  /** Hero strip: omit aurora unless likelihood is Medium or higher (tier ≥ 1). */
  if (likelihood.tier < 1) {
    return without;
  }

  const dayStart = startOfZonedCalendarDay(now, timeZone);
  const dayEnd = endOfZonedCalendarDay(now, timeZone);

  const shortWhere = /\b94608\b/.test(locationLabel)
    ? '94608 / Oakland'
    : (locationLabel.split(',')[0] || 'Oakland').trim();

  const detailLine = `Likelihood: ${likelihood.label} · Kp ${kpStr} · Ovation ~${pct}%`;

  const synthetic = {
    id: 'swpc-aurora-oakland-today',
    type: 'aurora',
    title: `Aurora · ${shortWhere}`,
    startsAt: dayStart.toISOString(),
    endsAt: dayEnd.toISOString(),
    peakAt: snap.forecastTime || null,
    detailLine,
    auroraLikelihood: likelihood,
    source: `Bands from NOAA SWPC Ovation + planetary K at ${lat.toFixed(2)}°, ${lon.toFixed(2)}° (not clouds/moon). “Very high” is uncommon here; mid/high latitudes see aurora more often.`,
  };

  const merged = [synthetic, ...without];
  merged.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return merged;
}
