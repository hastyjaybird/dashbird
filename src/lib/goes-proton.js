/**
 * NOAA SWPC primary GOES integral proton flux (JSON).
 * @see https://www.swpc.noaa.gov/products/goes-proton-flux
 * S-scale (solar radiation storms) uses ≥10 MeV integral flux; S1 begins at 10 pfu.
 */

const DEFAULT_URL =
  'https://services.swpc.noaa.gov/json/goes/primary/integral-protons-6-hour.json';

const ENERGY_10MEV = '>=10 MeV';

/** NOAA S1 / first warning tier: ≥10 pfu at ≥10 MeV (primary GOES). */
export const GOES_10MEV_WARNING_PFU = 10;

/**
 * @param {{ url?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ timeTag: string, flux: number, warning: boolean, thresholdPfu: number } | null>}
 */
export async function fetchLatestGoes10MeVProton(options = {}) {
  const url = options.url ?? DEFAULT_URL;
  const signal = options.signal ?? AbortSignal.timeout(12_000);
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`GOES proton HTTP ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const ten = rows.filter(
    (x) =>
      x &&
      x.energy === ENERGY_10MEV &&
      typeof x.flux === 'number' &&
      Number.isFinite(x.flux) &&
      typeof x.time_tag === 'string',
  );
  if (ten.length === 0) return null;

  ten.sort((a, b) => new Date(b.time_tag).getTime() - new Date(a.time_tag).getTime());
  const latestTag = ten[0].time_tag;
  const bucket = ten.filter((x) => x.time_tag === latestTag);
  const flux = Math.max(...bucket.map((x) => x.flux));
  return {
    timeTag: latestTag,
    flux,
    warning: flux >= GOES_10MEV_WARNING_PFU,
    thresholdPfu: GOES_10MEV_WARNING_PFU,
  };
}

/**
 * Drops calendar `geomagnetic` rows (manual Kp windows) and, when GOES ≥10 MeV
 * flux meets the S1 threshold, inserts one synthetic row so the hero shows the icon.
 *
 * @param {unknown[]} events Already time-filtered calendar events
 * @param {Date} now
 * @param {number} windowMs Hero sky window length
 */
export async function mergeGeomagneticWithGoes10Mev(events, now, windowMs) {
  const list = Array.isArray(events) ? events : [];
  const withoutGeom = list.filter((e) => e && e.type !== 'geomagnetic');

  let proton = null;
  try {
    proton = await fetchLatestGoes10MeVProton();
  } catch (err) {
    console.warn('[sky-events] GOES ≥10 MeV proton fetch failed:', err?.message || err);
    return withoutGeom;
  }

  if (!proton.warning) return withoutGeom;

  const fluxLabel = proton.flux >= 100 ? proton.flux.toFixed(0) : proton.flux.toFixed(1);
  const tEnd = new Date(now.getTime() + windowMs).toISOString();
  const synthetic = {
    id: 'swpc-goes-10mev-warning',
    type: 'geomagnetic',
    title: `GOES ≥10 MeV protons ${fluxLabel} pfu (≥${proton.thresholdPfu} = warning)`,
    startsAt: proton.timeTag,
    endsAt: tEnd,
    peakAt: null,
    source: `NOAA SWPC primary GOES integral flux, ${ENERGY_10MEV}; S1+ when ≥${proton.thresholdPfu} pfu. Last: ${proton.timeTag}`,
  };

  const merged = [synthetic, ...withoutGeom];
  merged.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return merged;
}
