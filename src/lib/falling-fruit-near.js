/**
 * Proximate Falling Fruit location summaries (crowdsourced map; not phenology).
 * Requires FALLING_FRUIT_API_KEY — see https://fallingfruit.org/data
 */
import { wildFoodTypeSubtitleFromLabel } from './wild-food-type-subtitle.js';

const FF_API = 'https://fallingfruit.org/api/0.3/locations';

/**
 * @typedef {{ distanceMi: number, earthType: 'wild_edible', label: string, detailLine: string, forecastUrl?: string }} FallingFruitRow
 */

/**
 * @param {{ lat: number, lon: number, apiKey: string, maxDistanceM?: number, limit?: number }} p
 * @returns {Promise<FallingFruitRow[]>}
 */
export async function fetchFallingFruitRowsNear(p) {
  const lat = p.lat;
  const lon = p.lon;
  const apiKey = String(p.apiKey || '').trim();
  if (!apiKey || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];

  const maxDistanceM =
    Number.isFinite(p.maxDistanceM) && p.maxDistanceM > 0 ? Math.min(p.maxDistanceM, 50_000) : 10_000;
  const limit = Number.isFinite(p.limit) && p.limit > 0 ? Math.min(100, Math.max(1, Math.floor(p.limit))) : 24;

  const u = new URL(FF_API);
  u.searchParams.append('center', String(lat));
  u.searchParams.append('center', String(lon));
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('api_key', apiKey);

  const ua = (process.env.FALLING_FRUIT_FETCH_UA || '').trim() || 'dashbird/1.0 (personal)';

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 18_000);
  try {
    const r = await fetch(u, {
      signal: ac.signal,
      headers: { Accept: 'application/json', 'User-Agent': ua },
    });
    if (!r.ok) return [];
    const arr = await r.json().catch(() => null);
    if (!Array.isArray(arr)) return [];

    /** @type {FallingFruitRow[]} */
    const out = [];
    for (const loc of arr) {
      const distM = Number(loc.distance);
      if (!Number.isFinite(distM) || distM > maxDistanceM) continue;
      const id = loc.id;
      const typeNames = Array.isArray(loc.type_names) ? loc.type_names.filter(Boolean).map(String) : [];
      const label = (typeNames[0] || 'Mapped edible').trim() || 'Mapped edible';
      const detailLine = wildFoodTypeSubtitleFromLabel(label);
      const mi = Math.round((distM / 1609.344) * 10) / 10;
      const forecastUrl =
        id != null && Number.isFinite(Number(id)) ? `https://fallingfruit.org/locations/${id}` : undefined;
      out.push({
        distanceMi: mi,
        earthType: 'wild_edible',
        label,
        detailLine,
        forecastUrl,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}
