/**
 * Salmon run “events” from static site list + seasonal month windows.
 * Filtered by haversine distance from dashboard coordinates (ZIP-derived or WEATHER_LAT/LON).
 */
import data from '../data/salmon-run-sites.json' with { type: 'json' };
import { haversineMiles } from './dashboard-geo.js';

/**
 * @typedef {{ siteName: string, distanceMi: number, runLabel: string, peakDescription: string, refUrl: string, inMonth: boolean }} SalmonRunEvent
 */

/**
 * @param {{ lat: number, lon: number, month: number, radiusMiles: number }} p
 * @param {{ includeInactive?: boolean }} [opts]
 * @returns {SalmonRunEvent[]}
 */
export function salmonRunEventsNear(p, opts = {}) {
  const lat = p.lat;
  const lon = p.lon;
  const month = p.month;
  const radiusMiles = p.radiusMiles;
  const includeInactive = Boolean(opts.includeInactive);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(month) || month < 1 || month > 12) {
    return [];
  }
  const rMax = Number.isFinite(radiusMiles) && radiusMiles > 0 ? radiusMiles : 50;

  const defaultRef = typeof data.defaultRefUrl === 'string' ? data.defaultRefUrl : '';

  /** @type {SalmonRunEvent[]} */
  const out = [];
  const sites = Array.isArray(data.sites) ? data.sites : [];

  for (const site of sites) {
    const slat = Number(site.lat);
    const slon = Number(site.lon);
    if (!Number.isFinite(slat) || !Number.isFinite(slon)) continue;
    const d = haversineMiles(lat, lon, slat, slon);
    if (d > rMax) continue;
    const siteName = String(site.name || 'River / estuary');

    const runs = Array.isArray(site.runs) ? site.runs : [];
    for (const run of runs) {
      const months = Array.isArray(run.activeMonths) ? run.activeMonths.map((m) => Number(m)) : [];
      const inMonth = months.includes(month);
      if (!inMonth && !includeInactive) continue;
      const runLabel = String(run.label || 'Salmon run').trim() || 'Salmon run';
      const basePeak = String(run.peakDescription || '').trim();
      const peakDescription = inMonth
        ? basePeak
        : `${basePeak} (not this calendar month; active months ${months.join(', ')})`.trim();
      const refUrl =
        typeof run.refUrl === 'string' && /^https?:\/\//i.test(run.refUrl.trim())
          ? run.refUrl.trim()
          : defaultRef;

      out.push({
        siteName,
        distanceMi: Math.round(d * 10) / 10,
        runLabel,
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
      a.runLabel.localeCompare(b.runLabel),
  );
  return out;
}
