import { buildFallFoliageSeasonStatus } from './fall-foliage-season.js';
import { buildFireflySeasonStatus } from './firefly-season.js';
import { resolveSecondaryWatchLocation } from './secondary-watch-location.js';

/**
 * Earth-strip items for secondary ZIP (fireflies + fall foliage).
 * @param {object} [p]
 * @param {Date} [p.now]
 * @param {string} [p.baseUrl] USA-NPN GeoServer base
 */
export async function buildSecondaryWatchEarthBundle(p = {}) {
  if (String(process.env.SECONDARY_WATCH || '').trim() === '0') {
    return { ok: true, disabled: true, zip: '', items: [], firefly: null, fallFoliage: null };
  }

  const loc = await resolveSecondaryWatchLocation();
  if (!loc) {
    return { ok: true, zip: '', items: [], geocodeError: true, firefly: null, fallFoliage: null };
  }

  const now = p.now instanceof Date ? p.now : new Date();
  const base = {
    lat: loc.lat,
    lon: loc.lon,
    timeZone: loc.timeZone,
    now,
    zip: loc.zip,
    baseUrl: p.baseUrl,
  };

  const [firefly, fallFoliage] = await Promise.all([
    Promise.resolve(buildFireflySeasonStatus(base)),
    buildFallFoliageSeasonStatus(base),
  ]);

  const items = [...(firefly.items || []), ...(fallFoliage.items || [])];

  return {
    ok: true,
    zip: loc.zip,
    place: loc.place,
    lat: loc.lat,
    lon: loc.lon,
    timeZone: loc.timeZone,
    items,
    firefly,
    fallFoliage,
  };
}
