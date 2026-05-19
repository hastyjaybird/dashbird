/**
 * Native / regional wild food phenology from static sites + calendar month windows.
 * Filtered by haversine distance from dashboard coordinates.
 */
import data from '../data/native-edible-plants.json' with { type: 'json' };
import { haversineMiles } from './dashboard-geo.js';

/**
 * @typedef {{ siteName: string, distanceMi: number, plantLabel: string, peakDescription: string, refUrl: string, inMonth: boolean }} NativeEdiblePlantEvent
 */

/**
 * @param {{ lat: number, lon: number, month: number, radiusMiles: number }} p
 * @param {{ includeInactive?: boolean }} [opts]
 * @returns {NativeEdiblePlantEvent[]}
 */
export function nativeEdiblePlantEventsNear(p, opts = {}) {
  const lat = p.lat;
  const lon = p.lon;
  const month = p.month;
  const radiusMiles = p.radiusMiles;
  const includeInactive = Boolean(opts.includeInactive);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(month) || month < 1 || month > 12) {
    return [];
  }
  const rMax = Number.isFinite(radiusMiles) && radiusMiles > 0 ? radiusMiles : 75;

  const defaultRef = typeof data.defaultRefUrl === 'string' ? data.defaultRefUrl : '';

  /** @type {NativeEdiblePlantEvent[]} */
  const out = [];
  const sites = Array.isArray(data.sites) ? data.sites : [];

  for (const site of sites) {
    const slat = Number(site.lat);
    const slon = Number(site.lon);
    if (!Number.isFinite(slat) || !Number.isFinite(slon)) continue;
    const d = haversineMiles(lat, lon, slat, slon);
    if (d > rMax) continue;
    const siteName = String(site.name || 'Region');

    const plants = Array.isArray(site.plants) ? site.plants : [];
    for (const plant of plants) {
      const months = Array.isArray(plant.activeMonths) ? plant.activeMonths.map((m) => Number(m)) : [];
      const inMonth = months.includes(month);
      if (!inMonth && !includeInactive) continue;
      const plantLabel = String(plant.label || 'Wild plant').trim() || 'Wild plant';
      const basePeak = String(plant.peakDescription || '').trim();
      const peakDescription = inMonth
        ? basePeak
        : `${basePeak} (not this calendar month; active months ${months.join(', ')})`.trim();
      const refUrl =
        typeof plant.refUrl === 'string' && /^https?:\/\//i.test(plant.refUrl.trim())
          ? plant.refUrl.trim()
          : defaultRef;

      out.push({
        siteName,
        distanceMi: Math.round(d * 10) / 10,
        plantLabel,
        peakDescription,
        refUrl,
        inMonth,
      });
    }
  }

  out.sort(
    (a, b) =>
      Number(b.inMonth) - Number(a.inMonth) ||
      a.distanceMi - b.distanceMi ||
      a.plantLabel.localeCompare(b.plantLabel),
  );
  return out;
}
