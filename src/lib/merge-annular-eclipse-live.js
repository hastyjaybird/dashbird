import { fetchNextLandAnnularWithinSixMonths } from './nasa-annular-eclipse-live.js';

/**
 * Prepends one row when NASA GSFC decade tables (fetched on each request) show a
 * land annular eclipse in the next ~6 months. No local JSON to maintain.
 *
 * @param {unknown[]} active
 * @param {Date} [now]
 * @returns {Promise<unknown[]>}
 */
export async function mergeAnnularEclipseLiveRows(active, now = new Date()) {
  const off = String(process.env.SKY_ANNULAR_ECLIPSE_NASA || '').trim() === '0';
  if (off) return Array.isArray(active) ? active : [];

  let best;
  try {
    best = await fetchNextLandAnnularWithinSixMonths(now);
  } catch (e) {
    console.warn('[sky-events] NASA annular fetch failed:', e?.message || e);
    return Array.isArray(active) ? active : [];
  }

  if (!best) return Array.isArray(active) ? active : [];

  const gMs = best.greatestMs;
  const startsAt = new Date(gMs - 3 * 60 * 60 * 1000).toISOString();
  const endsAt = new Date(gMs + 3 * 60 * 60 * 1000).toISOString();
  const peakAt = new Date(gMs).toISOString();
  const cityStr = best.topSpots.join(' · ');
  const detailLine = `Land annularity · Top spots: ${cityStr} · Live NASA GSFC decade table (TD clock as UTC for ordering; verify maps).`;

  const injected = {
    id: `annular-nasa-${gMs}`,
    type: 'annular_eclipse_world',
    title: best.title,
    startsAt,
    endsAt,
    peakAt,
    detailLine,
    forecastUrl: best.forecastUrl,
    source:
      'Annular row: parsed on each request from NASA GSFC solar eclipse decade pages (Fred Espenak); excludes Antarctica-only annular paths; see eclipse.gsfc.nasa.gov copyright.',
  };

  const rest = Array.isArray(active) ? active : [];
  return [injected, ...rest];
}
